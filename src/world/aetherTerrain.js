/**
 * aetherTerrain.js — The Aether.
 *
 * The opposite problem to every other generator here. Those decide, for each
 * column, where the ground stops; this one has no ground at all. An island is a
 * 3D blob of solid in an otherwise empty sky, so density has to be evaluated
 * per *cell* rather than per column, and "the surface" is whatever the topmost
 * solid block in a column happens to be — which may be nothing.
 *
 * The falloff that makes islands islands is vertical: density is strongest in a
 * band around `ISLAND_BAND` and tapers to nothing above and below it, so blobs
 * close off top and bottom instead of running away into columns.
 */

import { Noise, hash2i, mulberry32 } from './noise.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOLUME, voxelIndex } from './chunk.js';
import {
  AIR, HOLYSTONE, AETHER_GRASS, AETHER_DIRT, AETHER_LOG, AETHER_LEAVES,
  AMBROSIUM_ORE, AERCLOUD,
} from './blocks.js';

/** Islands cluster around this height, and thin out away from it. */
export const ISLAND_BAND = 64;
/** How far above and below the band islands can reach. */
export const ISLAND_SPREAD = 30;

/** Below this there is nothing at all — the drop you must not take. */
export const AETHER_VOID = 20;

export class AetherTerrainGenerator {
  constructor(seed = 0) {
    this.seed = (seed ^ 0x4e7e) | 0;

    this.nMass = new Noise(this.seed + 1);      // where islands are at all
    this.nShape = new Noise(this.seed + 2);     // their detailed edge
    this.nOre = new Noise(this.seed + 3);
    this.nCloud = new Noise(this.seed + 4);
    this.nTree = new Noise(this.seed + 5);

    this._columnCache = new Map();
  }

  /**
   * Solidity at a point, roughly -1..1. Positive is rock.
   *
   * Two fields: a coarse one that decides where an island exists at all, and a
   * finer one that roughens its edge. The vertical falloff is subtracted from
   * both, which is what closes the blobs off rather than letting them extrude.
   */
  density(wx, wy, wz) {
    if (wy < AETHER_VOID || wy > ISLAND_BAND + ISLAND_SPREAD) return -1;

    const mass = this.nMass.fbm3(wx * 0.012, wy * 0.02, wz * 0.012, 3);
    const shape = this.nShape.perlin3(wx * 0.045, wy * 0.06, wz * 0.045);

    // 0 at the centre of the band, 1 at its edges.
    const offset = Math.abs(wy - ISLAND_BAND) / ISLAND_SPREAD;
    const falloff = offset * offset * 1.35;

    return mass * 0.75 + shape * 0.25 - falloff - 0.06;
  }

  isSolid(wx, wy, wz) {
    return this.density(wx, wy, wz) > 0;
  }

  /**
   * Topmost solid block in a column, or -1 for open sky.
   *
   * The rest of the game assumes `getSurfaceY` returns *something*, so callers
   * that cannot cope with -1 (mob spawning, the locator) already guard on it
   * being below 1 — which is exactly the "there is no ground here" case.
   */
  columnHeight(wx, wz) {
    const key = wx + ',' + wz;
    const cached = this._columnCache.get(key);
    if (cached !== undefined) return cached;

    let top = -1;
    for (let y = ISLAND_BAND + ISLAND_SPREAD; y >= AETHER_VOID; y--) {
      if (this.isSolid(wx, y, wz)) { top = y; break; }
    }

    if (this._columnCache.size > 40000) this._columnCache.clear();
    this._columnCache.set(key, top);
    return top;
  }

  generateChunk(cx, cz) {
    const voxels = new Uint8Array(CHUNK_VOLUME);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;
    const top = Math.min(CHUNK_SY - 1, ISLAND_BAND + ISLAND_SPREAD);

    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const wz = baseZ + lz;
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx;

        // Pass 1: raw stone.
        for (let y = AETHER_VOID; y <= top; y++) {
          if (!this.isSolid(wx, y, wz)) continue;
          let id = HOLYSTONE.id;
          const ore = this.nOre.perlin3(wx * 0.13, y * 0.13, wz * 0.13);
          if (ore > 0.66) id = AMBROSIUM_ORE.id;
          voxels[voxelIndex(lx, y, lz)] = id;
        }

        // Pass 2: turf. Anything with open sky directly above becomes grass,
        // with dirt under it — done per column after the stone so it can see
        // where the top of each island actually is.
        for (let y = top; y >= AETHER_VOID; y--) {
          const here = voxels[voxelIndex(lx, y, lz)];
          if (here !== HOLYSTONE.id) continue;
          const above = y + 1 <= top ? voxels[voxelIndex(lx, y + 1, lz)] : AIR;
          if (above !== AIR) continue;
          voxels[voxelIndex(lx, y, lz)] = AETHER_GRASS.id;
          for (let d = 1; d <= 3; d++) {
            const py = y - d;
            if (py < AETHER_VOID) break;
            if (voxels[voxelIndex(lx, py, lz)] !== HOLYSTONE.id) break;
            voxels[voxelIndex(lx, py, lz)] = AETHER_DIRT.id;
          }
        }
      }
    }

    this._placeClouds(voxels, baseX, baseZ);
    this._placeTrees(voxels, baseX, baseZ);
    return voxels;
  }

  /**
   * Aerclouds, drifting under and between the islands.
   *
   * These are the safety net: landing in one costs no fall damage, so missing a
   * jump is a detour rather than the end of the trip. Hung *below* the island
   * band on purpose, where a fall would otherwise be fatal.
   */
  _placeClouds(voxels, baseX, baseZ) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx, wz = baseZ + lz;
        for (let y = AETHER_VOID + 4; y < ISLAND_BAND + 8; y += 1) {
          if (voxels[voxelIndex(lx, y, lz)] !== AIR) continue;
          const n = this.nCloud.perlin3(wx * 0.03, y * 0.14, wz * 0.03);
          if (n > 0.52) voxels[voxelIndex(lx, y, lz)] = AERCLOUD.id;
        }
      }
    }
  }

  /** Skyroot trees on the turf, on the same jittered-cell scheme as oaks. */
  _placeTrees(voxels, baseX, baseZ) {
    const CELL = 6;
    const MARGIN = 3;
    for (let dz = -MARGIN; dz < CHUNK_SZ + MARGIN; dz++) {
      for (let dx = -MARGIN; dx < CHUNK_SX + MARGIN; dx++) {
        const wx = baseX + dx, wz = baseZ + dz;
        const cellX = Math.floor(wx / CELL), cellZ = Math.floor(wz / CELL);
        const h = hash2i(cellX, cellZ, this.seed ^ 0x7ee5);
        if (wx - cellX * CELL !== h % CELL) continue;
        if (wz - cellZ * CELL !== (h >>> 8) % CELL) continue;
        if (((h >>> 16) & 0xff) < 110) continue;

        const ground = this.columnHeight(wx, wz);
        if (ground < AETHER_VOID) continue;

        // Only on turf, and only where there is room to grow.
        const rnd = mulberry32(h ^ 0x51de);
        const height = 5 + Math.floor(rnd() * 3);
        this._placeTree(voxels, baseX, baseZ, wx, wz, ground, height);
      }
    }
  }

  _placeTree(voxels, baseX, baseZ, wx, wz, ground, height) {
    const set = (x, y, z, id, onlyAir = true) => {
      const lx = x - baseX, lz = z - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 1 || y >= CHUNK_SY) return;
      const index = voxelIndex(lx, y, lz);
      if (onlyAir && voxels[index] !== AIR) return;
      voxels[index] = id;
    };

    // The trunk must actually be standing on this chunk's turf where visible.
    const baseLx = wx - baseX, baseLz = wz - baseZ;
    if (baseLx >= 0 && baseLx < CHUNK_SX && baseLz >= 0 && baseLz < CHUNK_SZ) {
      if (voxels[voxelIndex(baseLx, ground, baseLz)] !== AETHER_GRASS.id) return;
    }

    for (let i = 1; i <= height; i++) set(wx, ground + i, wz, AETHER_LOG.id);

    const crown = ground + height;
    for (let dy = -2; dy <= 1; dy++) {
      const radius = dy <= -1 ? 2 : 1;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) === radius && Math.abs(dz) === radius && radius > 1) continue;
          set(wx + dx, crown + dy, wz + dz, AETHER_LEAVES.id);
        }
      }
    }
    set(wx, crown + 2, wz, AETHER_LEAVES.id);
  }
}
