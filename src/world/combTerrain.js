/**
 * combTerrain.js — Generator for the Comb dimension.
 *
 * Bone-white ground shot through with crimson crystal. Deliberately unlike the
 * overworld: no biomes, no trees, no sea. Instead a rolling pale plateau riddled
 * with hollow comb cells, crystal veins that glow, and one shrine per region
 * holding the throne.
 *
 * Same contract as TerrainGenerator — `generateChunk(cx, cz)` returning a flat
 * Uint8Array — so the worker can swap between them freely.
 */

import { Noise, hash2i, smoothstep, clamp, mulberry32 } from './noise.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOLUME, voxelIndex } from './chunk.js';
import {
  AIR, BEDROCK, COMB_STONE, COMB_SOIL, COMB_CRYSTAL, COMB_GROWTH,
  COMB_BRICK, THRONE, CHEST,
} from './blocks.js';

/** Bump alongside TERRAIN_VERSION if Comb generation ever changes. */
export const COMB_VERSION = 1;

/** Shrines sit on a coarse grid so exactly one exists per region. */
export const SHRINE_SPACING = 12; // chunks

/**
 * Where the throne and its loot chest sit relative to a shrine anchor.
 * Exported because the main thread needs to find them to post the Warden and
 * stock the chest, and duplicating the offsets there would rot silently.
 */
export const SHRINE_LAYOUT = {
  throne: { dx: 0, dy: 2, dz: -2 },
  chest: { dx: 0, dy: 1, dz: -4 },
  /** Where the guardian stands: in front of the throne, facing the approach. */
  guardian: { dx: 0.5, dy: 1, dz: 3.5 },
};

export class CombTerrainGenerator {
  constructor(seed = 0, version = COMB_VERSION) {
    this.version = version;
    // Offset the seed so the Comb dimension is not a recolour of the overworld
    // generated from the same noise fields.
    this.seed = (seed ^ 0xC0B1E) | 0;

    this.nHeight = new Noise(this.seed + 1);
    this.nDetail = new Noise(this.seed + 2);
    this.nCells = new Noise(this.seed + 3);
    this.nCrystal = new Noise(this.seed + 4);
    this.nGrowth = new Noise(this.seed + 5);

    this._heightCache = new Map();
  }

  /** Surface height of a column. Gently rolling, much flatter than overworld. */
  columnHeight(wx, wz) {
    const key = wx * 92837111 + wz * 689287499;
    const cached = this._heightCache.get(key);
    if (cached !== undefined) return cached;

    const broad = this.nHeight.fbm2(wx * 0.004, wz * 0.004, 3);
    const detail = this.nDetail.fbm2(wx * 0.03, wz * 0.03, 2);
    const height = clamp(Math.round(56 + broad * 14 + detail * 3), 8, CHUNK_SY - 20);

    if (this._heightCache.size > 200000) this._heightCache.clear();
    this._heightCache.set(key, height);
    return height;
  }

  /**
   * Hollow comb cells. Two noise fields near zero at once trace out the walls
   * between cells, leaving the interiors open — the inverse of the overworld's
   * cave worms, which gives a honeycombed interior rather than tunnels.
   */
  isHollow(wx, wy, wz) {
    if (wy < 4) return false;
    const a = this.nCells.perlin3(wx * 0.045, wy * 0.06, wz * 0.045);
    return Math.abs(a) > 0.22;
  }

  /** Crystal veins, the dimension's red accent. */
  isCrystal(wx, wy, wz) {
    return this.nCrystal.perlin3(wx * 0.08, wy * 0.08, wz * 0.08) > 0.62;
  }

  /** Is there a shrine anchored in this chunk, and where? */
  shrineAt(cx, cz) {
    if (((cx % SHRINE_SPACING) + SHRINE_SPACING) % SHRINE_SPACING !== 0) return null;
    if (((cz % SHRINE_SPACING) + SHRINE_SPACING) % SHRINE_SPACING !== 0) return null;

    const h = hash2i(cx, cz, this.seed ^ 0x5417);
    const ox = 4 + (h % 6);
    const oz = 4 + ((h >>> 8) % 6);
    const wx = cx * CHUNK_SX + ox;
    const wz = cz * CHUNK_SZ + oz;
    return { wx, wz, y: this.columnHeight(wx, wz) + 1 };
  }

  generateChunk(cx, cz) {
    const voxels = new Uint8Array(CHUNK_VOLUME);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;

    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const wz = baseZ + lz;
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx;
        const height = this.columnHeight(wx, wz);

        for (let y = 0; y <= height; y++) {
          let id;
          if (y === 0) {
            id = BEDROCK.id;
          } else if (y === height) {
            id = COMB_SOIL.id;
          } else if (y > height - 4) {
            id = COMB_SOIL.id;
          } else {
            id = COMB_STONE.id;
          }

          // Carve the comb interior, then line it with crystal.
          if (y > 3 && y < height && this.isHollow(wx, y, wz)) {
            id = AIR;
          } else if (id === COMB_STONE.id && this.isCrystal(wx, y, wz)) {
            id = COMB_CRYSTAL.id;
          }

          if (id !== AIR) voxels[voxelIndex(lx, y, lz)] = id;
        }

        // Sparse growths on the surface.
        if (this.nGrowth.perlin2(wx * 0.3, wz * 0.3) > 0.55 && height + 1 < CHUNK_SY) {
          const above = voxelIndex(lx, height + 1, lz);
          if (voxels[above] === AIR && voxels[voxelIndex(lx, height, lz)] === COMB_SOIL.id) {
            voxels[above] = COMB_GROWTH.id;
          }
        }
      }
    }

    this._placeShrines(voxels, cx, cz, baseX, baseZ);
    return voxels;
  }

  /**
   * Stamp any shrine whose footprint reaches this chunk. Scans neighbouring
   * anchor chunks too, so a shrine straddling a border is written from both
   * sides — the same purity trick the overworld uses for trees.
   */
  _placeShrines(voxels, cx, cz, baseX, baseZ) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const shrine = this.shrineAt(cx + dx * SHRINE_SPACING, cz + dz * SHRINE_SPACING);
        if (!shrine) continue;
        if (Math.abs(shrine.wx - baseX) > 40 || Math.abs(shrine.wz - baseZ) > 40) continue;
        this._buildShrine(voxels, baseX, baseZ, shrine);
      }
    }
  }

  /** A stepped brick platform with a throne and a loot chest behind it. */
  _buildShrine(voxels, baseX, baseZ, shrine) {
    const set = (x, y, z, id) => {
      const lx = x - baseX;
      const lz = z - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 0 || y >= CHUNK_SY) return;
      voxels[voxelIndex(lx, y, lz)] = id;
    };

    const { wx, wz, y } = shrine;
    const rnd = mulberry32(hash2i(wx, wz, this.seed ^ 0xa11a));

    // Clear the air above so the shrine is never buried.
    for (let dy = 0; dy < 10; dy++) {
      for (let dz = -7; dz <= 7; dz++) {
        for (let dx = -7; dx <= 7; dx++) set(wx + dx, y + dy, wz + dz, AIR);
      }
    }

    // Two-tier platform.
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -6; dx <= 6; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > 9) continue;
        set(wx + dx, y - 1, wz + dz, COMB_BRICK.id);
        if (Math.abs(dx) <= 4 && Math.abs(dz) <= 4) set(wx + dx, y, wz + dz, COMB_BRICK.id);
      }
    }

    // Pillars at the corners, crystal-capped.
    for (const [px, pz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
      for (let dy = 1; dy <= 5; dy++) set(wx + px, y + dy, wz + pz, COMB_BRICK.id);
      set(wx + px, y + 6, wz + pz, COMB_CRYSTAL.id);
    }

    // Back wall, with a little irregularity so it does not look stamped.
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = 1; dy <= 4; dy++) {
        if (dy === 4 && rnd() < 0.35) continue;
        set(wx + dx, y + dy, wz - 5, COMB_BRICK.id);
      }
    }

    // The throne, raised on a dais.
    const T = SHRINE_LAYOUT.throne;
    set(wx + T.dx, y + T.dy - 1, wz + T.dz, COMB_BRICK.id);
    set(wx + T.dx, y + T.dy, wz + T.dz, THRONE.id);
    set(wx + T.dx - 1, y + T.dy - 1, wz + T.dz, COMB_BRICK.id);
    set(wx + T.dx + 1, y + T.dy - 1, wz + T.dz, COMB_BRICK.id);

    // Loot chest tucked behind the throne. The main thread stocks it the first
    // time the player comes within range — see Game._maintainShrines.
    const C = SHRINE_LAYOUT.chest;
    set(wx + C.dx, y + C.dy, wz + C.dz, CHEST.id);

    // Crystal braziers flanking the approach.
    set(wx - 3, y + 1, wz + 3, COMB_CRYSTAL.id);
    set(wx + 3, y + 1, wz + 3, COMB_CRYSTAL.id);
  }
}
