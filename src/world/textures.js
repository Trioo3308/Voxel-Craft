/**
 * textures.js — Procedural texture atlas.
 *
 * Every block texture is painted pixel-by-pixel into one 256x256 canvas
 * (a 16x16 grid of 16px tiles) at startup. No image files to ship, and the
 * whole world renders from a single texture + single draw call per chunk.
 *
 * To add a texture: add a tile id in blocks.js, then a painter in `PAINTERS`.
 */

import * as THREE from 'three';
import {
  TILE, ATLAS_COLS, ATLAS_TILE_PX,
  TOOL_KINDS, ARMOR_PIECES, GEAR_MATERIALS, ARMOR_MATERIAL_NAMES,
  TOOL_MATERIALS, toolTile, armorTile,
} from './blocks.js';
import { mulberry32 } from './noise.js';

const ATLAS_PX = ATLAS_COLS * ATLAS_TILE_PX;
const T = ATLAS_TILE_PX;

// ---------------------------------------------------------------------------
// Painting helpers
// ---------------------------------------------------------------------------

/** Clamp to a byte. */
const b = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * Paint one tile. The callback receives:
 *   set(x, y, r, g, b, a)  — write a pixel (a defaults to opaque)
 *   rnd()                  — deterministic 0..1 random for this tile
 */
function paint(ctx, tile, fn) {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  const img = ctx.createImageData(T, T); // starts fully transparent
  const rnd = mulberry32(0x9e3779b9 ^ (tile * 7919));
  const data = img.data;

  const set = (x, y, r, g, bl, a = 255) => {
    if (x < 0 || x >= T || y < 0 || y >= T) return;
    const i = (y * T + x) * 4;
    data[i] = b(r);
    data[i + 1] = b(g);
    data[i + 2] = b(bl);
    data[i + 3] = b(a);
  };

  fn(set, rnd);
  ctx.putImageData(img, col * T, row * T);
}

/** Fill a tile with a base colour plus per-pixel brightness noise. */
function noiseFill(set, rnd, [r, g, bl], variance, alpha = 255) {
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 2 * variance;
      set(x, y, r + d, g + d, bl + d, alpha);
    }
  }
}

/** Scatter chunky speckles over an existing fill. */
function speckle(set, rnd, [r, g, bl], count, size = 1) {
  for (let i = 0; i < count; i++) {
    const x = (rnd() * T) | 0;
    const y = (rnd() * T) | 0;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) set(x + dx, y + dy, r, g, bl);
    }
  }
}

// ---------------------------------------------------------------------------
// Tile painters
// ---------------------------------------------------------------------------

const GRASS_GREEN = [92, 148, 62];
const DIRT_BROWN = [134, 96, 67];
const STONE_GREY = [127, 127, 127];

/** Stone background with a scatter of mineral blobs — every ore shares this. */
function orePainter(set, rnd, [r, g, b], blobs = 5) {
  noiseFill(set, rnd, STONE_GREY, 14);
  for (let i = 0; i < blobs; i++) {
    const x = 1 + ((rnd() * (T - 4)) | 0);
    const y = 1 + ((rnd() * (T - 4)) | 0);
    const size = 2 + ((rnd() * 2) | 0);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const d = (rnd() - 0.5) * 18;
        set(x + dx, y + dy, r + d, g + d, b + d);
      }
    }
  }
}

/** Grass-topped dirt with a ragged fringe — used by every grass variant. */
function grassSidePainter(set, rnd, top) {
  noiseFill(set, rnd, DIRT_BROWN, 16);
  speckle(set, rnd, [110, 78, 54], 14);
  for (let x = 0; x < T; x++) {
    const depth = 3 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.2 ? 1 : 0);
    for (let y = 0; y < depth; y++) {
      const d = (rnd() - 0.5) * 26;
      set(x, y, top[0] + d, top[1] + d, top[2] + d);
    }
  }
}

/** Vertical bark grain, tinted per wood type. */
function logSidePainter(set, rnd, [r, g, b], grooveShade = -30) {
  for (let x = 0; x < T; x++) {
    const columnTone = (rnd() - 0.5) * 26;
    for (let y = 0; y < T; y++) {
      const d = columnTone + (rnd() - 0.5) * 10;
      set(x, y, r + d, g + d, b + d);
    }
  }
  for (let i = 0; i < 3; i++) {
    const x = (rnd() * T) | 0;
    for (let y = 0; y < T; y++) set(x, y, r + grooveShade, g + grooveShade, b + grooveShade);
  }
}

/** Concentric growth rings for a log's end grain. */
function logTopPainter(set, rnd, [r, g, b]) {
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const ring = Math.sin(Math.hypot(x - 7.5, y - 7.5) * 2.1) * 12;
      const d = ring + (rnd() - 0.5) * 8;
      set(x, y, r + d, g + d, b + d);
    }
  }
}

/** Leaf canopy with punched holes for the cutout material. */
function leavesPainter(set, rnd, [r, g, b], holeChance = 0.2) {
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      if (rnd() < holeChance) continue;
      const d = (rnd() - 0.5) * 44;
      set(x, y, r + d, g + d, b + d);
    }
  }
}

/** Faceted gem icon (diamond, lapis, emerald) or a rough lump (coal). */
function gemPainter(set, rnd, [r, g, b], rough = false) {
  // Half-width of the gem at each row from y=4 to y=11.
  const widths = [1, 2, 3, 4, 4, 3, 2, 1];
  for (let i = 0; i < widths.length; i++) {
    const y = 4 + i;
    const w = widths[i];
    for (let x = 8 - w; x <= 7 + w; x++) {
      if (rough && rnd() < 0.18) continue; // coal gets a ragged edge
      // Light from the upper left.
      const lit = (x < 8 ? 26 : -18) + (i < 4 ? 20 : -22);
      const d = lit + (rnd() - 0.5) * 16;
      set(x, y, r + d, g + d, b + d);
    }
  }
}

/** Ingot icon: a squat trapezoidal bar. */
function ingotPainter(set, rnd, [r, g, b]) {
  for (let y = 6; y <= 10; y++) {
    const inset = y <= 7 ? 4 : 3; // narrower at the top, like a cast bar
    for (let x = inset; x < T - inset; x++) {
      const lit = y <= 7 ? 26 : y >= 10 ? -30 : 0;
      const d = lit + (rnd() - 0.5) * 12;
      set(x, y, r + d, g + d, b + d);
    }
  }
}

/**
 * Paint a 16x16 ASCII sprite.
 *   '.' transparent   'm' material   'l' highlight   'd' shadow   'h' wood handle
 * Rows shorter than 16 are padded, so the maps below stay easy to edit.
 */
function drawSprite(set, rows, base) {
  const [r, g, b] = base;
  const palette = {
    m: [r, g, b],
    l: [r + 42, g + 42, b + 42],
    d: [r - 48, g - 48, b - 48],
    h: [138, 104, 58],
  };
  for (let y = 0; y < Math.min(rows.length, T); y++) {
    const row = rows[y];
    for (let x = 0; x < Math.min(row.length, T); x++) {
      const c = palette[row[x]];
      if (c) set(x, y, c[0], c[1], c[2]);
    }
  }
}

/** A solid metal/gem block: flat colour, bevelled highlight and shadow. */
function solidBlockPainter(set, rnd, [r, g, b]) {
  noiseFill(set, rnd, [r, g, b], 10);
  for (let i = 0; i < T; i++) {
    set(i, 0, r + 34, g + 34, b + 34);          // top highlight
    set(0, i, r + 22, g + 22, b + 22);          // left highlight
    set(i, T - 1, r - 34, g - 34, b - 34);      // bottom shadow
    set(T - 1, i, r - 22, g - 22, b - 22);      // right shadow
  }
}

const PAINTERS = {
  [TILE.GRASS_TOP]: (set, rnd) => {
    noiseFill(set, rnd, GRASS_GREEN, 16);
    speckle(set, rnd, [72, 122, 48], 18);
    speckle(set, rnd, [112, 168, 78], 14);
  },

  [TILE.GRASS_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, DIRT_BROWN, 16);
    speckle(set, rnd, [110, 78, 54], 14);
    // Ragged grass fringe along the top edge.
    for (let x = 0; x < T; x++) {
      const depth = 3 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.2 ? 1 : 0);
      for (let y = 0; y < depth; y++) {
        const d = (rnd() - 0.5) * 26;
        set(x, y, GRASS_GREEN[0] + d, GRASS_GREEN[1] + d, GRASS_GREEN[2] + d);
      }
    }
  },

  [TILE.DIRT]: (set, rnd) => {
    noiseFill(set, rnd, DIRT_BROWN, 18);
    speckle(set, rnd, [108, 76, 52], 20);
    speckle(set, rnd, [152, 114, 82], 12);
  },

  [TILE.STONE]: (set, rnd) => {
    noiseFill(set, rnd, STONE_GREY, 14);
    speckle(set, rnd, [104, 104, 104], 16, 2);
  },

  [TILE.COBBLE]: (set, rnd) => {
    noiseFill(set, rnd, [110, 110, 110], 10);
    // Irregular stones separated by darker mortar.
    const cells = [
      [0, 0, 7, 7], [8, 0, 7, 4], [8, 5, 7, 6],
      [0, 8, 4, 7], [5, 8, 4, 7], [10, 12, 5, 3],
      [0, 0, 15, 0],
    ];
    for (const [cx, cy, cw, ch] of cells) {
      const tone = 118 + (rnd() - 0.5) * 40;
      for (let y = cy; y < cy + ch && y < T; y++) {
        for (let x = cx; x < cx + cw && x < T; x++) {
          const d = (rnd() - 0.5) * 18;
          set(x, y, tone + d, tone + d, tone + d);
        }
      }
    }
  },

  [TILE.SAND]: (set, rnd) => {
    noiseFill(set, rnd, [219, 205, 158], 12);
    speckle(set, rnd, [198, 182, 136], 22);
  },

  [TILE.GRAVEL]: (set, rnd) => {
    // Chunky 2x2 pebbles rather than per-pixel noise.
    for (let y = 0; y < T; y += 2) {
      for (let x = 0; x < T; x += 2) {
        const d = (rnd() - 0.5) * 60;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) set(x + dx, y + dy, 136 + d, 131 + d, 124 + d);
        }
      }
    }
  },

  [TILE.LOG_SIDE]: (set, rnd) => {
    for (let x = 0; x < T; x++) {
      // Per-column tone gives the vertical bark grain.
      const columnTone = (rnd() - 0.5) * 26;
      for (let y = 0; y < T; y++) {
        const d = columnTone + (rnd() - 0.5) * 10;
        set(x, y, 104 + d, 82 + d, 50 + d);
      }
    }
    // A few deep grooves.
    for (let i = 0; i < 3; i++) {
      const x = (rnd() * T) | 0;
      for (let y = 0; y < T; y++) set(x, y, 74, 56, 32);
    }
  },

  [TILE.LOG_TOP]: (set, rnd) => {
    const cx = 7.5, cy = 7.5;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        // Concentric growth rings.
        const ring = Math.sin(dist * 2.1) * 12;
        const d = ring + (rnd() - 0.5) * 8;
        set(x, y, 162 + d, 132 + d, 84 + d);
      }
    }
  },

  [TILE.LEAVES]: (set, rnd) => {
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        // Punch holes so the cutout material shows sky through the canopy.
        if (rnd() < 0.20) continue;
        const d = (rnd() - 0.5) * 44;
        set(x, y, 58 + d, 122 + d, 44 + d);
      }
    }
  },

  [TILE.PLANKS]: (set, rnd) => {
    for (let plank = 0; plank < 4; plank++) {
      const tone = (rnd() - 0.5) * 22;
      for (let y = plank * 4; y < plank * 4 + 4; y++) {
        for (let x = 0; x < T; x++) {
          const seam = y === plank * 4 ? -34 : 0; // dark line between planks
          const d = tone + seam + (rnd() - 0.5) * 12;
          set(x, y, 166 + d, 133 + d, 80 + d);
        }
      }
      // Nail / knot detail.
      const knot = (rnd() * T) | 0;
      set(knot, plank * 4 + 2, 120, 92, 52);
    }
  },

  [TILE.WATER]: (set, rnd) => {
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const wave = Math.sin((x + y) * 0.7) * 10;
        const d = wave + (rnd() - 0.5) * 12;
        set(x, y, 52 + d, 108 + d, 198 + d, 190); // alpha-blended
      }
    }
  },

  [TILE.LAVA]: (set, rnd) => {
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        // Overlapping waves give a molten, blotchy look.
        const flow = Math.sin(x * 0.8 + y * 0.35) * 18 + Math.sin(y * 0.6) * 12;
        const d = flow + (rnd() - 0.5) * 26;
        set(x, y, 226 + d, 92 + d * 0.7, 24 + d * 0.25);
      }
    }
    // A few bright hot spots and dark crust patches.
    speckle(set, rnd, [255, 208, 92], 10, 2);
    speckle(set, rnd, [136, 40, 12], 8, 2);
  },

  [TILE.BEDROCK]: (set, rnd) => {
    for (let y = 0; y < T; y += 2) {
      for (let x = 0; x < T; x += 2) {
        const d = (rnd() - 0.5) * 90;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) set(x + dx, y + dy, 86 + d, 86 + d, 90 + d);
        }
      }
    }
  },

  [TILE.COAL_ORE]:    (set, rnd) => orePainter(set, rnd, [34, 34, 36]),
  [TILE.IRON_ORE]:    (set, rnd) => orePainter(set, rnd, [205, 162, 128]),
  [TILE.GOLD_ORE]:    (set, rnd) => orePainter(set, rnd, [244, 205, 74]),
  [TILE.REDSTONE_ORE]:(set, rnd) => orePainter(set, rnd, [214, 44, 38], 7),
  [TILE.LAPIS_ORE]:   (set, rnd) => orePainter(set, rnd, [40, 78, 190]),
  [TILE.DIAMOND_ORE]: (set, rnd) => orePainter(set, rnd, [90, 232, 222]),
  [TILE.EMERALD_ORE]: (set, rnd) => orePainter(set, rnd, [52, 204, 92]),

  [TILE.GLASS]: (set, rnd) => {
    // Transparent middle, bright frame — works with alphaTest, no sorting needed.
    for (let i = 0; i < T; i++) {
      set(i, 0, 214, 234, 240, 235);
      set(i, T - 1, 214, 234, 240, 235);
      set(0, i, 214, 234, 240, 235);
      set(T - 1, i, 214, 234, 240, 235);
    }
    // Diagonal glint.
    for (let i = 3; i < 8; i++) set(i, 11 - i + 3, 255, 255, 255, 200);
    for (let i = 9; i < 13; i++) set(i, 20 - i + 3, 255, 255, 255, 160);
  },

  [TILE.SNOW_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [242, 246, 252], 9);
    speckle(set, rnd, [226, 232, 244], 12);
  },

  [TILE.SNOW_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, DIRT_BROWN, 16);
    for (let x = 0; x < T; x++) {
      const depth = 3 + (rnd() < 0.5 ? 1 : 0);
      for (let y = 0; y < depth; y++) {
        const d = (rnd() - 0.5) * 12;
        set(x, y, 242 + d, 246 + d, 252 + d);
      }
    }
  },

  [TILE.BRICK]: (set, rnd) => {
    noiseFill(set, rnd, [204, 196, 186], 6); // mortar
    for (let row = 0; row < 4; row++) {
      const offset = row % 2 === 0 ? 0 : 4;
      for (let brick = -1; brick < 2; brick++) {
        const bx = offset + brick * 8;
        for (let y = row * 4; y < row * 4 + 3; y++) {
          for (let x = bx; x < bx + 7; x++) {
            if (x < 0 || x >= T) continue;
            const d = (rnd() - 0.5) * 20;
            set(x, y, 154 + d, 82 + d, 64 + d);
          }
        }
      }
    }
  },

  // --- Item icons (transparent background) ---------------------------------

  [TILE.PORKCHOP]: (set, rnd) => {
    for (let y = 4; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        const dist = Math.hypot(x - 8, y - 8.5);
        if (dist > 4.6) continue;
        const d = (rnd() - 0.5) * 22;
        set(x, y, 232 + d, 150 + d, 148 + d);
      }
    }
    // Bone.
    for (let x = 2; x < 6; x++) set(x, 8, 240, 238, 226);
    set(2, 7, 240, 238, 226);
    set(2, 9, 240, 238, 226);
  },

  [TILE.ROTTEN_FLESH]: (set, rnd) => {
    for (let y = 4; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        if (rnd() < 0.12) continue; // ragged edges
        const dist = Math.hypot(x - 8, y - 8.5);
        if (dist > 4.8) continue;
        const d = (rnd() - 0.5) * 30;
        set(x, y, 138 + d, 108 + d, 74 + d);
      }
    }
  },

  [TILE.STICK]: (set, rnd) => {
    for (let i = 0; i < 10; i++) {
      const d = (rnd() - 0.5) * 20;
      set(4 + Math.floor(i * 0.6), 13 - i, 138 + d, 104 + d, 58 + d);
      set(5 + Math.floor(i * 0.6), 13 - i, 118 + d, 88 + d, 48 + d);
    }
  },

  // --- Crafting stations & storage blocks ---------------------------------

  [TILE.CRAFTING_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [142, 110, 66], 12);
    // 3x3 grid engraved into the surface.
    for (let i = 0; i <= T; i += 5) {
      for (let j = 0; j < T; j++) {
        set(i, j, 96, 72, 42);
        set(j, i, 96, 72, 42);
      }
    }
  },

  [TILE.CRAFTING_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, [150, 118, 72], 14);
    // Tool silhouettes on the side, like the real block.
    for (let y = 3; y < 13; y++) set(4, y, 96, 72, 42);
    for (let x = 3; x < 7; x++) set(x, 3, 96, 72, 42);
    for (let y = 5; y < 13; y++) set(11, y, 96, 72, 42);
    for (let x = 9; x < 13; x++) set(x, 5, 96, 72, 42);
  },

  [TILE.CRAFTING_FRONT]: (set, rnd) => {
    noiseFill(set, rnd, [150, 118, 72], 14);
    for (let i = 2; i < 14; i++) { set(i, 2, 96, 72, 42); set(i, 13, 96, 72, 42); }
    for (let i = 2; i < 14; i++) { set(2, i, 96, 72, 42); set(13, i, 96, 72, 42); }
  },

  [TILE.FURNACE_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [110, 110, 112], 14);
    speckle(set, rnd, [92, 92, 94], 16, 2);
  },

  [TILE.FURNACE_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, [110, 110, 112], 12);
    for (let i = 0; i < T; i++) { set(i, 0, 132, 132, 134); set(i, T - 1, 84, 84, 86); }
  },

  [TILE.FURNACE_FRONT]: (set, rnd) => {
    noiseFill(set, rnd, [110, 110, 112], 12);
    // Cold, dark mouth.
    for (let y = 6; y < 13; y++) for (let x = 3; x < 13; x++) set(x, y, 46, 44, 44);
    for (let x = 3; x < 13; x++) set(x, 5, 78, 78, 80);
  },

  [TILE.FURNACE_LIT]: (set, rnd) => {
    noiseFill(set, rnd, [110, 110, 112], 12);
    for (let y = 6; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        // Fire glows brighter toward the bottom of the opening.
        const heat = (y - 5) / 7;
        const d = (rnd() - 0.5) * 40;
        set(x, y, 90 + heat * 170 + d, 40 + heat * 110 + d, 20 + heat * 20 + d);
      }
    }
    for (let x = 3; x < 13; x++) set(x, 5, 78, 78, 80);
  },

  [TILE.IRON_BLOCK]:    (set, rnd) => solidBlockPainter(set, rnd, [214, 214, 214]),
  [TILE.GOLD_BLOCK]:    (set, rnd) => solidBlockPainter(set, rnd, [246, 212, 76]),
  [TILE.DIAMOND_BLOCK]: (set, rnd) => solidBlockPainter(set, rnd, [96, 226, 220]),

  // --- Biome blocks --------------------------------------------------------

  [TILE.ACACIA_LOG_SIDE]: (set, rnd) => logSidePainter(set, rnd, [118, 72, 44]),
  [TILE.ACACIA_LOG_TOP]:  (set, rnd) => logTopPainter(set, rnd, [178, 108, 62]),
  [TILE.ACACIA_LEAVES]:   (set, rnd) => leavesPainter(set, rnd, [104, 142, 44], 0.24),

  [TILE.SPRUCE_LOG_SIDE]: (set, rnd) => logSidePainter(set, rnd, [72, 52, 32]),
  [TILE.SPRUCE_LOG_TOP]:  (set, rnd) => logTopPainter(set, rnd, [126, 100, 62]),
  [TILE.SPRUCE_LEAVES]:   (set, rnd) => leavesPainter(set, rnd, [38, 82, 52], 0.16),

  [TILE.DRY_GRASS_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [176, 168, 82], 18);
    speckle(set, rnd, [150, 142, 62], 18);
    speckle(set, rnd, [198, 190, 108], 12);
  },
  [TILE.DRY_GRASS_SIDE]: (set, rnd) => grassSidePainter(set, rnd, [176, 168, 82]),

  [TILE.PODZOL_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [92, 66, 34], 20);
    speckle(set, rnd, [130, 96, 48], 22);
    speckle(set, rnd, [64, 44, 22], 14);
  },
  [TILE.PODZOL_SIDE]: (set, rnd) => grassSidePainter(set, rnd, [92, 66, 34]),

  [TILE.SWAMP_GRASS_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [82, 108, 62], 16);
    speckle(set, rnd, [62, 88, 46], 20);
    speckle(set, rnd, [100, 124, 70], 10);
  },
  [TILE.SWAMP_GRASS_SIDE]: (set, rnd) => grassSidePainter(set, rnd, [82, 108, 62]),

  [TILE.CLAY]: (set, rnd) => {
    noiseFill(set, rnd, [160, 166, 178], 10);
    speckle(set, rnd, [142, 148, 162], 16, 2);
  },

  [TILE.SANDSTONE_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [222, 208, 158], 8);
    speckle(set, rnd, [206, 192, 142], 14);
  },

  [TILE.SANDSTONE_SIDE]: (set, rnd) => {
    // Horizontal sedimentary banding.
    for (let y = 0; y < T; y++) {
      const band = Math.sin(y * 0.9) * 8;
      for (let x = 0; x < T; x++) {
        const d = band + (rnd() - 0.5) * 10;
        set(x, y, 218 + d, 204 + d, 154 + d);
      }
    }
    for (let x = 0; x < T; x++) { set(x, 0, 234, 222, 176); set(x, 12, 196, 182, 134); }
  },

  // --- Material item icons -------------------------------------------------

  [TILE.COAL_ITEM]:     (set, rnd) => gemPainter(set, rnd, [42, 42, 44], true),
  [TILE.DIAMOND_GEM]:   (set, rnd) => gemPainter(set, rnd, [96, 232, 224]),
  [TILE.LAPIS_GEM]:     (set, rnd) => gemPainter(set, rnd, [46, 86, 200]),
  [TILE.EMERALD_GEM]:   (set, rnd) => gemPainter(set, rnd, [56, 210, 96]),
  [TILE.IRON_INGOT]:    (set, rnd) => ingotPainter(set, rnd, [222, 222, 226]),
  [TILE.GOLD_INGOT]:    (set, rnd) => ingotPainter(set, rnd, [248, 214, 78]),

  [TILE.COOKED_PORKCHOP]: (set, rnd) => {
    // Same silhouette as the raw cut, browned.
    for (let y = 4; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        if (Math.hypot(x - 8, y - 8.5) > 4.6) continue;
        const d = (rnd() - 0.5) * 24;
        set(x, y, 186 + d, 116 + d, 62 + d);
      }
    }
    for (let x = 2; x < 6; x++) set(x, 8, 240, 238, 226);
    set(2, 7, 240, 238, 226);
    set(2, 9, 240, 238, 226);
  },

  [TILE.REDSTONE_DUST]: (set, rnd) => {
    // Scattered glowing dust rather than a solid shape.
    for (let i = 0; i < 40; i++) {
      const x = 3 + ((rnd() * 10) | 0);
      const y = 3 + ((rnd() * 10) | 0);
      const d = (rnd() - 0.5) * 60;
      set(x, y, 210 + d, 30 + d * 0.4, 30 + d * 0.4);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool & armour sprites
// ---------------------------------------------------------------------------
// One shape per tool/armour kind, recoloured per material. That keeps 35 icons
// down to 8 hand-drawn maps.

const TOOL_SPRITES = {
  pickaxe: [
    '................',
    '.....mmmmmm.....',
    '...mmllllllmm...',
    '..mm..dddd..mm..',
    '..m....hh....m..',
    '.......hh.......',
    '......hh........',
    '......hh........',
    '.....hh.........',
    '.....hh.........',
    '....hh..........',
    '....hh..........',
    '...hh...........',
    '...hh...........',
    '..hh............',
    '................',
  ],
  axe: [
    '................',
    '....mmmm........',
    '...mllllm.......',
    '..mllllllm......',
    '..mllllldhh.....',
    '..mlllld.hh.....',
    '..mllld.hh......',
    '...mdd..hh......',
    '......hh........',
    '......hh........',
    '.....hh.........',
    '.....hh.........',
    '....hh..........',
    '....hh..........',
    '...hh...........',
    '................',
  ],
  shovel: [
    '................',
    '......mmm.......',
    '.....mlllm......',
    '.....mlllm......',
    '.....mlllm......',
    '.....mdddm......',
    '......hh........',
    '......hh........',
    '.....hh.........',
    '.....hh.........',
    '....hh..........',
    '....hh..........',
    '...hh...........',
    '...hh...........',
    '..hh............',
    '................',
  ],
  sword: [
    '................',
    '..........mmm...',
    '.........mllm...',
    '........mllm....',
    '.......mllm.....',
    '......mllm......',
    '.....mllm.......',
    '....mllm........',
    '...dmmd.........',
    '..d.hh.d........',
    '....hh..........',
    '...hh...........',
    '...hh...........',
    '..hh............',
    '................',
    '................',
  ],
};

const ARMOR_SPRITES = {
  helmet: [
    '................',
    '................',
    '................',
    '....mmmmmmmm....',
    '...mllllllllm...',
    '..mllllllllllm..',
    '..mll......llm..',
    '..mll......llm..',
    '..mll......llm..',
    '..mdd......ddm..',
    '..mmm......mmm..',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  chestplate: [
    '................',
    '................',
    '..mmm......mmm..',
    '.mlllmmmmmmlllm.',
    '.mllllllllllllm.',
    '.mllllllllllllm.',
    '..mllllllllllm..',
    '..mllllllllllm..',
    '..mllllllllllm..',
    '..mddddddddddm..',
    '...mmmmmmmmmm...',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  leggings: [
    '................',
    '................',
    '..mmmmmmmmmmmm..',
    '..mllllllllllm..',
    '..mllllllllllm..',
    '..mlll....lllm..',
    '..mll......llm..',
    '..mll......llm..',
    '..mll......llm..',
    '..mdd......ddm..',
    '..mmm......mmm..',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  boots: [
    '................',
    '................',
    '................',
    '................',
    '..mmm......mmm..',
    '..mll......llm..',
    '..mll......llm..',
    '..mlll....lllm..',
    '.mlllll..llllm..',
    '.mdddddddddddm..',
    '.mmmmmmmmmmmmm..',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
};

/** Turn a packed 0xRRGGBB into an [r, g, b] triple. */
function unpack(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

// Register the generated icons alongside the hand-written painters.
for (const kind of TOOL_KINDS) {
  for (const material of GEAR_MATERIALS) {
    const color = unpack(TOOL_MATERIALS[material].color);
    PAINTERS[toolTile(kind, material)] = (set) => drawSprite(set, TOOL_SPRITES[kind], color);
  }
}

for (const piece of ARMOR_PIECES) {
  for (const material of ARMOR_MATERIAL_NAMES) {
    const color = unpack(TOOL_MATERIALS[material].color);
    PAINTERS[armorTile(piece, material)] = (set) => drawSprite(set, ARMOR_SPRITES[piece], color);
  }
}

// ---------------------------------------------------------------------------
// Atlas construction
// ---------------------------------------------------------------------------

let atlasCanvas = null;
let atlasTexture = null;
const iconCache = new Map();

/** Build (once) and return the shared block atlas texture. */
export function getAtlasTexture() {
  if (atlasTexture) return atlasTexture;

  atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = ATLAS_PX;
  atlasCanvas.height = ATLAS_PX;
  const ctx = atlasCanvas.getContext('2d', { willReadFrequently: true });

  for (const key of Object.keys(PAINTERS)) {
    paint(ctx, Number(key), PAINTERS[key]);
  }

  atlasTexture = new THREE.CanvasTexture(atlasCanvas);
  // Nearest filtering with no mipmaps: crisp pixel-art look, and — importantly —
  // no chance of neighbouring atlas tiles bleeding into each other at distance.
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.needsUpdate = true;

  return atlasTexture;
}

/**
 * A single tile blown up to `size` px, as a data URL.
 * Used for hotbar / inventory icons in the DOM-based HUD.
 */
export function getTileDataURL(tile, size = 48) {
  const key = tile + ':' + size;
  const cached = iconCache.get(key);
  if (cached) return cached;

  getAtlasTexture(); // make sure the atlas exists

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false; // keep it pixelated when scaled up

  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  ctx.drawImage(atlasCanvas, col * T, row * T, T, T, 0, 0, size, size);

  const url = canvas.toDataURL();
  iconCache.set(key, url);
  return url;
}
