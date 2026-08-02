/**
 * light.js — Block light propagation.
 *
 * Sky exposure alone left caves pitch black with no way to fix it, so this adds
 * a second light channel fed by placeable sources (torches, lava).
 *
 * The algorithm is the standard voxel one: a breadth-first flood fill outward
 * from each emitter, losing one level per block travelled. BFS is the right
 * tool because it visits cells in order of increasing distance, so the first
 * time a cell is reached is already its brightest value and nothing needs
 * revisiting.
 *
 * Removal is the subtle half. Deleting a torch cannot just clear its own cell —
 * everything it lit has to be un-lit and then re-lit from any *other* source
 * still in range. So removal runs its own BFS that erases the affected region,
 * collecting the surviving neighbours as seeds for a re-fill.
 *
 * Runs inside the worker, so no Three.js here.
 */

import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, PAD_VOLUME, padIndex } from './chunk.js';
import { BLOCKS, AIR } from './blocks.js';

export const MAX_LIGHT = 15;

/** How much a block dims light passing through it. Opaque blocks stop it dead. */
function opacityOf(id) {
  if (id === AIR) return 0;
  const block = BLOCKS[id];
  if (!block) return 0;
  if (block.opaque) return MAX_LIGHT;   // fully blocks
  if (block.liquid) return 2;           // water dims noticeably
  return 0;                             // glass, torches, slabs: free passage
}

function emissionOf(id) {
  const block = BLOCKS[id];
  return block ? block.lightEmission : 0;
}

/**
 * Computes and stores block light for a region of chunks.
 *
 * Light crosses chunk borders, so this cannot be a per-chunk calculation. It
 * works against a getter/setter pair supplied by the caller, which is what lets
 * the worker run it over its whole loaded chunk set.
 */
export class LightEngine {
  /**
   * @param getBlock (x,y,z) => block id
   * @param getLight (x,y,z) => 0..15
   * @param setLight (x,y,z,level) => void
   * @param isLoaded (x,y,z) => boolean; propagation stops at unloaded edges
   */
  constructor({ getBlock, getLight, setLight, isLoaded }) {
    this.getBlock = getBlock;
    this.getLight = getLight;
    this.setLight = setLight;
    this.isLoaded = isLoaded;
  }

  /**
   * Flood light outward from a set of already-lit cells.
   *
   * Processed strictly brightest-first, one level at a time, rather than as a
   * plain FIFO. A FIFO is correct for a *single* source — the first time a cell
   * is reached is its final value — but not for a queue holding several sources
   * at different levels. A dim one gets expanded before a bright one's flood
   * arrives, so it fills a region that then has to be overwritten and re-queued,
   * cell by cell.
   *
   * With one torch that costs nothing. With a cave full of lava at 15 and glow
   * lichen at 7 it was most of the work: one chunk beside a lava lake took
   * ~59 ms. Draining level 15 completely before touching level 14 means every
   * cell is written exactly once, at its final value.
   *
   * @param queue array of [x, y, z] seeds whose light is already written
   */
  propagate(queue) {
    // One bucket per level. Nothing below 2 can light a neighbour, so those are
    // never queued at all.
    const buckets = [];
    for (let i = 0; i <= MAX_LIGHT; i++) buckets.push([]);

    for (const cell of queue) {
      const level = this.getLight(cell[0], cell[1], cell[2]);
      if (level > 1) buckets[level].push(cell);
    }

    for (let level = MAX_LIGHT; level >= 2; level--) {
      const bucket = buckets[level];
      // `bucket` grows while being walked — cells reached from a brighter level
      // land here — so re-read the length each time rather than caching it.
      for (let i = 0; i < bucket.length; i++) {
        const [x, y, z] = bucket[i];
        // Raised since it was queued? Then its own, higher bucket already dealt
        // with it and this entry is stale.
        if (this.getLight(x, y, z) !== level) continue;

        for (const [dx, dy, dz] of NEIGHBOURS) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (ny < 0 || ny >= CHUNK_SY) continue;
          if (!this.isLoaded(nx, ny, nz)) continue;

          const opacity = opacityOf(this.getBlock(nx, ny, nz));
          if (opacity >= MAX_LIGHT) continue;

          const next = level - 1 - opacity;
          if (next <= this.getLight(nx, ny, nz)) continue;

          this.setLight(nx, ny, nz, next);
          if (next > 1) buckets[next].push([nx, ny, nz]);
        }
      }
    }
  }

  /** Add a light source and spread it. */
  addSource(x, y, z, level) {
    if (level <= 0) return;
    if (level <= this.getLight(x, y, z)) return;
    this.setLight(x, y, z, level);
    this.propagate([[x, y, z]]);
  }

  /**
   * Remove the light that was coming from a cell.
   *
   * Erases everything that could only have been lit from here, then re-fills
   * from whatever brighter neighbours survived at the boundary.
   */
  removeSource(x, y, z) {
    const previous = this.getLight(x, y, z);
    if (previous <= 0) return;

    this.setLight(x, y, z, 0);

    const dark = [[x, y, z, previous]];
    const relight = [];
    let head = 0;

    while (head < dark.length) {
      const [cx, cy, cz, level] = dark[head++];

      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (ny < 0 || ny >= CHUNK_SY) continue;
        if (!this.isLoaded(nx, ny, nz)) continue;

        const neighbourLevel = this.getLight(nx, ny, nz);
        if (neighbourLevel === 0) continue;

        if (neighbourLevel < level) {
          // Could only have come from us: clear it and keep unwinding.
          this.setLight(nx, ny, nz, 0);
          dark.push([nx, ny, nz, neighbourLevel]);
        } else {
          // Brighter than us, so it has its own supply — use it to refill.
          relight.push([nx, ny, nz]);
        }
      }
    }

    // Emitters inside the erased region must reassert themselves.
    for (const [cx, cy, cz] of dark.map((d) => [d[0], d[1], d[2]])) {
      const emission = emissionOf(this.getBlock(cx, cy, cz));
      if (emission > 0) {
        this.setLight(cx, cy, cz, emission);
        relight.push([cx, cy, cz]);
      }
    }

    if (relight.length > 0) this.propagate(relight);
  }
}

const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/** How far outside a chunk an emitter can still reach into it. */
export const LIGHT_MARGIN = MAX_LIGHT + 1;

/**
 * Build a chunk's light array.
 *
 * Seeds come from a caller-supplied emitter list rather than being discovered by
 * scanning. Scanning the chunk plus a 16-block skirt would mean ~295k block
 * lookups per chunk for a feature that is almost always inactive; the worker
 * instead keeps a registry of emitter positions, which is tiny.
 *
 * @param emitters iterable of {x, y, z, level} in world coordinates, already
 *   filtered to those within LIGHT_MARGIN of this chunk
 * @returns {Uint8Array|null} null when nothing lights this chunk at all, so the
 *   mesher can skip the channel entirely
 */
export function computeChunkLight(cx, cz, sampleBlock, emitters) {
  if (!emitters || emitters.length === 0) return null;

  // Padded by one voxel in every direction. The mesher samples light on the
  // *air* side of each face, which for a face on a chunk border lies in the
  // neighbouring chunk — clamping that sample back inside produced visible
  // seams wherever a torch sat near an edge.
  const light = new Uint8Array(PAD_VOLUME);
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;

  // Flood into one flat scratch buffer covering the whole reachable volume,
  // then copy the padded window out at the end.
  //
  // This used to keep the padded array plus a string-keyed Map for everything
  // beyond it — and "everything beyond it" is 86% of the volume the flood can
  // traverse, so nearly every read and write allocated a key and hit a hash
  // map. Fine for one torch. Beside a lava lake it was ~85 ms for a single
  // chunk. The buffer is reused across calls because this is never re-entrant.
  const scratch = borrowScratch();

  const originX = baseX - LIGHT_MARGIN;
  const originZ = baseZ - LIGHT_MARGIN;

  const inRange = (x, y, z) =>
    y >= 0 && y < CHUNK_SY &&
    x >= originX && x < originX + SCRATCH_W &&
    z >= originZ && z < originZ + SCRATCH_D;

  const scratchIndex = (x, y, z) =>
    (y * SCRATCH_D + (z - originZ)) * SCRATCH_W + (x - originX);

  const getLight = (x, y, z) => (inRange(x, y, z) ? scratch[scratchIndex(x, y, z)] : 0);

  const setLight = (x, y, z, level) => {
    if (inRange(x, y, z)) scratch[scratchIndex(x, y, z)] = level;
  };

  const engine = new LightEngine({ getBlock: sampleBlock, getLight, setLight, isLoaded: inRange });

  // Brightest first.
  //
  // BFS assumes the first time a cell is reached is already its brightest
  // value, which holds for one source but not for a queue seeded with several
  // at different levels: a dim source processed first floods a region that the
  // bright one then has to overwrite, and every overwritten cell is re-queued.
  // With one torch that is invisible. With a cave full of lava at 15 and lichen
  // at 7 it is most of the work — sorting means the dim seeds nearly all find
  // their neighbourhood already brighter and stop immediately.
  const ordered = emitters.length > 1
    ? [...emitters].sort((a, b) => b.level - a.level)
    : emitters;

  const seeds = [];
  for (const e of ordered) {
    if (!inRange(e.x, e.y, e.z)) continue;
    if (e.level <= getLight(e.x, e.y, e.z)) continue;
    setLight(e.x, e.y, e.z, e.level);
    seeds.push([e.x, e.y, e.z]);
  }

  if (seeds.length === 0) return null;
  engine.propagate(seeds);

  // Copy the padded window out of the scratch buffer. The padded array runs
  // from one voxel before the chunk to one past it, because the mesher samples
  // light on the *air* side of each face and for a border face that lies in the
  // neighbouring chunk.
  for (let y = -1; y <= CHUNK_SY; y++) {
    if (y < 0 || y >= CHUNK_SY) continue;      // nothing exists outside 0..SY
    for (let z = -1; z <= CHUNK_SZ; z++) {
      for (let x = -1; x <= CHUNK_SX; x++) {
        light[padIndex(x, y, z)] = scratch[scratchIndex(baseX + x, y, baseZ + z)];
      }
    }
  }
  return light;
}

/**
 * Scratch space for the flood, reused between calls.
 *
 * 48 x 128 x 48 — the chunk plus a LIGHT_MARGIN skirt on each side, which is
 * everything a source in range can reach. Allocated once rather than per chunk;
 * `computeChunkLight` is synchronous and never re-entrant, so a single buffer is
 * safe, and clearing 295 KB is far cheaper than the map it replaced.
 */
const SCRATCH_W = CHUNK_SX + LIGHT_MARGIN * 2;
const SCRATCH_D = CHUNK_SZ + LIGHT_MARGIN * 2;
let scratchBuffer = null;

function borrowScratch() {
  if (!scratchBuffer) scratchBuffer = new Uint8Array(SCRATCH_W * CHUNK_SY * SCRATCH_D);
  else scratchBuffer.fill(0);
  return scratchBuffer;
}

export { emissionOf };
