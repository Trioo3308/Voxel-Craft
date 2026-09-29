/**
 * transport.js — How players' games reach each other.
 *
 * Jev's pick for multiplayer (JEV_DECISIONS.md) was both of these:
 *
 *   Relay   A WebSocket to the machine serving the game (`npm run host`,
 *           scripts/host.mjs), which passes messages between the host and its
 *           guests. Same network only, but nothing to get through: if the page
 *           loaded, the relay works.
 *   Direct  WebRTC data channels between the browsers themselves, introduced
 *           through a small mailbox at /api/signal (a Netlify Function on the
 *           live site, netlify/functions/signal.mts; host.mjs answers it too).
 *           Works across the internet from most home networks. There is no
 *           TURN server to fall back on, so the strictest NATs cannot connect.
 *
 * Whichever carries it, the session gets the same thing: a link per player
 * with send(message) and callbacks. Messages are plain objects; this file
 * turns them into text and back.
 */

const SIGNAL_URL = '/api/signal';
const RELAY_PATH = '/mp';

/** Public STUN servers: they tell each browser its outside address, nothing more. */
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Join codes: six characters from a set nobody misreads (no 0/O or 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** What someone typed, as a code: case, dashes and spaces do not matter. */
export function normalizeCode(text) {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

export function isCode(code) {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/** "K7QZ4P" as "K7Q-Z4P", easier to read out. */
export function formatCode(code) {
  return code.length === CODE_LENGTH ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

// ---------------------------------------------------------------------------
// What this page's server can do
// ---------------------------------------------------------------------------

let capabilities = null;

/** `?mp=relay` or `?mp=direct` in the page's address uses only that way, for trying each. */
const FORCED = new URLSearchParams(location.search).get('mp');

/**
 * Which of the two ways the server that sent this page offers:
 * `{ relay: { lan: string[] } | null, direct: boolean }`. Asked once.
 */
export function probeTransports() {
  capabilities ??= Promise.all([
    FORCED === 'direct' ? null : probeRelay(),
    FORCED === 'relay' ? false : probeSignal(),
  ]).then(([relay, direct]) => ({ relay, direct }));
  return capabilities;
}

async function probeRelay() {
  try {
    const response = await fetch(`${RELAY_PATH}/info`, { cache: 'no-store' });
    if (!response.ok) return null;
    const info = await response.json();
    return info && info.relay ? { lan: Array.isArray(info.lan) ? info.lan : [] } : null;
  } catch {
    return null;
  }
}

async function probeSignal() {
  try {
    const reply = await signal({ op: 'ping' });
    return reply.ok === true;
  } catch {
    return false;
  }
}

async function signal(body) {
  const response = await fetch(SIGNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`The join service answered ${response.status}`);
  return response.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function socketUrl(path) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

/** An error carrying a short reason code the caller can branch on. */
function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Data channel framing
// ---------------------------------------------------------------------------

/** Marks a piece of a long message. JSON never starts with it. */
const PART = '\u0001';
/** Longest piece sent at once; every browser takes this in one message. */
const PIECE = 16000;
/** Hold messages back once this much is waiting to go out. */
const HIGH_WATER = 4 << 20;

/** Split text into pieces, never between the halves of a surrogate pair. */
function splitText(text, size) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/**
 * One WebRTC data channel as a message link. A save is far bigger than one
 * data channel message may be, so long messages go in numbered pieces.
 */
class ChannelLink {
  constructor(channel, connection, id = null) {
    this.id = id;
    this.via = 'direct';
    this.channel = channel;
    this.connection = connection;
    this.onMessage = null;
    this.onClose = null;
    this._queue = [];
    this._parts = new Map();
    this._nextPart = 1;
    this._closed = false;
    channel.bufferedAmountLowThreshold = 1 << 20;
    channel.onmessage = (event) => this._receive(event.data);
    channel.onbufferedamountlow = () => this._drain();
    channel.onclose = () => this._ended();
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') this._ended();
    });
  }

  send(message) {
    if (this._closed) return;
    const text = JSON.stringify(message);
    if (text.length <= PIECE) {
      this._queue.push(text);
    } else {
      const id = this._nextPart++;
      const pieces = splitText(text, PIECE);
      pieces.forEach((piece, i) => this._queue.push(`${PART}${id}|${i}|${pieces.length}|${piece}`));
    }
    this._drain();
  }

  _drain() {
    const channel = this.channel;
    while (this._queue.length > 0 && channel.readyState === 'open' && channel.bufferedAmount < HIGH_WATER) {
      channel.send(this._queue.shift());
    }
  }

  _receive(text) {
    if (typeof text !== 'string') return;
    if (text[0] !== PART) {
      this._deliver(text);
      return;
    }
    const a = text.indexOf('|');
    const b = text.indexOf('|', a + 1);
    const c = text.indexOf('|', b + 1);
    const id = text.slice(1, a);
    const index = Number(text.slice(a + 1, b));
    const count = Number(text.slice(b + 1, c));
    let entry = this._parts.get(id);
    if (!entry) this._parts.set(id, (entry = { got: 0, pieces: new Array(count) }));
    if (entry.pieces[index] === undefined) {
      entry.pieces[index] = text.slice(c + 1);
      entry.got++;
    }
    if (entry.got === count) {
      this._parts.delete(id);
      this._deliver(entry.pieces.join(''));
    }
  }

  _deliver(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (this.onMessage) this.onMessage(message);
  }

  _ended() {
    if (this._closed) return;
    this._closed = true;
    try { this.connection.close(); } catch { /* already gone */ }
    if (this.onClose) this.onClose();
  }

  close() {
    if (this._closed) return;
    try { this.channel.close(); } catch { /* already gone */ }
    this._ended();
  }
}

/**
 * Wait until the browser has found its addresses, or has what it needs. The
 * public one (from STUN) is what matters across the internet; once it is in,
 * a slow or unreachable second STUN server is not worth waiting out.
 */
function gatherCandidates(connection, timeout = 3000) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let soon = null;
    const check = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const found = (event) => {
      if (event.candidate?.type === 'srflx' && !soon) soon = setTimeout(finish, 250);
    };
    const finish = () => {
      connection.removeEventListener('icegatheringstatechange', check);
      connection.removeEventListener('icecandidate', found);
      clearTimeout(timer);
      clearTimeout(soon);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    connection.addEventListener('icegatheringstatechange', check);
    connection.addEventListener('icecandidate', found);
  });
}

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

/** Guests arriving through the page's own server. */
class RelayHost {
  constructor(code, hub) {
    this.code = code;
    this.hub = hub;
    this.peers = new Map();
    this.socket = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl(`${RELAY_PATH}?role=host&room=${this.code}`));
      this.socket = socket;
      let opened = false;
      socket.onmessage = (event) => {
        const text = String(event.data);
        const bar = text.indexOf('|');
        const from = text.slice(0, bar);
        const body = text.slice(bar + 1);
        if (from === 'sys') {
          const sys = JSON.parse(body);
          if (sys.sys === 'open') { opened = true; resolve(this); }
          else if (sys.sys === 'taken') reject(failure('That code is in use', 'taken'));
          else if (sys.sys === 'join') this._join(sys.peer);
          else if (sys.sys === 'leave') this._leave(sys.peer);
          return;
        }
        const peer = this.peers.get(`r${from}`);
        if (!peer) return;
        let message;
        try { message = JSON.parse(body); } catch { return; }
        this.hub.handlers.onMessage(peer, message);
      };
      socket.onerror = () => { if (!opened) reject(failure('The game server did not answer', 'relay')); };
      socket.onclose = () => {
        if (!opened) reject(failure('The game server did not answer', 'relay'));
        for (const id of [...this.peers.keys()]) this._leave(id.slice(1));
      };
    });
  }

  _join(n) {
    const id = `r${n}`;
    const socket = this.socket;
    const peer = {
      id,
      via: 'relay',
      send: (message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(`${n}|${JSON.stringify(message)}`);
      },
      close: () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(`sys|${JSON.stringify({ close: n })}`);
      },
    };
    this.peers.set(id, peer);
    this.hub.handlers.onJoin(peer);
  }

  _leave(n) {
    const id = `r${n}`;
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.hub.handlers.onLeave(peer);
  }

  close() {
    try { this.socket?.close(); } catch { /* already gone */ }
  }
}

/** Guests arriving over the internet, introduced by the mailbox. */
class DirectHost {
  constructor(code, hub) {
    this.code = code;
    this.hub = hub;
    this.links = new Set();
    this._open = false;
    this._nextId = 1;
    this._openedAt = 0;
  }

  async open() {
    const reply = await signal({ op: 'open', room: this.code });
    if (!reply.ok) throw failure('That code is in use', reply.error === 'taken' ? 'taken' : 'signal');
    this._open = true;
    this._openedAt = performance.now();
    this._poll();
    return this;
  }

  /**
   * Check the mailbox for guests knocking. Brisk for the first ten minutes
   * after opening or after someone joined, when people are most likely to be
   * arriving; slower after that, since every check is a function call.
   */
  async _poll() {
    while (this._open) {
      try {
        const reply = await signal({ op: 'poll', room: this.code });
        for (const offer of reply.offers ?? []) this._accept(offer);
      } catch {
        // A missed check is retried on the next one.
      }
      const recent = performance.now() - this._openedAt < 10 * 60 * 1000;
      await sleep(recent ? 2500 : 6000);
    }
  }

  async _accept({ peer: peerKey, sdp }) {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    connection.ondatachannel = (event) => {
      const channel = event.channel;
      const start = () => {
        const link = new ChannelLink(channel, connection, `d${this._nextId++}`);
        this.links.add(link);
        link.onMessage = (message) => this.hub.handlers.onMessage(link, message);
        link.onClose = () => {
          this.links.delete(link);
          this.hub.handlers.onLeave(link);
        };
        this._openedAt = performance.now();
        this.hub.handlers.onJoin(link);
      };
      if (channel.readyState === 'open') start();
      else channel.addEventListener('open', start, { once: true });
    };
    try {
      await connection.setRemoteDescription({ type: 'offer', sdp });
      await connection.setLocalDescription(await connection.createAnswer());
      await gatherCandidates(connection);
      await signal({ op: 'answer', room: this.code, peer: peerKey, sdp: connection.localDescription.sdp });
    } catch {
      connection.close();
      return;
    }
    // A guest who never gets through is not kept waiting on forever.
    setTimeout(() => {
      if (connection.connectionState !== 'connected') connection.close();
    }, 30000);
  }

  close() {
    this._open = false;
    signal({ op: 'close', room: this.code }).catch(() => {});
    for (const link of [...this.links]) link.close();
  }
}

/**
 * Everything a host listens on, under one code. Guests from both arrive
 * through the same three callbacks, as peers with an id, send() and close().
 */
export class HostHub {
  /** @param {{onJoin(peer), onMessage(peer, message), onLeave(peer)}} handlers */
  constructor(handlers) {
    this.handlers = handlers;
    this.code = null;
    this.relay = null;
    this.direct = null;
  }

  /** @returns {{code: string, relay: {lan: string[]}|null, direct: boolean}} */
  async open() {
    const caps = await probeTransports();
    if (!caps.relay && !caps.direct) throw failure('Multiplayer needs the game server or the live site', 'none');
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode();
      try {
        this.relay = caps.relay ? await new RelayHost(code, this).open() : null;
        this.direct = caps.direct ? await new DirectHost(code, this).open() : null;
        this.code = code;
        return { code, relay: caps.relay, direct: caps.direct };
      } catch (error) {
        this.close();
        if (error.code !== 'taken') throw error;
      }
    }
    throw failure('Could not find a free code; try again', 'taken');
  }

  close() {
    this.relay?.close();
    this.direct?.close();
    this.relay = null;
    this.direct = null;
  }
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

function joinRelay(code) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(`${RELAY_PATH}?role=guest&room=${code}`));
    let joined = false;
    const link = {
      via: 'relay',
      onMessage: null,
      onClose: null,
      send: (message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close: () => socket.close(),
    };
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.sys === 'joined') { joined = true; resolve(link); return; }
      if (message.sys === 'noroom') { reject(failure('No game with that code here', 'noroom')); return; }
      if (link.onMessage) link.onMessage(message);
    };
    socket.onerror = () => { if (!joined) reject(failure('The game server did not answer', 'relay')); };
    socket.onclose = () => {
      if (!joined) reject(failure('No game with that code here', 'noroom'));
      else if (link.onClose) link.onClose();
    };
  });
}

async function joinDirect(code, onStatus) {
  const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = connection.createDataChannel('game', { ordered: true });
  try {
    onStatus?.('Finding a route…');
    await connection.setLocalDescription(await connection.createOffer());
    await gatherCandidates(connection);

    const peer = makeCode().toLowerCase() + makeCode().toLowerCase();
    const sent = await signal({ op: 'offer', room: code, peer, sdp: connection.localDescription.sdp });
    if (!sent.ok) {
      throw failure(sent.error === 'noroom' ? 'No game with that code is open' : 'The join service turned us away', sent.error ?? 'signal');
    }

    onStatus?.('Knocking…');
    let answer = null;
    for (let tries = 0; tries < 45 && !answer; tries++) {
      await sleep(1000);
      const reply = await signal({ op: 'await', room: code, peer });
      if (reply.error === 'noroom') throw failure('The game closed', 'noroom');
      answer = reply.sdp ?? null;
    }
    if (!answer) throw failure('The host did not answer', 'timeout');
    await connection.setRemoteDescription({ type: 'answer', sdp: answer });

    onStatus?.('Connecting…');
    await new Promise((resolve, reject) => {
      if (channel.readyState === 'open') { resolve(); return; }
      const timer = setTimeout(() => reject(failure(
        'Could not connect. One of your networks blocks direct connections; try the same Wi-Fi with npm run host.', 'blocked'
      )), 20000);
      channel.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState !== 'failed') return;
        clearTimeout(timer);
        reject(failure('Could not connect. One of your networks blocks direct connections.', 'blocked'));
      });
    });
    return new ChannelLink(channel, connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}

/**
 * Reach the host of `code`: through this page's server if it has a relay (the
 * same network), otherwise directly. Resolves to a link with send(), close(),
 * onMessage and onClose.
 */
export async function connectToHost(code, onStatus) {
  const caps = await probeTransports();
  let lastError = null;
  if (caps.relay) {
    try {
      onStatus?.('Connecting…');
      return await joinRelay(code);
    } catch (error) {
      lastError = error;
    }
  }
  if (caps.direct) return joinDirect(code, onStatus);
  throw lastError ?? failure('Multiplayer needs the game server or the live site', 'none');
}
