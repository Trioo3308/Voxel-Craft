/**
 * save.js — World persistence.
 *
 * HOW UPDATES ARE KEPT FROM BREAKING EXISTING WORLDS
 * -------------------------------------------------
 * Three independent hazards, three defences:
 *
 * 1. The save layout changes.
 *    Every save records `formatVersion`. `MIGRATIONS` holds one function per
 *    version step, applied in order on load. Old saves are upgraded, never
 *    rejected.
 *
 * 2. Terrain generation changes.
 *    Every save records `terrainVersion`, and the generator is constructed with
 *    *that* version rather than the newest one. A world keeps the landscape
 *    rules it was born with, so newly explored chunks still match the ones the
 *    player already walked through. See TerrainGenerator's constructor.
 *
 * 3. Block or item ids are renumbered.
 *    This is the sneakiest one: saved edits are just numbers, so inserting a
 *    block in the middle of the registry would silently turn someone's house
 *    into a different material. Saves therefore store a *palette* mapping id ->
 *    stable name, and loading remaps by name. Ids may be reshuffled freely;
 *    only renaming or deleting a block loses data, and that is reported rather
 *    than applied silently.
 *
 * Storage is IndexedDB — block edits are stored as typed arrays, which
 * structured clone handles natively and compactly.
 */

import { BLOCKS, ITEMS, AIR, getThing, isBlockId } from './blocks.js';
import { TERRAIN_VERSION } from './terrain.js';
import { DIMENSIONS } from './dimensions.js';

const DB_NAME = 'voxelcraft';
const DB_VERSION = 1;
const STORE = 'worlds';

/** Bump when the shape of a save record changes, and add a migration. */
export const SAVE_FORMAT_VERSION = 3;

/**
 * Migrations from version N to N+1. Add entries; never edit existing ones.
 * @type {Record<number, (save: object) => object>}
 */
const MIGRATIONS = {
  /**
   * v1 -> v2: worlds gained a fixed game mode chosen at creation.
   *
   * Older worlds have no recorded mode, so it is inferred from how the world was
   * last actually played: a world left in creative stays creative-capable, and
   * one left in survival becomes a survival world for good.
   *
   * Blanket-granting creative here was the first attempt and was wrong — it
   * meant every pre-existing world ignored the lock, which is precisely the
   * behaviour the mode was added to prevent.
   */
  1: (save) => ({
    ...save,
    formatVersion: 2,
    allowCreative: save.player ? save.player.creative === true : false,
  }),

  /**
   * v2 -> v3: dimensions.
   *
   * `edits` went from one flat chunk list to a map keyed by dimension, and
   * block-entity keys gained a dimension prefix. Everything a v2 world contains
   * was necessarily in the overworld, so both are simply filed under it.
   */
  2: (save) => ({
    ...save,
    formatVersion: 3,
    dimension: DIMENSIONS.OVERWORLD,
    edits: { [DIMENSIONS.OVERWORLD]: save.edits ?? [] },
    blockEntities: (save.blockEntities ?? []).map((e) => ({
      ...e,
      key: `${DIMENSIONS.OVERWORLD}:${e.key}`,
    })),
    shrines: [],
  }),
};

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/** Snapshot of every id -> stable name, stored alongside the world. */
function buildPalette() {
  const blocks = {};
  for (const b of BLOCKS) if (b) blocks[b.id] = b.name;
  const items = {};
  for (const i of ITEMS) if (i) items[i.id] = i.name;
  return { blocks, items };
}

/**
 * Build a saved-id -> current-id lookup by matching names.
 * @returns {{map: Map<number, number>, missing: string[]}}
 */
function buildRemap(palette) {
  const byName = new Map();
  for (const b of BLOCKS) if (b) byName.set(b.name, b.id);
  for (const i of ITEMS) if (i) byName.set(i.name, i.id);

  const map = new Map();
  const missing = [];

  for (const table of [palette.blocks ?? {}, palette.items ?? {}]) {
    for (const [savedId, name] of Object.entries(table)) {
      const current = byName.get(name);
      if (current === undefined) {
        missing.push(name);
        continue;
      }
      map.set(Number(savedId), current);
    }
  }
  return { map, missing };
}

/** Every chunk-edit record in a save, whichever layout it uses. */
function editChunks(edits) {
  if (!edits) return [];
  return Array.isArray(edits) ? edits : Object.values(edits).flat();
}

/** True when nothing moved — lets loading skip the remap work entirely. */
function isIdentityRemap(map) {
  for (const [from, to] of map) if (from !== to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Capture / restore
// ---------------------------------------------------------------------------

/** Snapshot everything needed to reconstruct the session. */
export async function captureState(game, meta = {}) {
  const player = game.player;
  const edits = await game.world.exportEdits();

  return {
    formatVersion: SAVE_FORMAT_VERSION,
    terrainVersion: game.world.terrainVersion,
    id: meta.id,
    name: meta.name,
    seed: game.world.seed,
    createdAt: meta.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    playTimeSeconds: Math.round(meta.playTimeSeconds ?? 0),
    // Fixed at creation; never taken from the live player state, so a bug
    // elsewhere cannot quietly promote a survival world.
    allowCreative: meta.allowCreative === true,

    palette: buildPalette(),

    player: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      yaw: player.yaw,
      pitch: player.pitch,
      creative: player.creative,
      spawn: player.spawnPoint.toArray(),
      health: player.survival.health,
      hunger: player.survival.hunger,
      saturation: player.survival.saturation,
    },

    inventory: {
      selected: player.inventory.selected,
      // Nulls are preserved so slot positions survive the round trip.
      slots: player.inventory.slots.map((s) =>
        s ? { id: s.id, count: s.count, durability: s.durability ?? null } : null
      ),
      armor: player.inventory.armor.map((s) =>
        s ? { id: s.id, count: s.count, durability: s.durability ?? null } : null
      ),
    },

    time: game.sky.time,
    /** Which dimension the player logged out in. */
    dimension: game.world.dimension,
    /** `{ [dimensionId]: chunkEditList }` — see World.exportEdits. */
    edits,
    /** Shrines already stocked, so returning does not re-roll their loot. */
    shrines: [...game._shrinesDone],

    // Furnace contents, keyed by position.
    blockEntities: [...game.world.blockEntities.entries()].map(([key, entity]) => ({
      key,
      type: entity.type,
      state: entity.state,
    })),
  };
}

/**
 * Apply a loaded save onto a freshly constructed game.
 * Resolves once the worker has taken delivery of the block edits.
 */
export async function applyState(game, save) {
  const { map: remap, missing } = buildRemap(save.palette ?? buildPalette());
  const identity = isIdentityRemap(remap);
  const translate = (id) => (identity ? id : remap.get(id) ?? AIR);

  const player = game.player;
  const p = save.player;
  player.position.set(p.x, p.y, p.z);
  player.velocity.set(0, 0, 0);
  player.yaw = p.yaw;
  player.pitch = p.pitch;
  // A survival world can never come back as creative, whatever the save says.
  player.creative = save.allowCreative === true && !!p.creative;
  player.spawnPoint.fromArray(p.spawn);
  player.survival.health = p.health;
  player.survival.hunger = p.hunger;
  player.survival.saturation = p.saturation;
  player.survival.dead = false;

  const restoreSlots = (saved, target) => {
    for (let i = 0; i < target.length; i++) {
      const s = saved && saved[i];
      if (!s) { target[i] = null; continue; }
      const id = translate(s.id);
      // A dropped block/item leaves the slot empty rather than becoming air.
      target[i] = id === AIR ? null : { id, count: s.count, durability: s.durability ?? undefined };
    }
  };

  restoreSlots(save.inventory.slots, player.inventory.slots);
  restoreSlots(save.inventory.armor, player.inventory.armor);
  player.inventory.selected = save.inventory.selected ?? 0;
  player.inventory.touch();

  game.sky.setTime(save.time ?? 0.1);

  // Remap the block edits before handing them to the worker. Every dimension's
  // edits go through the same palette, since ids are global.
  const edits = {};
  for (const [dimension, chunks] of Object.entries(save.edits ?? {})) {
    edits[dimension] = chunks.map((chunk) => {
      const ids = new Uint8Array(chunk.ids.length);
      for (let i = 0; i < ids.length; i++) ids[i] = translate(chunk.ids[i]);
      return { key: chunk.key, indices: chunk.indices, ids };
    });
  }

  game._shrinesDone = new Set(save.shrines ?? []);

  // Container contents go through the same id remap as everything else.
  game.world.blockEntities.clear();
  for (const entity of save.blockEntities ?? []) {
    const state = { ...entity.state };

    // Furnace slots.
    for (const field of ['input', 'fuel', 'output']) {
      if (!(field in state)) continue;
      const stack = state[field];
      if (!stack) { state[field] = null; continue; }
      const id = translate(stack.id);
      state[field] = id === AIR ? null : { ...stack, id };
    }

    // Chest slots.
    if (Array.isArray(state.slots)) {
      state.slots = state.slots.map((stack) => {
        if (!stack) return null;
        const id = translate(stack.id);
        return id === AIR ? null : { ...stack, id };
      });
    }

    game.world.blockEntities.set(entity.key, { type: entity.type, state, wasLit: false });
  }

  // Switch first so the import streams the dimension the player logged out in.
  await game.world.setDimension(save.dimension ?? DIMENSIONS.OVERWORLD);
  await game.world.importEdits(edits);
  game._applyDimensionLook();

  return { missing };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Bring a save up to the current format.
 * @throws if the save comes from a newer build than this one.
 */
export function migrate(save) {
  if (save.formatVersion > SAVE_FORMAT_VERSION) {
    throw new Error(
      `"${save.name}" was saved by a newer version of the game ` +
      `(format ${save.formatVersion}, this build supports ${SAVE_FORMAT_VERSION}). ` +
      'Update the game to open it.'
    );
  }

  let current = save;
  while (current.formatVersion < SAVE_FORMAT_VERSION) {
    const step = MIGRATIONS[current.formatVersion];
    if (!step) {
      throw new Error(`No migration from save format ${current.formatVersion}.`);
    }
    current = step(current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const SaveManager = {
  /** Is persistence available at all? (Private browsing can disable it.) */
  get available() {
    return typeof indexedDB !== 'undefined';
  },

  /** Metadata for every world, newest first. Does not load edit data. */
  async list() {
    const all = await tx(STORE, 'readonly', (store) => store.getAll());
    return all
      .map((w) => ({
        id: w.id,
        name: w.name,
        seed: w.seed,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        playTimeSeconds: w.playTimeSeconds ?? 0,
        formatVersion: w.formatVersion,
        terrainVersion: w.terrainVersion,
        allowCreative: w.allowCreative === true,
        // `list()` reads raw records without migrating, so it sees both the v2
        // flat array and the v3 per-dimension map.
        editedBlocks: editChunks(w.edits).reduce((n, c) => n + c.ids.length, 0),
        /** Set when this build is too old to open it. */
        tooNew: w.formatVersion > SAVE_FORMAT_VERSION || w.terrainVersion > TERRAIN_VERSION,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async get(id) {
    const raw = await tx(STORE, 'readonly', (store) => store.get(id));
    if (!raw) return null;
    return migrate(raw);
  },

  async put(save) {
    await tx(STORE, 'readwrite', (store) => store.put(save));
    return save;
  },

  async delete(id) {
    await tx(STORE, 'readwrite', (store) => store.delete(id));
  },

  async rename(id, name) {
    const save = await tx(STORE, 'readonly', (store) => store.get(id));
    if (!save) return;
    save.name = name;
    await tx(STORE, 'readwrite', (store) => store.put(save));
  },

  /**
   * A blank save record for a brand-new world.
   * @param allowCreative chosen at creation and fixed for the world's lifetime —
   *   a survival world can never be switched to creative.
   */
  createNew(name, seed, allowCreative = false) {
    return {
      formatVersion: SAVE_FORMAT_VERSION,
      terrainVersion: TERRAIN_VERSION,
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name,
      seed: seed | 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      playTimeSeconds: 0,
      allowCreative,
      palette: buildPalette(),
      player: null, // filled in on first save
      inventory: null,
      time: 0.08,
      dimension: DIMENSIONS.OVERWORLD,
      edits: {},
      shrines: [],
    };
  },

  /** Export a world as a downloadable JSON blob (typed arrays -> plain arrays). */
  async exportJSON(id) {
    const save = await this.get(id);
    if (!save) return null;
    // Typed arrays do not survive JSON, so widen them per dimension.
    const edits = {};
    for (const [dimension, chunks] of Object.entries(save.edits ?? {})) {
      edits[dimension] = chunks.map((c) => ({
        key: c.key,
        indices: Array.from(c.indices),
        ids: Array.from(c.ids),
      }));
    }
    return JSON.stringify({ ...save, edits });
  },

  /** Import a world previously produced by exportJSON. */
  async importJSON(text) {
    const parsed = JSON.parse(text);
    const narrow = (c) => ({
      key: c.key,
      indices: Uint32Array.from(c.indices),
      ids: Uint8Array.from(c.ids),
    });

    // A v2 export is still a flat array here; `migrate` files it under the
    // overworld afterwards, so only the typed arrays need restoring now.
    let edits;
    if (Array.isArray(parsed.edits)) {
      edits = parsed.edits.map(narrow);
    } else {
      edits = {};
      for (const [dim, chunks] of Object.entries(parsed.edits ?? {})) edits[dim] = chunks.map(narrow);
    }

    const save = migrate({
      ...parsed,
      // Give the import a fresh id so it never clobbers an existing world.
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      edits,
    });
    await this.put(save);
    return save;
  },
};
