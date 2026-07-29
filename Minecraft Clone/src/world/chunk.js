/**
 * chunk.js — Chunk geometry constants and coordinate helpers.
 *
 * A chunk is a 16 x 128 x 16 column of voxels stored in a flat Uint8Array.
 * Keeping this module dependency-free lets both the main thread and the
 * meshing worker share the exact same indexing math.
 */

export const CHUNK_SX = 16; // width  (X)
export const CHUNK_SY = 128; // height (Y) — also the world height limit
export const CHUNK_SZ = 16; // depth  (Z)

export const CHUNK_AREA = CHUNK_SX * CHUNK_SZ;
export const CHUNK_VOLUME = CHUNK_SX * CHUNK_SY * CHUNK_SZ;

/**
 * Flat index for a local voxel coordinate.
 * Layout is X-major within a Z row within a Y slice, which makes the mesher's
 * inner loop (X) contiguous in memory.
 */
export function voxelIndex(x, y, z) {
  return x + CHUNK_SX * (z + CHUNK_SZ * y);
}

/** Map key for a chunk column. */
export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

/** World coordinate -> chunk coordinate (floor division by chunk size). */
export function toChunkCoord(v) {
  return Math.floor(v / CHUNK_SX);
}

/** World coordinate -> local coordinate inside its chunk (always 0..15). */
export function toLocalCoord(v) {
  return ((v % CHUNK_SX) + CHUNK_SX) % CHUNK_SX;
}
