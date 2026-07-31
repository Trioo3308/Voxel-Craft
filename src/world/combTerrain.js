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
  COMB_RESIN, COMB_SPINE, PALE_FUNGUS, COMB_TILE, COMB_PILLAR, COMB_LANTERN, COMB_GLASS,
} from './blocks.js';

/** Bump alongside TERRAIN_VERSION if Comb generation ever changes. */
export const COMB_VERSION = 1;

/**
 * Shrines sit on a coarse grid so at most one exists per region.
 *
 * Deliberately far apart — roughly 500 blocks between candidate sites, and only
 * about half of those actually hold one. A shrine you trip over on the way in is
 * not a landmark, and the throne is the dimension's whole point.
 */
export const SHRINE_SPACING = 32; // chunks

/** How many chunks out from a shrine the spires start clustering. */
const SHRINE_HINT_RADIUS = 6;

/** Shifts the shrine grid off the world origin. */
const SHRINE_ORIGIN_OFFSET = 13;

/**
 * The shrine anchor chunk nearest a given chunk.
 *
 * Exported so the generator, the spire clustering and the main thread's
 * stocking pass all walk the grid the same way — the offset above means
 * "round to a multiple of the spacing" is no longer correct, and three copies
 * of that arithmetic would drift apart the moment one of them was updated.
 */
export function nearestShrineAnchor(cx, cz) {
  const round = (v) =>
    Math.round((v - SHRINE_ORIGIN_OFFSET) / SHRINE_SPACING) * SHRINE_SPACING + SHRINE_ORIGIN_OFFSET;
  return [round(cx), round(cz)];
}

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
    this.nResin = new Noise(this.seed + 6);
    this.nFungus = new Noise(this.seed + 7);

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

  /** Amber resin seams. Commoner than crystal — this is the material you farm. */
  isResin(wx, wy, wz) {
    return this.nResin.perlin3(wx * 0.06, wy * 0.09, wz * 0.06) > 0.54;
  }

  /**
   * Crystal spires: tall crimson-tipped pillars scattered across the plateau.
   *
   * They exist to be seen from a distance. Now that shrines are rare enough to
   * be genuinely hard to stumble on, spires cluster near them — so a horizon
   * full of them means something, and hunting one down is navigation rather
   * than a random walk.
   */
  spireAt(cx, cz) {
    const h = hash2i(cx, cz, this.seed ^ 0x59a1);
    const nearShrine = this._shrineDistanceChunks(cx, cz) <= SHRINE_HINT_RADIUS;
    // Roughly one chunk in nine normally, one in three near a shrine.
    const threshold = nearShrine ? 85 : 28;
    if ((h & 0xff) >= threshold) return null;

    const wx = cx * CHUNK_SX + 2 + (h % 12);
    const wz = cz * CHUNK_SZ + 2 + ((h >>> 8) % 12);
    return {
      wx, wz,
      base: this.columnHeight(wx, wz),
      height: (nearShrine ? 12 : 7) + ((h >>> 16) % 7),
      nearShrine,
    };
  }

  /** Chunk distance to the nearest shrine anchor, for spire clustering. */
  _shrineDistanceChunks(cx, cz) {
    const [ax, az] = nearestShrineAnchor(cx, cz);
    if (!this.shrineAt(ax, az)) return Infinity;
    return Math.max(Math.abs(cx - ax), Math.abs(cz - az));
  }

  /** Is there a shrine anchored in this chunk, and where? */
  shrineAt(cx, cz) {
    // Offset off the origin. Without it chunk 0,0 is always an anchor, and the
    // return portal drops you near the Comb's origin — so every world would
    // hand you a shrine on arrival, which is exactly what this should not do.
    const gx = cx - SHRINE_ORIGIN_OFFSET;
    const gz = cz - SHRINE_ORIGIN_OFFSET;
    if (((gx % SHRINE_SPACING) + SHRINE_SPACING) % SHRINE_SPACING !== 0) return null;
    if (((gz % SHRINE_SPACING) + SHRINE_SPACING) % SHRINE_SPACING !== 0) return null;

    const h = hash2i(cx, cz, this.seed ^ 0x5417);
    // Not every anchor holds one, so the grid is not a guessable lattice.
    if ((h & 0xff) < 118) return null;

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

          // Carve the comb interior, then line it with crystal and resin.
          if (y > 3 && y < height && this.isHollow(wx, y, wz)) {
            id = AIR;
          } else if (id === COMB_STONE.id && this.isCrystal(wx, y, wz)) {
            id = COMB_CRYSTAL.id;
          } else if (id === COMB_STONE.id && this.isResin(wx, y, wz)) {
            id = COMB_RESIN.id;
          }

          if (id !== AIR) voxels[voxelIndex(lx, y, lz)] = id;
        }

        // --- Surface flora and hazards ------------------------------------
        const above = height + 1;
        if (above < CHUNK_SY &&
            voxels[voxelIndex(lx, above, lz)] === AIR &&
            voxels[voxelIndex(lx, height, lz)] === COMB_SOIL.id) {

          const growth = this.nGrowth.perlin2(wx * 0.3, wz * 0.3);
          const hazard = this.nGrowth.perlin2(wx * 0.11 + 91.3, wz * 0.11 - 44.7);

          // Thresholds measured, not guessed. Raw perlin2 here tops out around
          // 0.7 and clusters near zero: the first pass used 0.55/0.62, which
          // covered 0.07% of columns and left the plateau bare.
          // These give roughly 7% flora and 1% spines.
          if (hazard > 0.42) {
            // Spine thickets: uncommon, clustered, and worth walking around.
            voxels[voxelIndex(lx, above, lz)] = COMB_SPINE.id;
          } else if (growth > 0.28) {
            voxels[voxelIndex(lx, above, lz)] = COMB_GROWTH.id;
          }
        }

        // --- Fungus in the hollow cells ------------------------------------
        // Grown on the floor of any open pocket, which is what gives the caves
        // their own light instead of being pitch dark.
        for (let y = 5; y < height - 1; y++) {
          if (voxels[voxelIndex(lx, y, lz)] !== AIR) continue;
          const below = voxels[voxelIndex(lx, y - 1, lz)];
          if (below !== COMB_STONE.id && below !== COMB_SOIL.id) continue;
          if (this.nFungus.perlin3(wx * 0.19, y * 0.19, wz * 0.19) < 0.42) continue;
          voxels[voxelIndex(lx, y, lz)] = PALE_FUNGUS.id;
        }
      }
    }

    this._placeSpires(voxels, cx, cz, baseX, baseZ);
    this._placeShrines(voxels, cx, cz, baseX, baseZ);
    return voxels;
  }

  /** Stamp any spire whose footprint reaches this chunk. */
  _placeSpires(voxels, cx, cz, baseX, baseZ) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const spire = this.spireAt(cx + dx, cz + dz);
        if (!spire) continue;
        this._buildSpire(voxels, baseX, baseZ, spire);
      }
    }
  }

  /** A tapering pillar of comb stone, capped and veined with crystal. */
  _buildSpire(voxels, baseX, baseZ, spire) {
    const { wx, wz, base, height, nearShrine } = spire;
    const rnd = mulberry32(hash2i(wx, wz, this.seed ^ 0x7c3e));

    const set = (x, y, z, id) => {
      const lx = x - baseX, lz = z - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 0 || y >= CHUNK_SY) return;
      voxels[voxelIndex(lx, y, lz)] = id;
    };

    for (let dy = 0; dy < height; dy++) {
      // Taper: wide at the foot, a single column at the tip.
      const t = dy / height;
      const radius = t < 0.35 ? 1 : 0;

      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (radius === 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
          const crystal = rnd() < 0.16 + t * 0.3;
          set(wx + dx, base + dy, wz + dz, crystal ? COMB_CRYSTAL.id : COMB_STONE.id);
        }
      }
    }

    // A crystal beacon on top; brighter ones mark the shrine's region.
    set(wx, base + height, wz, COMB_CRYSTAL.id);
    if (nearShrine) set(wx, base + height + 1, wz, COMB_CRYSTAL.id);
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

    // Two-tier platform: a broad brick apron with a polished inner floor.
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -6; dx <= 6; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > 9) continue;
        set(wx + dx, y - 1, wz + dz, COMB_BRICK.id);
        if (Math.abs(dx) <= 4 && Math.abs(dz) <= 4) {
          // Tiled inside, bricked at the rim, so the floor has a border.
          const inner = Math.abs(dx) <= 3 && Math.abs(dz) <= 3;
          set(wx + dx, y, wz + dz, inner ? COMB_TILE.id : COMB_BRICK.id);
        }
      }
    }

    // Fluted pillars at the corners, lantern-capped.
    for (const [px, pz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
      for (let dy = 1; dy <= 6; dy++) set(wx + px, y + dy, wz + pz, COMB_PILLAR.id);
      set(wx + px, y + 7, wz + pz, COMB_LANTERN.id);
    }

    // Back wall with a glass clerestory, irregular along the top so it does not
    // look stamped.
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = 1; dy <= 5; dy++) {
        if (dy === 5 && rnd() < 0.35) continue;
        const window = dy === 3 && Math.abs(dx) <= 3 && dx % 2 === 0;
        set(wx + dx, y + dy, wz - 5, window ? COMB_GLASS.id : COMB_BRICK.id);
      }
    }

    // Side walls, low, framing the approach.
    for (let dz = -4; dz <= 1; dz++) {
      for (const px of [-5, 5]) {
        for (let dy = 1; dy <= 2; dy++) set(wx + px, y + dy, wz + dz, COMB_BRICK.id);
      }
    }

    // The throne, raised on a tiled dais.
    const T = SHRINE_LAYOUT.throne;
    set(wx + T.dx, y + T.dy - 1, wz + T.dz, COMB_TILE.id);
    set(wx + T.dx, y + T.dy, wz + T.dz, THRONE.id);
    set(wx + T.dx - 1, y + T.dy - 1, wz + T.dz, COMB_TILE.id);
    set(wx + T.dx + 1, y + T.dy - 1, wz + T.dz, COMB_TILE.id);

    // Loot chest tucked behind the throne. The main thread stocks it the first
    // time the player comes within range — see Game._maintainShrines.
    const C = SHRINE_LAYOUT.chest;
    set(wx + C.dx, y + C.dy, wz + C.dz, CHEST.id);

    // Lantern braziers flanking the approach, on short plinths.
    for (const px of [-3, 3]) {
      set(wx + px, y + 1, wz + 3, COMB_PILLAR.id);
      set(wx + px, y + 2, wz + 3, COMB_LANTERN.id);
    }

    // Resin offerings set into the floor either side of the dais.
    set(wx - 2, y, wz - 2, COMB_RESIN.id);
    set(wx + 2, y, wz - 2, COMB_RESIN.id);
  }
}
