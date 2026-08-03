/**
 * netherTerrain.js — The Nether.
 *
 * A closed cavern rather than a landscape: solid netherrack from bedrock to a
 * bedrock ceiling, hollowed out in the middle. That shape is the whole
 * character of the place — there is no sky, no horizon, and every route is a
 * tunnel or a ledge over a lava sea.
 *
 * Built the same way as the Comb's generator: a pure function of (x, y, z) and
 * the seed, so a chunk is identical however many times it is asked for and
 * whichever neighbour asks first. Nothing here is version-gated, because the
 * Nether did not exist before this update — there is no old world to protect.
 */

import { Noise, hash2i, mulberry32 } from './noise.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOLUME, voxelIndex } from './chunk.js';
import {
  AIR, BEDROCK, LAVA, NETHERRACK, SOUL_SAND, GLOWSTONE, QUARTZ_ORE, NETHER_BRICK,
} from './blocks.js';

/** Floor and ceiling, both capped with bedrock you cannot dig through. */
export const NETHER_FLOOR = 0;
export const NETHER_CEILING = 100;

/**
 * Lava fills everything below this, which is what makes the floor dangerous.
 *
 * Set against the measured floor distribution (p25 = 31, p50 = 34): at 31 about
 * a quarter of the floor is under lava, so seas are a real feature of the
 * landscape while most of it is still walkable shore and ridge.
 */
export const NETHER_LAVA_LEVEL = 31;

/** Fortresses sit on a coarse grid, like every other structure in this world. */
export const FORTRESS_SPACING = 20; // chunks

/**
 * Where a glowstone cluster hangs.
 *
 * Measured, not guessed. `perlin2` at this scale has a median near 0 and a
 * 99th percentile around 0.43 — the first value tried here was 0.55, which the
 * field simply never reaches (the maximum over 6,400 samples was 0.488) and
 * generated exactly no glowstone at all. This is the same "raw noise clusters
 * near zero" trap the biome, ruggedness and combium fields all fell into.
 *
 * 0.33 clears in roughly 5% of columns, which reads as occasional clusters
 * rather than a lit ceiling.
 */
const GLOW_THRESHOLD = 0.33;

export class NetherTerrainGenerator {
  constructor(seed = 0) {
    this.seed = (seed ^ 0x4e37) | 0;

    // The cavern: two fields, one for the floor's height and one for the
    // ceiling's, so the open space between them narrows and widens.
    this.nFloor = new Noise(this.seed + 1);
    this.nCeiling = new Noise(this.seed + 2);
    // Blobs bitten out of the walls, which is what stops it reading as a tube.
    this.nCarve = new Noise(this.seed + 3);
    this.nSoul = new Noise(this.seed + 4);
    this.nQuartz = new Noise(this.seed + 5);
    this.nGlow = new Noise(this.seed + 6);

    this._heightCache = new Map();
  }

  /** Top of the netherrack floor at this column. */
  floorHeight(wx, wz) {
    const key = wx + ',' + wz;
    const cached = this._heightCache.get(key);
    if (cached !== undefined) return cached;

    const broad = this.nFloor.fbm2(wx * 0.008, wz * 0.008, 4);
    const detail = this.nFloor.perlin2(wx * 0.05, wz * 0.05);
    // The multiplier is measured, not chosen. `fbm2` piles up near zero — at
    // x14 the floor came out between 26 and 39, thirteen blocks of relief
    // across an entire dimension, and since that never dipped under the lava
    // line there were no lava seas at all. x42 spreads it over roughly 14..54.
    const height = Math.round(34 + broad * 42 + detail * 4);
    const clamped = Math.max(6, Math.min(NETHER_CEILING - 12, height));

    if (this._heightCache.size > 40000) this._heightCache.clear();
    this._heightCache.set(key, clamped);
    return clamped;
  }

  /** Underside of the roof at this column. */
  ceilingHeight(wx, wz) {
    const n = this.nCeiling.fbm2(wx * 0.01, wz * 0.01, 3);
    return Math.round(NETHER_CEILING - 14 + n * 10);
  }

  /**
   * The overworld's `getSurfaceY` contract, so shared code — mob spawning, the
   * locator, portal placement — works here without special cases.
   */
  columnHeight(wx, wz) {
    return this.floorHeight(wx, wz);
  }

  /** Blobby hollows chewed out of the solid rock. */
  isCarved(wx, wy, wz) {
    const n = this.nCarve.perlin3(wx * 0.035, wy * 0.05, wz * 0.035);
    return Math.abs(n) < 0.085;
  }

  generateChunk(cx, cz) {
    const voxels = new Uint8Array(CHUNK_VOLUME);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;

    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const wz = baseZ + lz;
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx;
        const floor = this.floorHeight(wx, wz);
        const ceiling = this.ceilingHeight(wx, wz);

        for (let y = 0; y <= NETHER_CEILING; y++) {
          let id = AIR;

          if (y === 0 || y === NETHER_CEILING) {
            // Sealed top and bottom. The roof matters as much as the floor —
            // it is what stops this reading as an ordinary sky.
            id = BEDROCK.id;
          } else if (y <= floor) {
            id = NETHERRACK.id;

            // Soul sand in patches near the surface of the floor.
            if (y > floor - 3) {
              const soul = this.nSoul.perlin2(wx * 0.06, wz * 0.06);
              if (soul > 0.34) id = SOUL_SAND.id;
            }

            // Quartz, all the way down. Common — it is the Nether's building
            // material, not its treasure.
            const quartz = this.nQuartz.perlin3(wx * 0.11, y * 0.11, wz * 0.11);
            if (quartz > 0.68) id = QUARTZ_ORE.id;

            // Then chew hollows out of it.
            if (y < floor && this.isCarved(wx, y, wz)) {
              id = y <= NETHER_LAVA_LEVEL ? LAVA.id : AIR;
            }
          } else if (y >= ceiling) {
            id = NETHERRACK.id;
          } else if (y <= NETHER_LAVA_LEVEL) {
            // The open middle, flooded to the lava line.
            id = LAVA.id;
          }

          if (id !== AIR) voxels[voxelIndex(lx, y, lz)] = id;
        }
      }
    }

    this._hangGlowstone(voxels, baseX, baseZ);
    this._placeFortresses(voxels, cx, cz, baseX, baseZ);
    return voxels;
  }

  /**
   * Glowstone in clusters on the ceiling.
   *
   * Placed as a post-pass so it can see where the roof actually ended up. It is
   * the only light source you can reach without crossing lava, and the Aether's
   * key, so it needs to be findable rather than merely present.
   */
  _hangGlowstone(voxels, baseX, baseZ) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx, wz = baseZ + lz;
        const n = this.nGlow.perlin2(wx * 0.09, wz * 0.09);
        if (n < GLOW_THRESHOLD) continue;

        // Find the roof above the open middle and hang a short stub from it.
        const ceiling = this.ceilingHeight(wx, wz);
        let y = Math.min(ceiling, NETHER_CEILING - 1);
        while (y > 1 && voxels[voxelIndex(lx, y, lz)] === AIR) y--;
        // `y` now sits on rock; grow downward into the air below it.
        // Thicker where the field is strongest, so clusters have a shape.
        const drop = 1 + Math.floor((n - GLOW_THRESHOLD) * 14);
        for (let i = 0; i <= drop; i++) {
          const py = y - i;
          if (py <= NETHER_LAVA_LEVEL + 1) break;
          if (i > 0 && voxels[voxelIndex(lx, py, lz)] !== AIR) break;
          voxels[voxelIndex(lx, py, lz)] = GLOWSTONE.id;
        }
      }
    }
  }

  /**
   * Where the fortress in this grid cell is, or null.
   *
   * Pure function of the cell, so a fortress straddling a chunk border is
   * written identically from either side — the same rule dungeons, shrines and
   * skate parks follow.
   */
  fortressAt(cx, cz) {
    if (cx % FORTRESS_SPACING !== 0 || cz % FORTRESS_SPACING !== 0) return null;
    const h = hash2i(cx, cz, this.seed ^ 0xf027);
    if ((h & 0xff) < 96) return null;

    const wx = cx * CHUNK_SX + 4 + (h % 8);
    const wz = cz * CHUNK_SZ + 4 + ((h >>> 8) % 8);
    // Above the lava, so a fortress is a bridge you can actually walk.
    const y = NETHER_LAVA_LEVEL + 6 + ((h >>> 16) % 10);
    return { wx, wz, y, half: 5 + ((h >>> 24) & 3) };
  }

  _placeFortresses(voxels, cx, cz, baseX, baseZ) {
    const cellX = Math.floor(cx / FORTRESS_SPACING) * FORTRESS_SPACING;
    const cellZ = Math.floor(cz / FORTRESS_SPACING) * FORTRESS_SPACING;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const fort = this.fortressAt(cellX + dx * FORTRESS_SPACING, cellZ + dz * FORTRESS_SPACING);
        if (!fort) continue;
        if (Math.abs(fort.wx - baseX) > 40 || Math.abs(fort.wz - baseZ) > 40) continue;
        this._buildFortress(voxels, baseX, baseZ, fort);
      }
    }
  }

  /**
   * A nether-brick platform with a walled walkway crossing it.
   *
   * Deliberately simple: somewhere solid over the lava with a bit of shelter,
   * rather than a maze. What makes it worth finding is that it is the only flat
   * ground in the dimension.
   */
  _buildFortress(voxels, baseX, baseZ, fort) {
    const { wx, wz, y, half } = fort;
    const rnd = mulberry32(hash2i(wx, wz, this.seed ^ 0xb41d));

    const set = (x, py, z, id) => {
      const lx = x - baseX, lz = z - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (py < 1 || py >= CHUNK_SY) return;
      voxels[voxelIndex(lx, py, lz)] = id;
    };

    // Deck, plus supports dropping into the lava so it does not look pasted on.
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        set(wx + dx, y, wz + dz, NETHER_BRICK.id);
        for (let py = y + 1; py <= y + 6; py++) set(wx + dx, py, wz + dz, AIR);
        if ((dx === -half || dx === half) && (dz === -half || dz === half)) {
          for (let py = y - 1; py > NETHER_LAVA_LEVEL - 3; py--) {
            set(wx + dx, py, wz + dz, NETHER_BRICK.id);
          }
        }
      }
    }

    // A walled corridor across it, open at both ends.
    for (let dx = -half; dx <= half; dx++) {
      for (const dz of [-1, 1]) {
        for (let py = y + 1; py <= y + 3; py++) set(wx + dx, py, wz + dz * 2, NETHER_BRICK.id);
      }
      set(wx + dx, y + 4, wz, NETHER_BRICK.id);
    }

    // A little glowstone under the roof, so it reads as inhabited.
    for (let dx = -half + 1; dx < half; dx += 3) {
      if (rnd() < 0.6) set(wx + dx, y + 4, wz, GLOWSTONE.id);
    }
  }
}
