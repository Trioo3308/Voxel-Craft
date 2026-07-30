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

// ---------------------------------------------------------------------------
// Padded addressing
// ---------------------------------------------------------------------------
// Several passes need to read one voxel *outside* the chunk in every direction
// — the mesher for face culling and ambient occlusion, the light engine so a
// torch just over the border still lights the seam correctly. They must agree
// on the layout, so it lives here rather than being redefined in each.

export const PAD_SX = CHUNK_SX + 2;
export const PAD_SY = CHUNK_SY + 2;
export const PAD_SZ = CHUNK_SZ + 2;
export const PAD_VOLUME = PAD_SX * PAD_SY * PAD_SZ;

/** Index into a padded volume. Local coords may range from -1 to SIZE. */
export function padIndex(x, y, z) {
  return (x + 1) + PAD_SX * ((z + 1) + PAD_SZ * (y + 1));
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
