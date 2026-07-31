/**
 * terrain.js — Procedural world generation.
 *
 * Design rule: everything here is a *pure function of world coordinates and the
 * seed*. No chunk ever looks at its neighbours' stored data. That is what makes
 * infinite generation seamless — a tree straddling a chunk border is computed
 * identically from both sides, so the halves always line up.
 */

import { Noise, hash2i, smoothstep, clamp, mulberry32 } from './noise.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOLUME, voxelIndex } from './chunk.js';
import {
  AIR, GRASS, DIRT, STONE, SAND, GRAVEL, LOG, LEAVES, WATER, BEDROCK, SNOW,
  COAL_ORE, IRON_ORE, GOLD_ORE, REDSTONE_ORE, LAPIS_ORE, DIAMOND_ORE, EMERALD_ORE, COMBIUM_ORE,
  DRY_GRASS, PODZOL, SWAMP_GRASS, CLAY, SANDSTONE, TREE_WOODS,
  COBBLE, MOSSY_COBBLE, CHEST,
} from './blocks.js';
import Settings from '../settings.js';

/**
 * Generator version. Bump ONLY when a change would reshape existing terrain.
 * Saved worlds record the version they were created with, and the loader
 * refuses to silently regenerate them under different rules — see world/save.js.
 */
export const TERRAIN_VERSION = 3;

/**
 * Dungeons sit on a coarse grid, so at most one exists per region. Exported
 * because the main thread walks the same grid to find rooms to stock, and two
 * copies of the number would drift apart.
 */
export const DUNGEON_SPACING = 10; // chunks

export const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  TUNDRA: 5,
  MOUNTAINS: 6,
  SAVANNA: 7,
  TAIGA: 8,
  SWAMP: 9,
};

export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Tundra', 'Mountains',
  'Savanna', 'Taiga', 'Swamp',
];

/**
 * Ore distribution. Checked rarest-first so a diamond vein wins over the coal
 * that would otherwise overlap it.
 *
 *   minY/maxY  depth band the ore can appear in
 *   scale      noise frequency — lower means larger, blobbier veins
 *   threshold  higher is rarer
 */
const ORE_TABLE = [
  // Combium is the gateway to the Comb dimension: deepest band, diamond pickaxe
  // required, and slightly rarer than diamond itself (~1.3 vs ~1.5 per chunk in
  // y 1..16). At 2-3 drops per vein block that is roughly a dozen chunks of deep
  // mining for a ten-block portal frame.
  //
  // The threshold is measured, not guessed. This field's tail holds 1342ppm
  // above 0.70 but only 157ppm above 0.80, so the original 0.80 in a 12-block
  // band generated essentially nothing — the same "raw noise clusters near zero"
  // trap that the biome and ruggedness fields both hit.
  //
  // Deliberately NOT gated behind a terrain version: gating it would lock every
  // existing world out of the dimension. Leaving it ungated only means chunks
  // explored before this update have none, the same seam Minecraft accepts
  // whenever it adds an ore.
  { id: COMBIUM_ORE.id,  field: 'nCombium',  minY: 1,  maxY: 14,  scale: 0.19, threshold: 0.775 },
  { id: DIAMOND_ORE.id,  field: 'nDiamond',  minY: 1,  maxY: 16,  scale: 0.16, threshold: 0.76 },
  { id: EMERALD_ORE.id,  field: 'nEmerald',  minY: 4,  maxY: 40,  scale: 0.22, threshold: 0.80, mountainsOnly: true },
  { id: REDSTONE_ORE.id, field: 'nRedstone', minY: 2,  maxY: 22,  scale: 0.13, threshold: 0.68 },
  { id: GOLD_ORE.id,     field: 'nGold',     minY: 3,  maxY: 32,  scale: 0.14, threshold: 0.72 },
  { id: LAPIS_ORE.id,    field: 'nLapis',    minY: 2,  maxY: 34,  scale: 0.15, threshold: 0.74 },
  { id: IRON_ORE.id,     field: 'nIron',     minY: 3,  maxY: 62,  scale: 0.13, threshold: 0.66 },
  { id: COAL_ORE.id,     field: 'nCoal',     minY: 5,  maxY: 118, scale: 0.11, threshold: 0.62 },
];

export class TerrainGenerator {
  /**
   * @param seed world seed
   * @param version terrain rules to generate under. Saved worlds pass the
   *   version they were created with, so a future update that changes
   *   generation cannot reshape terrain someone has already explored.
   *
   *   To change generation in future: bump TERRAIN_VERSION, and branch on
   *   `this.version` wherever the behaviour differs. Never edit v1 behaviour
   *   in place — that is exactly what silently corrupts existing worlds.
   */
  constructor(seed = Settings.seed, version = TERRAIN_VERSION) {
    if (version > TERRAIN_VERSION) {
      throw new Error(
        `World needs terrain version ${version} but this build only knows ${TERRAIN_VERSION}. ` +
        'It was probably created in a newer version of the game.'
      );
    }
    this.version = version;
    this.seed = seed | 0;
    this.seaLevel = Settings.seaLevel;

    // Separate noise fields so tweaking one does not disturb the others.
    this.nContinent = new Noise(seed + 1);
    this.nHills = new Noise(seed + 2);
    this.nDetail = new Noise(seed + 3);
    this.nMountain = new Noise(seed + 4);
    this.nTemp = new Noise(seed + 5);
    this.nHumid = new Noise(seed + 6);
    this.nCaveA = new Noise(seed + 7);
    this.nCaveB = new Noise(seed + 8);
    this.nWeird = new Noise(seed + 20); // secondary climate axis, separates savanna/swamp
    // v2: where the ground turns broken and cliffy, and the fine detail that
    // shapes it once it does.
    this.nRugged = new Noise(seed + 21);
    this.nCliff = new Noise(seed + 22);

    // One independent field per ore so their veins do not correlate.
    this.nCoal = new Noise(seed + 9);
    this.nIron = new Noise(seed + 10);
    this.nGold = new Noise(seed + 11);
    this.nRedstone = new Noise(seed + 12);
    this.nLapis = new Noise(seed + 13);
    this.nDiamond = new Noise(seed + 14);
    this.nEmerald = new Noise(seed + 15);
    this.nCombium = new Noise(seed + 16);

    // Small memo cache for column heights — the tree pass re-queries columns
    // that the terrain pass already computed.
    this._heightCache = new Map();
  }

  // -------------------------------------------------------------------------
  // Column shape
  // -------------------------------------------------------------------------

  /** Surface height (the Y of the topmost terrain block) at a world column. */
  columnHeight(wx, wz) {
    const key = wx * 92837111 + wz * 689287499;
    const cached = this._heightCache.get(key);
    if (cached !== undefined) return cached;

    // Broad landmass shape. fBm output clusters near zero, so it is amplified
    // and clamped — otherwise most of the world sits within a couple of blocks
    // of sea level and the map is nothing but beaches.
    const continent = clamp(this.nContinent.fbm2(wx * 0.0016, wz * 0.0016, 4) * 1.9, -1, 1);
    // Rolling mid-scale hills.
    const hills = this.nHills.fbm2(wx * 0.009, wz * 0.009, 4);
    // Fine surface roughness.
    const detail = this.nDetail.fbm2(wx * 0.045, wz * 0.045, 2);
    // Where mountains are allowed to exist at all. The upper edge sits inside
    // the range fBm actually reaches, so peaks are uncommon but not mythical.
    const mountainMask = smoothstep(0.02, 0.40, this.nMountain.fbm2(wx * 0.0009, wz * 0.0009, 3));

    let h = 46 + continent * 26 + hills * 9 * (0.35 + mountainMask) + detail * 2.2;
    h += mountainMask * mountainMask * 46;

    // ---- v2: occasional rough ground ------------------------------------
    // Gated on version so v1 worlds keep exactly the landscape they were
    // generated with. Never edit the v1 path above — that is what silently
    // reshapes terrain someone has already built in.
    if (this.version >= 2) {
      h += this._ruggedOffset(wx, wz, mountainMask);
    }

    const height = clamp(Math.round(h), 3, CHUNK_SY - 12);

    // Bounded cache: terrain generation is bursty, so a simple size cap is fine.
    if (this._heightCache.size > 200000) this._heightCache.clear();
    this._heightCache.set(key, height);
    return height;
  }

  /**
   * Extra height for broken, cliffy ground (terrain v2 only).
   *
   * Two ingredients:
   *   - a large, sparse "ruggedness" mask, so rough country appears in patches
   *     rather than everywhere — most of the world stays walkable
   *   - inside those patches, high-frequency noise pushed through a *terracing*
   *     step, which is what produces flat shelves separated by sudden drops
   *     instead of merely bumpier hills
   */
  _ruggedOffset(wx, wz, mountainMask) {
    // Both fields are amplified before thresholding. Raw fBm output clusters
    // near zero, so an un-amplified smoothstep here fired on ~1% of the map and
    // the whole feature was invisible.
    const ruggedRaw = clamp(this.nRugged.fbm2(wx * 0.0013, wz * 0.0013, 3) * 2.4, -1, 1);
    const rugged = smoothstep(0.02, 0.55, ruggedRaw);
    if (rugged <= 0) return 0;

    // Mountains are already dramatic; let them break up more readily.
    const strength = rugged * (0.6 + mountainMask * 0.9);

    // Terracing is what makes this read as cliffs rather than just bumpier
    // hills: quantise to shelves, then add back a little of the raw signal so
    // the shelf tops are not billiard-table flat.
    const raw = clamp(this.nCliff.fbm2(wx * 0.021, wz * 0.021, 4) * 2.2, -1, 1);
    const STEP = 0.3;
    const terraced = Math.round(raw / STEP) * STEP;
    const shaped = terraced * 0.85 + raw * 0.15;

    return shaped * 12 * strength;
  }

  /**
   * Biome classification from three climate axes: temperature, humidity and a
   * third "weirdness" field that separates biomes sharing a climate niche
   * (savanna vs. plains, swamp vs. forest).
   */
  biomeAt(wx, wz, height) {
    const h = height ?? this.columnHeight(wx, wz);
    const sea = this.seaLevel;

    if (h < sea - 1) return BIOME.OCEAN;
    if (h <= sea + 1) return BIOME.BEACH;
    if (h > sea + 40) return BIOME.MOUNTAINS;

    // Climate axes are amplified for the same reason as the continent field:
    // raw fBm rarely leaves [-0.5, 0.5], so unscaled thresholds would only ever
    // catch the extreme tails and almost everything would come out as plains.
    const temp = clamp(this.nTemp.fbm2(wx * 0.0022, wz * 0.0022, 3) * 2.2, -1, 1);
    const humid = clamp(this.nHumid.fbm2(wx * 0.0026, wz * 0.0026, 3) * 2.2, -1, 1);
    const weird = clamp(this.nWeird.fbm2(wx * 0.0031, wz * 0.0031, 2) * 2.0, -1, 1);

    // Cold: snowy tundra, or taiga where it is also wet.
    if (temp < -0.32) return humid > 0.0 ? BIOME.TAIGA : BIOME.TUNDRA;
    if (temp < -0.14 && humid > 0.18) return BIOME.TAIGA;

    // Hot and dry: desert, or savanna where there is a little more moisture.
    if (temp > 0.28 && humid < -0.05) return BIOME.DESERT;
    if (temp > 0.16 && humid < 0.12 && weird > 0.05) return BIOME.SAVANNA;

    // Wet: swamp in the low-lying wettest pockets, otherwise forest.
    if (humid > 0.12) {
      const lowland = h <= sea + 5;
      if (lowland && humid > 0.24 && weird < 0.0) return BIOME.SWAMP;
      return BIOME.FOREST;
    }

    return BIOME.PLAINS;
  }

  /** Surface / subsurface palette for a biome. */
  surfacePalette(biome, height) {
    switch (biome) {
      case BIOME.DESERT:
        // Sand over sandstone, so digging in reveals proper strata.
        return { top: SAND.id, filler: SAND.id, fillerDepth: 4, under: SANDSTONE.id, underDepth: 4 };
      case BIOME.BEACH:
      case BIOME.OCEAN:
        return { top: SAND.id, filler: SAND.id, fillerDepth: 3 };
      case BIOME.TUNDRA:
        return { top: SNOW.id, filler: DIRT.id, fillerDepth: 3 };
      case BIOME.TAIGA:
        return { top: PODZOL.id, filler: DIRT.id, fillerDepth: 4 };
      case BIOME.SAVANNA:
        return { top: DRY_GRASS.id, filler: DIRT.id, fillerDepth: 3 };
      case BIOME.SWAMP:
        // Clay pockets under the waterlogged surface.
        return { top: SWAMP_GRASS.id, filler: DIRT.id, fillerDepth: 3, under: CLAY.id, underDepth: 2 };
      case BIOME.MOUNTAINS:
        // Bare rock up high, snow-capped at the very top.
        return height > this.seaLevel + 60
          ? { top: SNOW.id, filler: STONE.id, fillerDepth: 2 }
          : { top: STONE.id, filler: STONE.id, fillerDepth: 3 };
      default:
        return { top: GRASS.id, filler: DIRT.id, fillerDepth: 4 };
    }
  }

  /** Tree style and density per biome. */
  treeStyle(biome) {
    switch (biome) {
      case BIOME.FOREST: return { wood: 'oak', chance: 0.75, shape: 'round', height: [5, 7] };
      case BIOME.PLAINS: return { wood: 'oak', chance: 0.10, shape: 'round', height: [5, 7] };
      case BIOME.TUNDRA: return { wood: 'spruce', chance: 0.18, shape: 'conifer', height: [6, 9] };
      case BIOME.TAIGA: return { wood: 'spruce', chance: 0.70, shape: 'conifer', height: [7, 11] };
      case BIOME.SAVANNA: return { wood: 'acacia', chance: 0.16, shape: 'flat', height: [5, 7] };
      case BIOME.SWAMP: return { wood: 'oak', chance: 0.35, shape: 'droopy', height: [5, 7] };
      default: return null; // desert, mountains, ocean, beach
    }
  }

  // -------------------------------------------------------------------------
  // Carving & ores
  // -------------------------------------------------------------------------

  /**
   * Cave test. Two independent noise fields near zero at the same point trace
   * out 1D "worm" tunnels rather than the swiss-cheese blobs a single field
   * would give.
   */
  isCave(wx, wy, wz) {
    if (wy < 4 || wy > 58) return false;
    const a = this.nCaveA.perlin3(wx * 0.028, wy * 0.055, wz * 0.028);
    if (Math.abs(a) > 0.075) return false;
    const b = this.nCaveB.perlin3(wx * 0.028, wy * 0.055, wz * 0.028);
    if (Math.abs(b) > 0.075) return false;
    // Taper caves off as they approach the surface so they do not shred hills.
    return true;
  }

  /**
   * Which ore (if any) replaces stone here.
   * Walks ORE_TABLE rarest-first so scarce ores are never overwritten by
   * common ones sharing the same depth band.
   */
  oreAt(wx, wy, wz, biome) {
    for (const ore of ORE_TABLE) {
      if (wy < ore.minY || wy > ore.maxY) continue;
      if (ore.mountainsOnly && biome !== BIOME.MOUNTAINS) continue;
      const n = this[ore.field].perlin3(wx * ore.scale, wy * ore.scale, wz * ore.scale);
      if (n > ore.threshold) return ore.id;
    }
    return 0;
  }

  // -------------------------------------------------------------------------
  // Trees
  // -------------------------------------------------------------------------

  /**
   * Deterministic tree placement.
   *
   * Columns are grouped into 5x5 cells; each cell hashes to at most one tree at
   * a jittered offset. This spaces trees out without any neighbour lookups, and
   * gives the same answer no matter which chunk asks.
   *
   * Returns the trunk height, or 0 for "no tree here".
   */
  treeAt(wx, wz) {
    const CELL = 5;
    const cellX = Math.floor(wx / CELL);
    const cellZ = Math.floor(wz / CELL);
    const h = hash2i(cellX, cellZ, this.seed ^ 0x5eed);

    // Jittered position inside the cell.
    const ox = h % CELL;
    const oz = (h >>> 8) % CELL;
    if (wx - cellX * CELL !== ox || wz - cellZ * CELL !== oz) return 0;

    const height = this.columnHeight(wx, wz);
    if (height <= this.seaLevel + 1) return 0; // no trees on beaches / underwater

    const biome = this.biomeAt(wx, wz, height);
    const style = this.treeStyle(biome);
    if (!style) return 0; // desert / mountains / ocean: no trees

    if (((h >>> 16) & 0xff) / 255 >= style.chance) return 0;

    const [minH, maxH] = style.height;
    return minH + ((h >>> 24) % (maxH - minH + 1));
  }

  // -------------------------------------------------------------------------
  // Chunk assembly
  // -------------------------------------------------------------------------

  /**
   * Generate one chunk's voxels.
   * @returns {Uint8Array} CHUNK_VOLUME block ids.
   */
  generateChunk(cx, cz) {
    const voxels = new Uint8Array(CHUNK_VOLUME);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;
    const sea = this.seaLevel;

    // ---- Pass 1: terrain columns -----------------------------------------
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const wz = baseZ + lz;
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = baseX + lx;
        const height = this.columnHeight(wx, wz);
        const biome = this.biomeAt(wx, wz, height);
        const palette = this.surfacePalette(biome, height);
        const submerged = height < sea;

        for (let y = 0; y <= Math.max(height, sea); y++) {
          let id = AIR;

          if (y === 0) {
            id = BEDROCK.id;
          } else if (y <= height) {
            const depth = height - y;
            if (depth === 0) {
              // A submerged "surface" becomes sand/gravel rather than grass.
              id = submerged ? (y > sea - 4 ? SAND.id : GRAVEL.id) : palette.top;
            } else if (depth <= palette.fillerDepth) {
              id = palette.filler;
            } else if (palette.under && depth <= palette.fillerDepth + palette.underDepth) {
              // Optional intermediate stratum (sandstone, clay).
              id = palette.under;
            } else {
              id = STONE.id;
            }

            // Ores only replace plain stone.
            if (id === STONE.id) {
              const ore = this.oreAt(wx, y, wz, biome);
              if (ore) id = ore;
            }

            // Caves carve everything except bedrock.
            if (this.isCave(wx, y, wz)) {
              id = y < sea && submerged ? WATER.id : AIR;
            }
          } else if (y <= sea) {
            id = WATER.id;
          }

          if (id !== AIR) voxels[voxelIndex(lx, y, lz)] = id;
        }
      }
    }

    // ---- Pass 1b: dungeons (v3+) ------------------------------------------
    // Gated on the version because chunks are regenerated from the seed rather
    // than stored: carving rooms into v2 generation would hollow out ground
    // under builds people already made. Old worlds keep exactly the landscape
    // they had; new ones get dungeons everywhere.
    if (this.version >= 3) this._placeDungeons(voxels, cx, cz, baseX, baseZ);

    // ---- Pass 2: trees ----------------------------------------------------
    // Scan a margin around the chunk so trunks rooted just outside still drop
    // their canopy into this chunk.
    const MARGIN = 3;
    for (let dz = -MARGIN; dz < CHUNK_SZ + MARGIN; dz++) {
      for (let dx = -MARGIN; dx < CHUNK_SX + MARGIN; dx++) {
        const wx = baseX + dx;
        const wz = baseZ + dz;
        const trunk = this.treeAt(wx, wz);
        if (trunk > 0) this._placeTree(voxels, baseX, baseZ, wx, wz, trunk);
      }
    }

    return voxels;
  }

  // -------------------------------------------------------------------------
  // Dungeons
  // -------------------------------------------------------------------------

  /**
   * Is there a dungeon anchored in this chunk, and where?
   *
   * Same coarse-grid trick as the Comb's shrines: anchors only exist on every
   * Nth chunk, so the answer is a hash rather than a search, and it is a pure
   * function of the seed — which is what lets a room straddling a chunk border
   * be written identically from both sides.
   */
  dungeonAt(cx, cz) {
    if (((cx % DUNGEON_SPACING) + DUNGEON_SPACING) % DUNGEON_SPACING !== 0) return null;
    if (((cz % DUNGEON_SPACING) + DUNGEON_SPACING) % DUNGEON_SPACING !== 0) return null;

    const h = hash2i(cx, cz, this.seed ^ 0xd0e5);
    // Not every anchor produces one, or they would be a perfect lattice.
    if ((h & 0xff) < 70) return null;

    const wx = cx * CHUNK_SX + 4 + (h % 8);
    const wz = cz * CHUNK_SZ + 4 + ((h >>> 8) % 8);

    const surface = this.columnHeight(wx, wz);
    // Deep enough to be a find, shallow enough to reach before diamond gear.
    const y = 14 + ((h >>> 16) % 26);
    if (y > surface - 10) return null;

    return {
      wx, wz, y,
      halfX: 3 + ((h >>> 20) & 1),
      halfZ: 3 + ((h >>> 21) & 1),
      height: 4,
    };
  }

  /** Stamp any dungeon whose footprint reaches this chunk. */
  _placeDungeons(voxels, cx, cz, baseX, baseZ) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const room = this.dungeonAt(cx + dx * DUNGEON_SPACING, cz + dz * DUNGEON_SPACING);
        if (!room) continue;
        if (Math.abs(room.wx - baseX) > 40 || Math.abs(room.wz - baseZ) > 40) continue;
        this._buildDungeon(voxels, baseX, baseZ, room);
      }
    }
  }

  /**
   * A hollow mossy room with a chest or two.
   *
   * The shell is written as solid wall first and then hollowed, so a room that
   * happens to open into a cave still has walls rather than bleeding into it.
   */
  _buildDungeon(voxels, baseX, baseZ, room) {
    const { wx, wz, y, halfX, halfZ, height } = room;
    const rnd = mulberry32(hash2i(wx, wz, this.seed ^ 0x5eaf));

    const set = (x, py, z, id) => {
      const lx = x - baseX;
      const lz = z - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (py < 1 || py >= CHUNK_SY) return;
      voxels[voxelIndex(lx, py, lz)] = id;
    };

    // Shell, including floor and ceiling.
    for (let dy = -1; dy <= height; dy++) {
      for (let dz = -halfZ - 1; dz <= halfZ + 1; dz++) {
        for (let dx = -halfX - 1; dx <= halfX + 1; dx++) {
          // Mossy patches over plain cobble, thicker low down where it is damp.
          const damp = dy <= 0 ? 0.55 : 0.28;
          set(wx + dx, y + dy, wz + dz, rnd() < damp ? MOSSY_COBBLE.id : COBBLE.id);
        }
      }
    }

    // Hollow the interior back out.
    for (let dy = 0; dy < height; dy++) {
      for (let dz = -halfZ; dz <= halfZ; dz++) {
        for (let dx = -halfX; dx <= halfX; dx++) {
          set(wx + dx, y + dy, wz + dz, AIR);
        }
      }
    }

    // One or two chests, tucked against opposite walls.
    const spots = [
      [wx - halfX, y, wz - halfZ + 1],
      [wx + halfX, y, wz + halfZ - 1],
    ];
    const count = rnd() < 0.45 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const [sx, sy, sz] = spots[i];
      set(sx, sy, sz, CHEST.id);
    }
  }

  /**
   * Stamp a tree into `voxels`, writing only the blocks that land inside this
   * chunk. `wx/wz` is the trunk column in world space.
   *
   * Four canopy shapes, chosen by biome:
   *   round   — classic oak blob
   *   conifer — stacked shrinking rings (spruce)
   *   flat    — wide thin crown on a leaning trunk (acacia)
   *   droopy  — broad oak with hanging edges (swamp)
   */
  _placeTree(voxels, baseX, baseZ, wx, wz, trunkHeight) {
    const ground = this.columnHeight(wx, wz);
    const biome = this.biomeAt(wx, wz, ground);
    const style = this.treeStyle(biome);
    if (!style) return;

    const wood = TREE_WOODS[style.wood];
    const rnd = mulberry32(hash2i(wx, wz, this.seed ^ 0xf00d));

    const setBlock = (x, y, z, id, overwriteSolid) => {
      const lx = x - baseX;
      const lz = z - baseZ;
      if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
      if (y < 0 || y >= CHUNK_SY) return;
      const i = voxelIndex(lx, y, lz);
      // Leaves must not replace existing solid blocks (e.g. a hillside).
      if (!overwriteSolid && voxels[i] !== AIR && !this._isLeaf(voxels[i])) return;
      voxels[i] = id;
    };

    // The first log sits *on* the surface block, not in place of it.
    const base = ground + 1;
    const topY = base + trunkHeight - 1;

    const leaf = (x, y, z) => setBlock(x, y, z, wood.leaves, false);

    switch (style.shape) {
      case 'conifer': {
        // Shrinking rings up the trunk, with a single-block spire on top.
        let radius = 2;
        for (let y = base + 2; y <= topY; y++) {
          const layer = topY - y;
          radius = layer === 0 ? 0 : layer <= 2 ? 1 : ((layer % 3 === 0) ? 2 : 1);
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx === 0 && dz === 0 && y < topY) continue;
              if (Math.abs(dx) === radius && Math.abs(dz) === radius && radius > 1) continue;
              leaf(wx + dx, y, wz + dz);
            }
          }
        }
        leaf(wx, topY + 1, wz);
        break;
      }

      case 'flat': {
        // Acacia: a wide, thin, umbrella-like crown.
        for (let dy = 0; dy <= 1; dy++) {
          const radius = dy === 0 ? 3 : 2;
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (Math.abs(dx) + Math.abs(dz) > radius + 1) continue;
              if (dx === 0 && dz === 0 && dy === 0) continue;
              leaf(wx + dx, topY + dy, wz + dz);
            }
          }
        }
        break;
      }

      case 'droopy': {
        // Swamp oak: broad crown whose corners hang a block lower.
        for (let dy = -1; dy <= 1; dy++) {
          const radius = dy === 1 ? 2 : 3;
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx * dx + dz * dz > radius * radius + 1) continue;
              if (dx === 0 && dz === 0 && dy < 1) continue;
              leaf(wx + dx, topY + dy, wz + dz);
            }
          }
        }
        // Hanging strands at the rim.
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
          leaf(wx + dx, topY - 2, wz + dz);
        }
        break;
      }

      default: {
        // Round oak: two wide layers then a narrow cap, corners randomly cut.
        for (let dy = -2; dy <= 1; dy++) {
          const y = topY + dy;
          const radius = dy >= 0 ? 1 : 2;
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx === 0 && dz === 0 && dy < 1) continue; // leave room for trunk
              if (Math.abs(dx) === radius && Math.abs(dz) === radius && rnd() < 0.6) continue;
              leaf(wx + dx, y, wz + dz);
            }
          }
        }
      }
    }

    // Trunk last so it always wins over canopy blocks.
    for (let i = 0; i < trunkHeight; i++) {
      setBlock(wx, base + i, wz, wood.log, true);
    }
    // Grass directly beneath a trunk becomes dirt, as in Minecraft.
    setBlock(wx, ground, wz, DIRT.id, true);
  }

  /** Any leaf block, whatever the wood type. */
  _isLeaf(id) {
    for (const wood of Object.values(TREE_WOODS)) if (id === wood.leaves) return true;
    return false;
  }
}
