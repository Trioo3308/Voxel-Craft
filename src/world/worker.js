/**
 * worker.js — Terrain generation + meshing worker.
 *
 * Everything expensive about the world lives here so the render thread never
 * stalls: noise sampling, chunk assembly, and vertex buffer construction all
 * happen off-thread, and finished geometry is handed back as transferable
 * ArrayBuffers (zero-copy).
 *
 * IMPORTANT: import maps do not apply to workers, so nothing in this module's
 * dependency graph may use a bare specifier such as `three`. Keep it to
 * relative imports of plain-data modules.
 *
 * Protocol
 * --------
 *  in  { type: 'init',     seed, terrainVersion }
 *  in  { type: 'exportEdits' }             -> out { type: 'edits', edits }
 *  in  { type: 'importEdits', edits }      -> out { type: 'editsImported' }
 *  in  { type: 'request',  cx, cz }        -> generate + mesh a chunk
 *  in  { type: 'setBlock', x, y, z, id }   -> apply an edit, remesh what moved
 *  in  { type: 'setBlocks', changes }      -> batched edits, one remesh per chunk
 *  in  { type: 'unload',   cx, cz }        -> free voxel memory (edits are kept)
 *  out { type: 'ready' }
 *  out { type: 'chunk',    cx, cz, voxels, opaque, water }
 *  out { type: 'remesh',   cx, cz, opaque, water }
 */

import { TerrainGenerator } from './terrain.js';
import { CombTerrainGenerator } from './combTerrain.js';
import { buildChunkMesh } from './mesher.js';
import { computeChunkLight, emissionOf, LIGHT_MARGIN } from './light.js';
import { DIMENSIONS } from './dimensions.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, chunkKey, voxelIndex, toLocalCoord, toChunkCoord } from './chunk.js';
import { AIR } from './blocks.js';

/**
 * One generator, chunk cache and edit store per dimension.
 *
 * Travelling between dimensions swaps which set is active rather than tearing
 * the worker down, so returning to a dimension does not have to regenerate
 * everything — and edits in the dimension you left stay intact.
 */
const dimensions = new Map();

/** The dimension currently being served. */
let activeDim = DIMENSIONS.OVERWORLD;

/** World seed, kept so a dimension can build its generator lazily. */
let worldSeed = 0;

function dimensionState(id = activeDim) {
  let state = dimensions.get(id);
  if (!state) {
    state = { generator: null, chunks: new Map(), edits: new Map(), emitters: new Map() };
    dimensions.set(id, state);
  }
  return state;
}

/** Active generator / caches, re-read through getters so switching is cheap. */
const terrainOf = (id = activeDim) => dimensionState(id).generator;
const chunksOf = (id = activeDim) => dimensionState(id).chunks;
const editsOf = (id = activeDim) => dimensionState(id).edits;
const emittersOf = (id = activeDim) => dimensionState(id).emitters;

/** Chunks the main thread currently holds — only these are worth remeshing. */
const sentChunks = new Set();

/**
 * Light-emitting blocks are tracked per dimension, keyed "x,y,z" -> level.
 *
 * Kept as a registry rather than discovered by scanning: lighting a chunk only
 * needs the handful of emitters near it, and searching for them would cost
 * hundreds of thousands of block lookups per chunk.
 */

/** Register or clear an emitter after a block changes. */
function updateEmitter(wx, wy, wz, id) {
  const key = wx + ',' + wy + ',' + wz;
  const level = emissionOf(id);
  const emitters = emittersOf();
  if (level > 0) emitters.set(key, level);
  else emitters.delete(key);
}

/** Emitters close enough to affect a chunk. */
function emittersNear(cx, cz) {
  const minX = cx * CHUNK_SX - LIGHT_MARGIN;
  const maxX = cx * CHUNK_SX + CHUNK_SX + LIGHT_MARGIN;
  const minZ = cz * CHUNK_SZ - LIGHT_MARGIN;
  const maxZ = cz * CHUNK_SZ + CHUNK_SZ + LIGHT_MARGIN;

  const found = [];
  for (const [key, level] of emittersOf()) {
    const comma1 = key.indexOf(',');
    const comma2 = key.indexOf(',', comma1 + 1);
    const x = +key.slice(0, comma1);
    const z = +key.slice(comma2 + 1);
    if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;
    found.push({ x, y: +key.slice(comma1 + 1, comma2), z, level });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Voxel access
// ---------------------------------------------------------------------------

/** Generate a chunk if we do not have it yet, applying any stored edits. */
function ensureChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  const chunks = chunksOf();
  let voxels = chunks.get(key);
  if (voxels) return voxels;

  voxels = terrainOf().generateChunk(cx, cz);

  const chunkEdits = editsOf().get(key);
  if (chunkEdits) {
    for (const [index, id] of chunkEdits) voxels[index] = id;
  }

  chunks.set(key, voxels);
  // Torches restored from a save live in the edits, so emitters have to be
  // picked up here rather than only when a block is placed.
  registerChunkEmitters(cx, cz, voxels);
  return voxels;
}

// A one-entry cache turns the mesher's ~42k world-space lookups into a plain
// array index for the ~90% of samples that stay inside the current chunk.
let cacheKey = null;
let cacheVoxels = null;

function sampleBlock(wx, wy, wz) {
  if (wy < 0 || wy >= CHUNK_SY) return AIR;
  const cx = toChunkCoord(wx);
  const cz = toChunkCoord(wz);
  const key = chunkKey(cx, cz);
  if (key !== cacheKey) {
    cacheKey = key;
    cacheVoxels = ensureChunk(cx, cz);
  }
  return cacheVoxels[voxelIndex(toLocalCoord(wx), wy, toLocalCoord(wz))];
}

function invalidateSampleCache() {
  cacheKey = null;
  cacheVoxels = null;
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

/** Collect every ArrayBuffer in a geometry payload so it can be transferred. */
function collectTransferables(geometry, out) {
  if (!geometry) return;
  out.push(
    geometry.positions.buffer,
    geometry.normals.buffer,
    geometry.uvs.buffer,
    geometry.colors.buffer,
    geometry.indices.buffer
  );
}

/** Scan a freshly generated chunk for emitters (restored torches, lava). */
function registerChunkEmitters(cx, cz, voxels) {
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;
  for (let y = 0; y < CHUNK_SY; y++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const id = voxels[voxelIndex(x, y, z)];
        if (id === AIR) continue;
        if (emissionOf(id) > 0) updateEmitter(baseX + x, y, baseZ + z, id);
      }
    }
  }
}

function meshChunk(cx, cz) {
  // The mesher reads one voxel past every edge (and diagonally, for ambient
  // occlusion), so all eight neighbours must exist first. Because generation is
  // a pure function of coordinates, doing this eagerly means chunk borders are
  // correct on first draw and never need a second "seam fix" pass.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) ensureChunk(cx + dx, cz + dz);
  }
  invalidateSampleCache();
  const light = computeChunkLight(cx, cz, sampleBlock, emittersNear(cx, cz));
  invalidateSampleCache();
  return buildChunkMesh(sampleBlock, cx, cz, light);
}

function sendChunk(cx, cz) {
  const voxels = ensureChunk(cx, cz);
  const { opaque, water } = meshChunk(cx, cz);

  // Hand the main thread its own copy of the voxels — it needs them for
  // collision, raycasting and instant edit feedback.
  const voxelCopy = voxels.slice();

  const transfer = [voxelCopy.buffer];
  collectTransferables(opaque, transfer);
  collectTransferables(water, transfer);

  sentChunks.add(chunkKey(cx, cz));
  self.postMessage({ type: 'chunk', cx, cz, voxels: voxelCopy, opaque, water }, transfer);
}

function sendRemesh(cx, cz) {
  if (!sentChunks.has(chunkKey(cx, cz))) return;
  const { opaque, water } = meshChunk(cx, cz);
  const transfer = [];
  collectTransferables(opaque, transfer);
  collectTransferables(water, transfer);
  self.postMessage({ type: 'remesh', cx, cz, opaque, water }, transfer);
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Apply one edit to the voxel store and record which chunks it dirtied.
 * Does not remesh — the caller decides when, so batches can dedupe.
 */
function recordEdit(wx, wy, wz, id, dirty) {
  if (wy < 0 || wy >= CHUNK_SY) return;

  const cx = toChunkCoord(wx);
  const cz = toChunkCoord(wz);
  const lx = toLocalCoord(wx);
  const lz = toLocalCoord(wz);
  const key = chunkKey(cx, cz);
  const index = voxelIndex(lx, wy, lz);

  // Record the edit permanently, then patch the live voxels if loaded.
  const edits = editsOf();
  let chunkEdits = edits.get(key);
  if (!chunkEdits) edits.set(key, (chunkEdits = new Map()));
  chunkEdits.set(index, id);

  const voxels = chunksOf().get(key);
  if (voxels) voxels[index] = id;

  const previousEmission = emittersOf().get(wx + ',' + wy + ',' + wz) ?? 0;
  updateEmitter(wx, wy, wz, id);
  const newEmission = emissionOf(id);

  dirty.add(chunkKey(cx, cz));

  // The owning chunk, plus any neighbour whose 1-voxel skirt just changed.
  const touchesNegX = lx === 0;
  const touchesPosX = lx === CHUNK_SX - 1;
  const touchesNegZ = lz === 0;
  const touchesPosZ = lz === CHUNK_SZ - 1;

  if (touchesNegX) dirty.add(chunkKey(cx - 1, cz));
  if (touchesPosX) dirty.add(chunkKey(cx + 1, cz));
  if (touchesNegZ) dirty.add(chunkKey(cx, cz - 1));
  if (touchesPosZ) dirty.add(chunkKey(cx, cz + 1));
  // Diagonals matter because ambient occlusion samples corner voxels.
  if (touchesNegX && touchesNegZ) dirty.add(chunkKey(cx - 1, cz - 1));
  if (touchesNegX && touchesPosZ) dirty.add(chunkKey(cx - 1, cz + 1));
  if (touchesPosX && touchesNegZ) dirty.add(chunkKey(cx + 1, cz - 1));
  if (touchesPosX && touchesPosZ) dirty.add(chunkKey(cx + 1, cz + 1));

  // A light source reaches far beyond its own cell, so changing one has to
  // dirty every chunk its glow can touch — not just the border neighbours.
  // Without this a torch placed mid-chunk lit its own chunk and stopped dead
  // in a straight line at the boundary until something else forced a remesh.
  if (previousEmission > 0 || newEmission > 0) {
    const reach = Math.max(previousEmission, newEmission);
    const minCX = toChunkCoord(wx - reach);
    const maxCX = toChunkCoord(wx + reach);
    const minCZ = toChunkCoord(wz - reach);
    const maxCZ = toChunkCoord(wz + reach);
    for (let ncz = minCZ; ncz <= maxCZ; ncz++) {
      for (let ncx = minCX; ncx <= maxCX; ncx++) dirty.add(chunkKey(ncx, ncz));
    }
  }
}

/** Remesh every chunk in a dirty set exactly once. */
function flushDirty(dirty) {
  if (dirty.size === 0) return;
  invalidateSampleCache();
  for (const key of dirty) {
    const comma = key.indexOf(',');
    sendRemesh(+key.slice(0, comma), +key.slice(comma + 1));
  }
}

function applyEdit(wx, wy, wz, id) {
  const dirty = new Set();
  recordEdit(wx, wy, wz, id, dirty);
  flushDirty(dirty);
}

/**
 * Apply many edits, then remesh each affected chunk once. A single fluid tick
 * can change dozens of voxels; without this it would trigger dozens of
 * redundant remeshes of the same chunk.
 */
function applyEdits(changes) {
  const dirty = new Set();
  for (const c of changes) recordEdit(c.x, c.y, c.z, c.id, dirty);
  flushDirty(dirty);
}

// ---------------------------------------------------------------------------
// Message pump
// ---------------------------------------------------------------------------

self.onmessage = (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      // `terrainVersion` comes from the save, so an existing world keeps the
      // generation rules it was created with.
      worldSeed = msg.seed;
      dimensions.clear();
      dimensionState(DIMENSIONS.OVERWORLD).generator =
        new TerrainGenerator(msg.seed, msg.terrainVersion);
      dimensionState(DIMENSIONS.COMB).generator = new CombTerrainGenerator(msg.seed);
      activeDim = msg.dimension ?? DIMENSIONS.OVERWORLD;
      sentChunks.clear();
      invalidateSampleCache();
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'setDimension': {
      // Switching keeps every dimension's chunks and edits in memory, so
      // stepping back through a portal does not regenerate the world you left.
      activeDim = msg.dimension;
      sentChunks.clear();
      invalidateSampleCache();
      self.postMessage({ type: 'dimensionReady', dimension: activeDim });
      break;
    }

    case 'exportEdits': {
      // Typed arrays per chunk — compact, and structured-cloneable straight
      // into IndexedDB without a JSON round trip. Exported per dimension.
      const out = {};
      for (const [dimId, state] of dimensions) {
        const list = [];
        for (const [key, map] of state.edits) {
          if (map.size === 0) continue;
          const indices = new Uint32Array(map.size);
          const ids = new Uint8Array(map.size);
          let i = 0;
          for (const [index, id] of map) {
            indices[i] = index;
            ids[i] = id;
            i++;
          }
          list.push({ key, indices, ids });
        }
        if (list.length > 0) out[dimId] = list;
      }
      self.postMessage({ type: 'edits', edits: out });
      break;
    }

    case 'importEdits': {
      // Replacing the edit set invalidates every generated chunk, so drop them
      // all and let the main thread re-request what it needs.
      for (const state of dimensions.values()) {
        state.edits.clear();
        state.chunks.clear();
        state.emitters.clear();
      }
      sentChunks.clear();

      for (const [dimId, list] of Object.entries(msg.edits ?? {})) {
        const state = dimensionState(dimId);
        for (const chunk of list) {
          const map = new Map();
          for (let i = 0; i < chunk.indices.length; i++) map.set(chunk.indices[i], chunk.ids[i]);
          state.edits.set(chunk.key, map);
        }
      }
      invalidateSampleCache();
      self.postMessage({ type: 'editsImported' });
      break;
    }

    case 'request':
      sendChunk(msg.cx, msg.cz);
      break;

    case 'setBlock':
      applyEdit(msg.x, msg.y, msg.z, msg.id);
      break;

    case 'setBlocks':
      applyEdits(msg.changes);
      break;

    case 'unload': {
      const key = chunkKey(msg.cx, msg.cz);
      chunksOf().delete(key);
      sentChunks.delete(key);
      invalidateSampleCache();
      break;
    }

    default:
      console.warn('[worker] unknown message', msg.type);
  }
};
