/**
 * signal.mts — The join mailbox for browser-to-browser multiplayer.
 *
 * Two browsers cannot find each other on their own: before a WebRTC data
 * channel opens (src/net/transport.js), each has to hand the other a short
 * description of how to reach it. This is where those wait. A host opens a
 * room under its join code and checks it every few seconds; a guest leaves
 * its offer there and waits for the host's answer. After that the game goes
 * straight between the two browsers, and nothing passes through here.
 *
 *   POST /api/signal  { op, room, peer, sdp }
 *     ping                          -> { ok }
 *     open    room                  -> { ok } or { ok: false, error: 'taken' }
 *     offer   room, peer, sdp       -> { ok } or { ok: false, error: 'noroom' }
 *     poll    room                  -> { ok, offers: [{ peer, sdp }] }  (also keeps the room open)
 *     answer  room, peer, sdp       -> { ok }
 *     await   room, peer            -> { ok, sdp | null }
 *     close   room                  -> { ok }
 *
 * scripts/host.mjs answers the same requests from memory, for local play.
 */

import { getDeployStore, getStore } from '@netlify/blobs';
import type { Config, Context } from '@netlify/functions';

/** A room whose host has not checked in for this long is gone. */
const ROOM_TTL = 90 * 1000;
/** Leftovers older than this are swept when a new room opens. */
const STALE = 6 * 60 * 60 * 1000;
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const PEER = /^[a-z0-9]{6,32}$/;
const MAX_SDP = 20000;

type Store = ReturnType<typeof getStore>;
type Body = { op?: string; room?: string; peer?: string; sdp?: string };

/**
 * Strongly consistent, since a guest reads what a host wrote a second ago.
 * Only the live site uses the site-wide store; previews keep theirs to the deploy.
 */
function mailbox(context: Context): Store {
  const options = { name: 'voxel-signal', consistency: 'strong' as const };
  return context.deploy?.context === 'production' ? getStore(options) : getDeployStore(options);
}

async function openRoom(store: Store, code: string, now: number) {
  const room = (await store.get(`room/${code}`, { type: 'json' })) as { seen: number } | null;
  return room && now - room.seen <= ROOM_TTL ? room : null;
}

/** Remove a room and everything waiting in it. */
async function clearRoom(store: Store, code: string) {
  await store.delete(`room/${code}`);
  for (const prefix of [`offer/${code}/`, `answer/${code}/`]) {
    const { blobs } = await store.list({ prefix });
    for (const { key } of blobs) await store.delete(key);
  }
}

/** Sweep a few rooms nobody closed (a host whose tab crashed). Bounded, so opening stays quick. */
async function sweep(store: Store, now: number) {
  const { blobs } = await store.list({ prefix: 'room/' });
  let checked = 0;
  for (const { key } of blobs) {
    if (checked++ >= 10) break;
    const room = (await store.get(key, { type: 'json' })) as { seen: number } | null;
    if (!room || now - room.seen > STALE) await clearRoom(store, key.slice('room/'.length));
  }
}

const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return reply({ ok: false, error: 'method' }, 405);
  const text = await req.text();
  if (text.length > 64 * 1024) return reply({ ok: false, error: 'size' }, 413);
  let body: Body;
  try {
    body = JSON.parse(text);
  } catch {
    return reply({ ok: false, error: 'bad' }, 400);
  }
  if (body.op === 'ping') return reply({ ok: true });

  const code = String(body.room ?? '');
  if (!CODE.test(code)) return reply({ ok: false, error: 'code' });
  const peer = String(body.peer ?? '');
  const sdp = typeof body.sdp === 'string' && body.sdp.length <= MAX_SDP && body.sdp.startsWith('v=0') ? body.sdp : null;
  const store = mailbox(context);
  const now = Date.now();

  switch (body.op) {
    case 'open': {
      if (await openRoom(store, code, now)) return reply({ ok: false, error: 'taken' });
      await clearRoom(store, code);
      await store.setJSON(`room/${code}`, { seen: now });
      await sweep(store, now);
      return reply({ ok: true });
    }
    case 'offer': {
      if (!(await openRoom(store, code, now))) return reply({ ok: false, error: 'noroom' });
      if (!PEER.test(peer) || !sdp) return reply({ ok: false, error: 'bad' });
      await store.set(`offer/${code}/${peer}`, sdp);
      return reply({ ok: true });
    }
    case 'poll': {
      if (!(await store.get(`room/${code}`))) return reply({ ok: false, error: 'noroom' });
      await store.setJSON(`room/${code}`, { seen: now });
      const { blobs } = await store.list({ prefix: `offer/${code}/` });
      const offers = [];
      for (const { key } of blobs) {
        const waiting = await store.get(key);
        await store.delete(key);
        if (waiting) offers.push({ peer: key.slice(key.lastIndexOf('/') + 1), sdp: waiting });
      }
      return reply({ ok: true, offers });
    }
    case 'answer': {
      if (!(await store.get(`room/${code}`))) return reply({ ok: false, error: 'noroom' });
      if (!PEER.test(peer) || !sdp) return reply({ ok: false, error: 'bad' });
      await store.set(`answer/${code}/${peer}`, sdp);
      return reply({ ok: true });
    }
    case 'await': {
      if (!(await openRoom(store, code, now))) return reply({ ok: false, error: 'noroom' });
      if (!PEER.test(peer)) return reply({ ok: false, error: 'bad' });
      const key = `answer/${code}/${peer}`;
      const answer = await store.get(key);
      if (answer) await store.delete(key);
      return reply({ ok: true, sdp: answer ?? null });
    }
    case 'close':
      await clearRoom(store, code);
      return reply({ ok: true });
  }
  return reply({ ok: false, error: 'op' });
};

export const config: Config = {
  path: '/api/signal',
};
