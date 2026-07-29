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
import { buildChunkMesh } from './mesher.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, chunkKey, voxelIndex, toLocalCoord, toChunkCoord } from './chunk.js';
import { AIR } from './blocks.js';

/** @type {TerrainGenerator} */
let terrain = null;

/** Generated voxel data, keyed by "cx,cz". */
const chunks = new Map();

/**
 * Player edits, keyed by "cx,cz" -> Map(voxelIndex -> blockId).
 * Kept even after a chunk is unloaded so revisiting an area restores changes.
 */
const edits = new Map();

/** Chunks the main thread currently holds — only these are worth remeshing. */
const sentChunks = new Set();

// ---------------------------------------------------------------------------
// Voxel access
// ---------------------------------------------------------------------------

/** Generate a chunk if we do not have it yet, applying any stored edits. */
function ensureChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  let voxels = chunks.get(key);
  if (voxels) return voxels;

  voxels = terrain.generateChunk(cx, cz);

  const chunkEdits = edits.get(key);
  if (chunkEdits) {
    for (const [index, id] of chunkEdits) voxels[index] = id;
  }

  chunks.set(key, voxels);
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

function meshChunk(cx, cz) {
  // The mesher reads one voxel past every edge (and diagonally, for ambient
  // occlusion), so all eight neighbours must exist first. Because generation is
  // a pure function of coordinates, doing this eagerly means chunk borders are
  // correct on first draw and never need a second "seam fix" pass.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) ensureChunk(cx + dx, cz + dz);
  }
  invalidateSampleCache();
  return buildChunkMesh(sampleBlock, cx, cz);
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
  let chunkEdits = edits.get(key);
  if (!chunkEdits) edits.set(key, (chunkEdits = new Map()));
  chunkEdits.set(index, id);

  const voxels = chunks.get(key);
  if (voxels) voxels[index] = id;

  // The owning chunk, plus any neighbour whose 1-voxel skirt just changed.
  const touchesNegX = lx === 0;
  const touchesPosX = lx === CHUNK_SX - 1;
  const touchesNegZ = lz === 0;
  const touchesPosZ = lz === CHUNK_SZ - 1;

  dirty.add(chunkKey(cx, cz));
  if (touchesNegX) dirty.add(chunkKey(cx - 1, cz));
  if (touchesPosX) dirty.add(chunkKey(cx + 1, cz));
  if (touchesNegZ) dirty.add(chunkKey(cx, cz - 1));
  if (touchesPosZ) dirty.add(chunkKey(cx, cz + 1));
  // Diagonals matter because ambient occlusion samples corner voxels.
  if (touchesNegX && touchesNegZ) dirty.add(chunkKey(cx - 1, cz - 1));
  if (touchesNegX && touchesPosZ) dirty.add(chunkKey(cx - 1, cz + 1));
  if (touchesPosX && touchesNegZ) dirty.add(chunkKey(cx + 1, cz - 1));
  if (touchesPosX && touchesPosZ) dirty.add(chunkKey(cx + 1, cz + 1));
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
    case 'init':
      // `terrainVersion` comes from the save, so an existing world keeps the
      // generation rules it was created with.
      terrain = new TerrainGenerator(msg.seed, msg.terrainVersion);
      self.postMessage({ type: 'ready' });
      break;

    case 'exportEdits': {
      // Typed arrays per chunk — compact, and structured-cloneable straight
      // into IndexedDB without a JSON round trip.
      const out = [];
      for (const [key, map] of edits) {
        if (map.size === 0) continue;
        const indices = new Uint32Array(map.size);
        const ids = new Uint8Array(map.size);
        let i = 0;
        for (const [index, id] of map) {
          indices[i] = index;
          ids[i] = id;
          i++;
        }
        out.push({ key, indices, ids });
      }
      self.postMessage({ type: 'edits', edits: out });
      break;
    }

    case 'importEdits': {
      // Replacing the edit set invalidates every generated chunk, so drop them
      // all and let the main thread re-request what it needs.
      edits.clear();
      chunks.clear();
      sentChunks.clear();
      for (const chunk of msg.edits) {
        const map = new Map();
        for (let i = 0; i < chunk.indices.length; i++) map.set(chunk.indices[i], chunk.ids[i]);
        edits.set(chunk.key, map);
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
      chunks.delete(key);
      sentChunks.delete(key);
      invalidateSampleCache();
      break;
    }

    default:
      console.warn('[worker] unknown message', msg.type);
  }
};
