/**
 * session.js — Multiplayer: one host, and the guests it lets in.
 *
 * Jev's pick for Phase 3 (JEV_DECISIONS.md) was building and presence. What
 * the players share:
 *   - every block change, in every dimension, with the host deciding the order;
 *   - chests, furnaces, signs and the other block entities, one player at a
 *     time in each (a lock, so two people cannot take the same diamonds);
 *   - each other: a figure with a name tag and whatever it holds (avatars.js);
 *   - chat, and the host's clock, weather and difficulty.
 * What stays each player's own: mobs, dropped items and survival. Every game
 * simulates its own creatures around itself. A guest's health, hunger and
 * inventory live in their game while they play, and in the host's save under
 * their name between visits, so they come back to where they left off.
 *
 * Terrain is a pure function of the seed, so a world never travels whole: a
 * guest is sent the seed and the list of edits (what a save holds), and
 * generates everything else itself. See world.applyRemoteEdits for how other
 * players' changes are applied without echoing back or waking the water.
 *
 * Wire format: JSON objects with a `t` field. Block changes travel as flat
 * arrays [x, y, z, id, ...] per dimension; poses as described in avatars.js.
 */

import { HostHub, connectToHost } from './transport.js';
import { Avatars, POSE_CROUCH, POSE_SWING, POSE_ENCHANTED } from './avatars.js';
import { encodeEdits, encodeEntity, decodeEntity, registryFingerprint } from './codec.js';
import { captureState, capturePlayerRecord } from '../world/save.js';
import { DIMENSIONS } from '../world/dimensions.js';
import { CHUNK_SY } from '../world/chunk.js';
import { MAX_CHAT_LENGTH } from '../ui/chat.js';
import Settings from '../settings.js';

/** Bumped whenever messages change shape; a guest on another version is turned away. */
export const PROTOCOL = 1;
/** The host's id in poses and player lists. */
export const HOST_ID = 'host';

/** Seconds between pose updates: ten a second, smoothed out by avatars.js. */
const POSE_INTERVAL = 0.1;
/** Seconds between clock and weather updates from the host. */
const CLOCK_INTERVAL = 5;
/** Seconds between a guest's reports of its own state, kept in the host's save. */
const STATE_INTERVAL = 20;
/** How long a guest waits to hear whether it may open a chest. */
const LOCK_TIMEOUT = 5000;
/** A guest's own edit the host never confirmed stops shadowing others' after this. */
const PENDING_TIMEOUT = 10000;
/** Largest player record a host keeps for a guest, as JSON. */
const MAX_RECORD = 256 * 1024;

/** What can be someone's name: letters, digits, spaces and a little punctuation. */
export function cleanName(text) {
  return String(text ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

/** A chat line with control characters removed, trimmed to length. */
function cleanChat(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHAT_LENGTH);
}

const round = (v, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/** Signed distance between two clock times on the 0..1 day, the short way round. */
const clockDelta = (a, b) => ((a - b + 1.5) % 1) - 0.5;

/** Checks a flat edit list from the wire, keeping only well-formed changes. */
function validEdits(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i + 3 < list.length; i += 4) {
    const [x, y, z, id] = [list[i], list[i + 1], list[i + 2], list[i + 3]];
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) continue;
    if (!Number.isInteger(id) || id < 0 || id > 255 || y < 0 || y >= CHUNK_SY) continue;
    out.push(x, y, z, id);
  }
  return out;
}

/** A brand-new guest: the world spawn, full health, empty pockets (starter items come after). */
function freshPlayer(spawn, creative) {
  return {
    x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0, pitch: 0,
    creative,
    spawn: spawn.toArray(),
    bed: null, lastDeath: null, waypoints: [], portals: [], deathLog: [], discovered: [],
    health: Settings.survival.maxHealth,
    hunger: Settings.survival.maxHunger,
    saturation: 5,
    style: 0,
    xp: 0,
    enchantSeed: (Math.random() * 0x7fffffff) | 0,
    knownRecipes: [],
  };
}

// ---------------------------------------------------------------------------

/** What hosting and joining have in common. */
class Session {
  constructor(game, name) {
    this.game = game;
    this.name = name;
    this.avatars = new Avatars(game.renderer.scene);
    /** Everyone else: id -> name. */
    this.names = new Map();
    /** This frame's block changes, dimension -> flat list, sent once a frame. */
    this._edits = new Map();
    /** Block entities this game changed, key -> whether it created them. */
    this._entities = new Map();
    this._poseTimer = 0;
    this._swung = false;
    this.closed = false;
  }

  /** The world reports a block this game changed; see World.onEdit. */
  localEdit(dimension, x, y, z, id) {
    let list = this._edits.get(dimension);
    if (!list) this._edits.set(dimension, (list = []));
    list.push(x, y, z, id);
  }

  /** The world reports a block entity this game created or changed. */
  localEntity(key, created) {
    this._entities.set(key, (this._entities.get(key) ?? false) || created);
  }

  /** This game's player, as a pose; see avatars.js. */
  _myPose() {
    const player = this.game.player;
    const held = player.inventory.getSelected();
    let flags = 0;
    if (player.crouching) flags |= POSE_CROUCH;
    if (this._swung) flags |= POSE_SWING;
    if (held?.ench) flags |= POSE_ENCHANTED;
    this._swung = false;
    return [
      round(player.position.x), round(player.position.y), round(player.position.z),
      round(player.yaw, 3), round(player.pitch, 3),
      this.game.world.dimension, held?.id ?? 0, flags,
    ];
  }

  /** Everyone in the game, this player first: [{ id, name }]. */
  players() {
    return [{ id: this.id, name: this.name, you: true }, ...[...this.names].map(([id, name]) => ({ id, name }))];
  }

  update(dt) {
    if (this.game.player.didSwing) this._swung = true;
    this.avatars.update(dt, this.game.world?.dimension);
  }
}

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

export class HostSession extends Session {
  constructor(game, name) {
    super(game, name);
    this.role = 'host';
    this.id = HOST_ID;
    /** peer id -> { peer, name (once welcomed), pose, backlog (while joining) } */
    this.guests = new Map();
    /** block entity key -> id of whoever has it open */
    this.locks = new Map();
    this.info = null;
    this._clockTimer = 0;
    this._lastTime = null;
    this.hub = new HostHub({
      onJoin: (peer) => this._onJoin(peer),
      onMessage: (peer, message) => this._onMessage(peer, message),
      onLeave: (peer) => this._onLeave(peer),
    });
  }

  /** Start listening. @returns {{code, relay, direct}} see HostHub.open */
  async open() {
    this.info = await this.hub.open();
    return this.info;
  }

  /** Guests in the world (not counting any still loading). */
  get guestCount() {
    let n = 0;
    for (const guest of this.guests.values()) if (guest.name && !guest.backlog) n++;
    return n;
  }

  /** With someone else in the world, pausing must not stop it for them. */
  get keepsRunning() {
    return this.guestCount > 0;
  }

  close(reason = 'The host closed the world') {
    if (this.closed) return;
    this.closed = true;
    for (const guest of this.guests.values()) {
      guest.peer.send({ t: 'kick', reason });
      guest.peer.close();
    }
    this.guests.clear();
    this.locks.clear();
    this.names.clear();
    this.hub.close();
    this.avatars.clear();
  }

  // --- The host's own game ------------------------------------------------

  /** Open a shared block entity. Immediate: the host keeps the locks. */
  lock(key) {
    const holder = this.locks.get(key);
    if (holder && holder !== HOST_ID) return Promise.resolve({ ok: false, holder: this.names.get(holder) ?? 'Someone' });
    this.locks.set(key, HOST_ID);
    return Promise.resolve({ ok: true });
  }

  /** Done with it. Its new contents go out with this frame's changes. */
  unlock(key) {
    if (this.locks.get(key) === HOST_ID) this.locks.delete(key);
  }

  say(text) {
    text = cleanChat(text);
    if (!text) return;
    this.game.chat.add(text, { from: this.name });
    this._broadcast({ t: 'chat', from: this.name, text });
  }

  /** The host saves its own world; this is only here so callers need not ask which role. */
  sendState() {}

  update(dt) {
    super.update(dt);
    const world = this.game.world;
    if (!world || this.closed) return;

    for (const [d, l] of this._edits) this._broadcast({ t: 'edits', d, l, from: HOST_ID });
    this._edits.clear();

    for (const [k, created] of this._entities) {
      if (this.locks.has(k) && this.locks.get(k) !== HOST_ID) continue;
      this._broadcast({ t: 'be', k, e: encodeEntity(world.blockEntities.get(k)), c: created || undefined });
    }
    this._entities.clear();

    this._poseTimer -= dt;
    if (this._poseTimer <= 0) {
      this._poseTimer = POSE_INTERVAL;
      if (this.guests.size > 0) {
        const list = [[HOST_ID, ...this._myPose()]];
        for (const [id, guest] of this.guests) if (guest.name && guest.pose) list.push([id, ...guest.pose]);
        this._broadcast({ t: 'poses', list });
      }
    }

    // The clock every few seconds, and at once when it jumps (a bed).
    const time = this.game.sky.time;
    const jumped = this._lastTime !== null && Math.abs(clockDelta(time, this._lastTime)) > 0.005;
    this._lastTime = time;
    this._clockTimer -= dt;
    if (this._clockTimer <= 0 || jumped) {
      this._clockTimer = CLOCK_INTERVAL;
      this._broadcast(this._clock());
    }
  }

  _clock() {
    const game = this.game;
    return { t: 'clock', time: game.sky.time, day: game.sky.dayCount, weather: game.weather.serialize(), difficulty: game.difficultyId };
  }

  /**
   * Send to every guest in the world, except one. Guests still loading get
   * it afterwards, in order, after their copy of the world.
   */
  _broadcast(message, except = null) {
    for (const [id, guest] of this.guests) {
      if (id === except || !guest.name) continue;
      if (guest.backlog) guest.backlog.push(message);
      else guest.peer.send(message);
    }
  }

  /** A line everyone sees in the chat, the host included (and one guest, perhaps, not). */
  _notice(text, except = null) {
    this.game.chat.add(text, { kind: 'sys' });
    this._broadcast({ t: 'sys', text }, except);
  }

  // --- Guests ---------------------------------------------------------------

  _onJoin(peer) {
    this.guests.set(peer.id, { peer, name: null, pose: null, backlog: null });
    // Someone who connects and never says who they are is let go.
    setTimeout(() => {
      const guest = this.guests.get(peer.id);
      if (guest && !guest.name) peer.close();
    }, 20000);
  }

  _onLeave(peer) {
    const guest = this.guests.get(peer.id);
    if (!guest) return;
    this.guests.delete(peer.id);
    for (const [key, holder] of this.locks) if (holder === peer.id) this.locks.delete(key);
    // Gone before they finished arriving: nobody was told they came.
    if (!guest.name || guest.backlog) return;
    this.names.delete(peer.id);
    this.avatars.remove(peer.id);
    this._broadcast({ t: 'leave', id: peer.id });
    this._notice(`${guest.name} left the game`);
    this.game.onNetPlayersChanged?.();
  }

  _onMessage(peer, message) {
    const guest = this.guests.get(peer.id);
    if (!guest || !message || typeof message.t !== 'string') return;
    if (!guest.name) {
      if (message.t === 'hello' && !guest.joining) this._hello(guest, message);
      return;
    }
    switch (message.t) {
      case 'pose':
        if (Array.isArray(message.p) && message.p.length === 8) {
          guest.pose = message.p;
          this.avatars.setPose(peer.id, message.p);
        }
        break;
      case 'edits': this._guestEdits(guest, message); break;
      case 'be': this._guestEntity(guest, message); break;
      case 'lock': this._guestLock(guest, message); break;
      case 'unlock': this._guestUnlock(guest, message); break;
      case 'chat': this._guestChat(guest, message); break;
      case 'state': this._guestState(guest, message); break;
      case 'bye':
        this._guestState(guest, message);
        peer.close();
        break;
    }
  }

  async _hello(guest, message) {
    const peer = guest.peer;
    const deny = (reason) => {
      peer.send({ t: 'deny', reason });
      setTimeout(() => peer.close(), 1000);
    };
    const name = cleanName(message.name);
    if (message.v !== PROTOCOL || message.fp !== registryFingerprint()) {
      deny('That game is running a different version. Refresh the page (Ctrl+F5) on both sides and try again.');
      return;
    }
    if (!name) { deny('Pick a name first.'); return; }
    const lower = name.toLowerCase();
    const taken = lower === this.name.toLowerCase() ||
      [...this.guests.values()].some((g) => g !== guest && g.name && g.name.toLowerCase() === lower);
    if (taken) { deny(`Someone called ${name} is already playing.`); return; }
    if (!this.game.world || this.game.remoteWorld) { deny('The host is not in a world right now.'); return; }

    // Anything that happens while the copy is made is kept for them, and
    // sent once the copy has gone, so nothing falls between the two.
    guest.joining = true;
    guest.name = name;
    guest.backlog = [];
    let welcome;
    try {
      welcome = await this._welcome(peer.id, name);
    } catch (error) {
      console.error('[net] could not snapshot the world', error);
      guest.name = null;
      deny('The host could not send the world.');
      return;
    }
    if (!this.guests.has(peer.id) || this.closed) return;

    peer.send(welcome);
    for (const queued of guest.backlog) peer.send(queued);
    guest.backlog = null;
    this.names.set(peer.id, name);
    this.avatars.add(peer.id, name);
    this._broadcast({ t: 'join', id: peer.id, name }, peer.id);
    this._notice(`${name} joined the game`, peer.id);
    this.game.onNetPlayersChanged?.();
  }

  /**
   * The world as a save, with the guest's own things in place of the host's:
   * where they were, what they carried, what they had done.
   */
  async _welcome(id, name) {
    const game = this.game;
    const save = await captureState(game, {
      ...game.saveMeta, playTimeSeconds: game._playTime, thumbnail: null,
    });
    const record = game.guestRecords[name];
    const fresh = !record?.player || !record?.inventory;
    if (fresh) {
      save.player = freshPlayer(game.player.spawnPoint, save.allowCreative === true);
      save.inventory = {
        selected: 0,
        slots: new Array(game.player.inventory.slots.length).fill(null),
        armor: new Array(game.player.inventory.armor.length).fill(null),
      };
      save.achievements = [];
      save.stats = {};
      save.dimension = DIMENSIONS.OVERWORLD;
    } else {
      save.player = record.player;
      save.inventory = record.inventory;
      save.achievements = record.achievements ?? [];
      save.stats = record.stats ?? {};
      save.dimension = record.dimension ?? DIMENSIONS.OVERWORLD;
    }
    // Other guests' belongings stay with the host.
    delete save.guests;
    save.edits = encodeEdits(save.edits);

    const players = [{ id: HOST_ID, name: this.name, pose: this._myPose() }];
    for (const [otherId, other] of this.guests) {
      if (otherId !== id && other.name && !other.backlog) players.push({ id: otherId, name: other.name, pose: other.pose });
    }
    return { t: 'welcome', you: id, host: this.name, world: game.worldName, fresh, save, players };
  }

  _guestEdits(guest, message) {
    if (typeof message.d !== 'string') return;
    const list = validEdits(message.l);
    if (list.length === 0) return;
    this.game.world.applyRemoteEdits(message.d, list);
    // Back to everyone, sender included: the echo is what puts every game's
    // copy in the order the host applied them. See GuestSession._remoteEdits.
    this._broadcast({ t: 'edits', d: message.d, l: list, from: guest.peer.id, seq: message.seq });
  }

  _guestEntity(guest, message) {
    const key = message.k;
    if (typeof key !== 'string') return;
    const world = this.game.world;
    // Stocking a structure's chest only counts if nobody got there first.
    if (message.c && world.blockEntities.has(key)) {
      guest.peer.send({ t: 'be', k: key, e: encodeEntity(world.blockEntities.get(key)) });
      return;
    }
    const holder = this.locks.get(key);
    if (holder && holder !== guest.peer.id) return;
    world.applyRemoteEntity(key, decodeEntity(message.e));
    this._broadcast({ t: 'be', k: key, e: message.e ?? null }, guest.peer.id);
    this.game.onRemoteEntity?.(key);
  }

  _guestLock(guest, message) {
    const key = message.k;
    if (typeof key !== 'string') return;
    const holder = this.locks.get(key);
    if (holder && holder !== guest.peer.id) {
      const name = holder === HOST_ID ? this.name : this.guests.get(holder)?.name;
      guest.peer.send({ t: 'lock', k: key, ok: false, holder: name ?? 'Someone' });
      return;
    }
    const world = this.game.world;
    let entity = world.blockEntities.get(key);
    if (!entity && message.init) {
      entity = decodeEntity(message.init);
      if (entity) world.applyRemoteEntity(key, entity);
    }
    this.locks.set(key, guest.peer.id);
    guest.peer.send({ t: 'lock', k: key, ok: true, e: encodeEntity(entity) });
  }

  _guestUnlock(guest, message) {
    const key = message.k;
    if (this.locks.get(key) !== guest.peer.id) return;
    this.locks.delete(key);
    if (!('e' in message)) return;
    this.game.world.applyRemoteEntity(key, decodeEntity(message.e));
    this._broadcast({ t: 'be', k: key, e: message.e ?? null }, guest.peer.id);
    this.game.onRemoteEntity?.(key);
  }

  _guestChat(guest, message) {
    const text = cleanChat(message.text);
    if (!text) return;
    this.game.chat.add(text, { from: guest.name });
    this._broadcast({ t: 'chat', from: guest.name, text }, guest.peer.id);
  }

  /** A guest's own things, filed under their name in this world's save. */
  _guestState(guest, message) {
    const record = message.rec;
    if (!record || typeof record !== 'object' || !record.player || !record.inventory) return;
    if (JSON.stringify(record).length > MAX_RECORD) return;
    this.game.guestRecords[guest.name] = { ...record, updatedAt: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export class GuestSession extends Session {
  constructor(game, name) {
    super(game, name);
    this.role = 'guest';
    this.id = null;
    this.hostName = null;
    this.link = null;
    /** False until the world from the welcome is loaded; messages wait till then. */
    this.ready = false;
    this._backlog = [];
    /** Keys of block entities this guest has open. */
    this._held = new Set();
    this._lockWaiters = new Map();
    /** Own edits the host has not confirmed yet: "dim:x,y,z" -> { seq, at } */
    this._pending = new Map();
    this._seq = 0;
    this._stateTimer = STATE_INTERVAL;
    this._welcomeWaiter = null;
    this._closeReason = null;
  }

  get keepsRunning() {
    return false;
  }

  /**
   * Reach the host and ask to join.
   * @param {(text: string) => void} [onStatus] progress, for the join form
   * @returns {Promise<object>} the welcome: the world as a save, and who is in it
   */
  async connect(code, onStatus) {
    this.link = await connectToHost(code, onStatus);
    this.link.onMessage = (message) => this._onMessage(message);
    this.link.onClose = () => this._onClose();
    onStatus?.('Asking to join…');
    return new Promise((resolve, reject) => {
      this._welcomeWaiter = { resolve, reject };
      this.link.send({ t: 'hello', name: this.name, v: PROTOCOL, fp: registryFingerprint() });
      // A big world takes a while to come down a slow line; a minute and a half is plenty.
      setTimeout(() => {
        if (!this._welcomeWaiter) return;
        this._welcomeWaiter = null;
        reject(new Error('The host did not answer'));
        this.link.close();
      }, 90000);
    });
  }

  /** Called once the world from the welcome has loaded: catch up, and meet everyone. */
  begin(welcome) {
    for (const player of welcome.players ?? []) {
      this.names.set(player.id, player.name);
      this.avatars.add(player.id, player.name);
      if (player.pose) this.avatars.setPose(player.id, player.pose);
    }
    this.ready = true;
    const backlog = this._backlog;
    this._backlog = [];
    for (const message of backlog) this._handle(message);
  }

  lock(key, init) {
    if (this.closed) return Promise.resolve({ ok: false, holder: null });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._lockWaiters.delete(key);
        resolve({ ok: false, holder: null });
      }, LOCK_TIMEOUT);
      this._lockWaiters.set(key, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.link.send({ t: 'lock', k: key, init: encodeEntity(init) });
    });
  }

  /** Close a shared block entity, handing its contents back to the host. */
  unlock(key) {
    if (!this._held.has(key)) return;
    this._held.delete(key);
    this._entities.delete(key);
    this.link.send({ t: 'unlock', k: key, e: encodeEntity(this.game.world.blockEntities.get(key)) });
  }

  say(text) {
    text = cleanChat(text);
    if (!text) return;
    this.game.chat.add(text, { from: this.name });
    this.link.send({ t: 'chat', text });
  }

  /** Report this player's own things to the host, which keeps them under their name. */
  sendState(final = false) {
    if (!this.ready || this.closed || !this.game.world) return;
    this.link.send({ t: final ? 'bye' : 'state', rec: capturePlayerRecord(this.game) });
  }

  /** Leave on purpose: say goodbye with everything to keep, then hang up. */
  leave() {
    if (this.closed) return;
    this.sendState(true);
    this.closed = true;
    this.avatars.clear();
    // The goodbye has to get out before the line goes down.
    const link = this.link;
    setTimeout(() => link?.close(), 400);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.avatars.clear();
    this.link?.close();
  }

  update(dt) {
    super.update(dt);
    if (!this.ready || this.closed || !this.game.world) return;
    const world = this.game.world;

    const now = performance.now();
    for (const [d, l] of this._edits) {
      const seq = ++this._seq;
      for (let i = 0; i < l.length; i += 4) this._pending.set(`${d}:${l[i]},${l[i + 1]},${l[i + 2]}`, { seq, at: now });
      this.link.send({ t: 'edits', d, l, seq });
    }
    this._edits.clear();
    for (const [key, pending] of this._pending) {
      if (now - pending.at > PENDING_TIMEOUT) this._pending.delete(key);
    }

    for (const [k, created] of this._entities) {
      if (this._held.has(k)) continue; // goes back whole when it is closed
      this.link.send({ t: 'be', k, e: encodeEntity(world.blockEntities.get(k)), c: created || undefined });
    }
    this._entities.clear();

    this._poseTimer -= dt;
    if (this._poseTimer <= 0) {
      this._poseTimer = POSE_INTERVAL;
      this.link.send({ t: 'pose', p: this._myPose() });
    }

    this._stateTimer -= dt;
    if (this._stateTimer <= 0) {
      this._stateTimer = STATE_INTERVAL;
      this.sendState();
    }
  }

  _onMessage(message) {
    if (!message || typeof message.t !== 'string') return;
    switch (message.t) {
      case 'welcome': {
        this.id = message.you;
        this.hostName = message.host;
        const waiter = this._welcomeWaiter;
        this._welcomeWaiter = null;
        waiter?.resolve(message);
        return;
      }
      case 'deny': {
        const waiter = this._welcomeWaiter;
        this._welcomeWaiter = null;
        this._closeReason = message.reason;
        waiter?.reject(new Error(message.reason ?? 'The host said no'));
        this.link.close();
        return;
      }
      case 'kick':
        this._closeReason = message.reason ?? 'The host closed the world';
        this.link.close();
        return;
    }
    if (!this.ready) {
      this._backlog.push(message);
      return;
    }
    this._handle(message);
  }

  _handle(message) {
    const game = this.game;
    const world = game.world;
    if (!world) return;
    switch (message.t) {
      case 'poses':
        for (const entry of message.list ?? []) {
          if (!Array.isArray(entry) || entry[0] === this.id) continue;
          this.avatars.setPose(entry[0], entry.slice(1));
        }
        break;
      case 'edits':
        this._remoteEdits(message);
        break;
      case 'be':
        if (typeof message.k !== 'string' || this._held.has(message.k)) break;
        world.applyRemoteEntity(message.k, decodeEntity(message.e));
        game.onRemoteEntity?.(message.k);
        break;
      case 'lock': {
        const waiter = this._lockWaiters.get(message.k);
        if (!waiter) break;
        this._lockWaiters.delete(message.k);
        if (message.ok) {
          this._held.add(message.k);
          world.applyRemoteEntity(message.k, decodeEntity(message.e));
        }
        waiter({ ok: message.ok === true, holder: message.holder ?? null });
        break;
      }
      case 'join':
        this.names.set(message.id, String(message.name ?? '?'));
        this.avatars.add(message.id, String(message.name ?? '?'));
        game.onNetPlayersChanged?.();
        break;
      case 'leave':
        this.names.delete(message.id);
        this.avatars.remove(message.id);
        game.onNetPlayersChanged?.();
        break;
      case 'chat':
        game.chat.add(cleanChat(message.text), { from: cleanName(message.from) || '?' });
        break;
      case 'sys':
        game.chat.add(cleanChat(message.text), { kind: 'sys' });
        break;
      case 'clock':
        this._clock(message);
        break;
    }
  }

  /**
   * Another game's block changes, via the host, in the host's order. Our own
   * come back too, and are how we learn the host has them; until then, a
   * change we made shadows anyone else's at the same spot, because the host
   * will apply ours after theirs.
   */
  _remoteEdits(message) {
    if (typeof message.d !== 'string') return;
    const list = validEdits(message.l);
    const mine = message.from === this.id;
    const keep = [];
    for (let i = 0; i < list.length; i += 4) {
      const key = `${message.d}:${list[i]},${list[i + 1]},${list[i + 2]}`;
      const pending = this._pending.get(key);
      if (mine) {
        if (pending && pending.seq === message.seq) this._pending.delete(key);
        continue;
      }
      if (pending) continue;
      keep.push(list[i], list[i + 1], list[i + 2], list[i + 3]);
    }
    if (keep.length > 0) this.game.world.applyRemoteEdits(message.d, keep);
  }

  /** The host's clock, weather and difficulty. Small drifts are left alone. */
  _clock(message) {
    const game = this.game;
    if (typeof message.time === 'number' && Math.abs(clockDelta(message.time, game.sky.time)) > 0.002) {
      game.sky.time = ((message.time % 1) + 1) % 1;
    }
    if (typeof message.day === 'number') game.sky.dayCount = message.day;
    if (message.weather) {
      // The state is the host's; the change still eases in here.
      game.weather.restore({ ...message.weather, intensity: game.weather.intensity });
      game.weather.timer = Infinity;
    }
    if (message.difficulty && message.difficulty !== game.difficultyId) game.setDifficulty(message.difficulty);
  }

  _onClose() {
    const waiter = this._welcomeWaiter;
    this._welcomeWaiter = null;
    waiter?.reject(new Error(this._closeReason ?? 'Lost the connection'));
    for (const resolve of this._lockWaiters.values()) resolve({ ok: false, holder: null });
    this._lockWaiters.clear();
    if (this.closed) return;
    this.closed = true;
    this.avatars.clear();
    if (this.ready) this.game.onNetClosed?.(this._closeReason ?? 'Lost the connection to the host');
  }
}
