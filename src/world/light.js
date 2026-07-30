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
   * @param queue array of [x, y, z] seeds whose light is already written
   */
  propagate(queue) {
    let head = 0;
    while (head < queue.length) {
      const [x, y, z] = queue[head++];
      const level = this.getLight(x, y, z);
      if (level <= 1) continue;

      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (ny < 0 || ny >= CHUNK_SY) continue;
        if (!this.isLoaded(nx, ny, nz)) continue;

        const opacity = opacityOf(this.getBlock(nx, ny, nz));
        if (opacity >= MAX_LIGHT) continue;

        const next = level - 1 - opacity;
        if (next <= this.getLight(nx, ny, nz)) continue;

        this.setLight(nx, ny, nz, next);
        queue.push([nx, ny, nz]);
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

  const inRange = (x, y, z) =>
    y >= 0 && y < CHUNK_SY &&
    x >= baseX - LIGHT_MARGIN && x < baseX + CHUNK_SX + LIGHT_MARGIN &&
    z >= baseZ - LIGHT_MARGIN && z < baseZ + CHUNK_SZ + LIGHT_MARGIN;

  /** Is this world position inside the padded volume we return? */
  const inPadded = (x, y, z) =>
    x >= baseX - 1 && x <= baseX + CHUNK_SX &&
    z >= baseZ - 1 && z <= baseZ + CHUNK_SZ &&
    y >= -1 && y <= CHUNK_SY;

  // Light beyond the padded region still has to be tracked while flooding — a
  // torch ten blocks past the border needs somewhere to hold its falloff — but
  // it is thrown away afterwards.
  const outside = new Map();
  const okey = (x, y, z) => x + ',' + y + ',' + z;

  const getLight = (x, y, z) =>
    inPadded(x, y, z)
      ? light[padIndex(x - baseX, y, z - baseZ)]
      : (outside.get(okey(x, y, z)) ?? 0);

  const setLight = (x, y, z, level) => {
    if (inPadded(x, y, z)) light[padIndex(x - baseX, y, z - baseZ)] = level;
    else outside.set(okey(x, y, z), level);
  };

  const engine = new LightEngine({ getBlock: sampleBlock, getLight, setLight, isLoaded: inRange });

  const seeds = [];
  for (const e of emitters) {
    if (!inRange(e.x, e.y, e.z)) continue;
    if (e.level <= getLight(e.x, e.y, e.z)) continue;
    setLight(e.x, e.y, e.z, e.level);
    seeds.push([e.x, e.y, e.z]);
  }

  if (seeds.length === 0) return null;
  engine.propagate(seeds);
  return light;
}

export { emissionOf };
