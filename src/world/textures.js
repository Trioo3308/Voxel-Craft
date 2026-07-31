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

/** A cut of meat: rounded body in `base`, marbled with `fat`. */
function meatPainter(set, rnd, base, fat) {
  for (let y = 3; y < 13; y++) {
    for (let x = 3; x < 13; x++) {
      // Squashed circle so it reads as a cut rather than a ball.
      const dx = (x - 8) / 5;
      const dy = (y - 8) / 4.6;
      if (dx * dx + dy * dy > 1) continue;
      const marble = rnd() < 0.18;
      const c = marble ? fat : base;
      const d = (rnd() - 0.5) * 20;
      set(x, y, c[0] + d, c[1] + d, c[2] + d);
    }
  }
}

/** Bucket icon. `fill` null draws it empty; otherwise it holds that colour. */
function bucketPainter(set, rnd, fill) {
  const metal = [176, 178, 184];
  // Tapered pail: wider at the rim.
  for (let y = 4; y < 14; y++) {
    const inset = 3 + Math.floor((y - 4) / 5);
    for (let x = inset; x < T - inset; x++) {
      const edge = x === inset || x === T - inset - 1 || y === 13;
      const d = (rnd() - 0.5) * 14;
      if (edge) set(x, y, metal[0] - 40 + d, metal[1] - 40 + d, metal[2] - 40 + d);
      else if (fill && y > 6) set(x, y, fill[0] + d, fill[1] + d, fill[2] + d);
      else set(x, y, metal[0] + d, metal[1] + d, metal[2] + d);
    }
  }
  // Rim and handle.
  for (let x = 3; x < T - 3; x++) set(x, 4, 214, 216, 222);
  if (fill) for (let x = 4; x < T - 4; x++) set(x, 6, fill[0] + 24, fill[1] + 24, fill[2] + 24);
  set(3, 3, 200, 202, 208);
  set(12, 3, 200, 202, 208);
  for (let x = 4; x < 12; x++) set(x, 2, 200, 202, 208);
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

/**
 * The furnace's arched mouth, shared by the lit and unlit fronts so they line
 * up exactly. `lit` null draws a cold cavity; true fills it with fire.
 */
function furnaceMouth(set, rnd, lit) {
  // Half-width of the opening per row — narrower at the top makes the arch.
  const rows = [
    { y: 4, half: 3 },
    { y: 5, half: 4 },
    { y: 6, half: 5 },
    { y: 7, half: 5 },
    { y: 8, half: 5 },
    { y: 9, half: 5 },
    { y: 10, half: 5 },
    { y: 11, half: 5 },
    { y: 12, half: 5 },
  ];

  for (const { y, half } of rows) {
    for (let x = 8 - half; x <= 7 + half; x++) {
      if (!lit) {
        // Dark cavity, slightly lighter at the very bottom (ash).
        const d = (rnd() - 0.5) * 8;
        const base = y >= 12 ? 44 : 22;
        set(x, y, base + d, base - 2 + d, base - 4 + d);
      } else {
        // Fire is hottest low and toward the centre.
        const heat = ((y - 3) / 9) * (1 - Math.abs(x - 7.5) / 8);
        const d = (rnd() - 0.5) * 46;
        set(x, y, 120 + heat * 150 + d, 44 + heat * 130 + d, 18 + heat * 40 + d);
      }
    }
  }

  // Bright metal lip around the arch so it reads as a frame, not a hole.
  const lip = lit ? [176, 150, 128] : [122, 120, 126];
  for (const { y, half } of rows) {
    set(8 - half - 1, y, lip[0], lip[1], lip[2]);
    set(8 + half, y, lip[0], lip[1], lip[2]);
  }
  for (let x = 4; x <= 11; x++) set(x, 3, lip[0], lip[1], lip[2]);
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

/**
 * One painter per tile: `(set, rnd) => void`, where `set(x, y, r, g, b)` writes
 * a pixel. Exported so a tile can be inspected without building the atlas —
 * which is how the shape-vs-texture agreement is checked (a partial block crops
 * its tile, so art outside that window silently never renders).
 */
export const PAINTERS = {
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

  // A furnace should never be mistaken for stone: dark iron plating, visible
  // rivets and banding, and a heavy arched mouth on every side face.
  [TILE.FURNACE_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [66, 64, 68], 8);
    // Recessed lid with a bevelled rim.
    for (let i = 0; i < T; i++) {
      set(i, 0, 104, 102, 106); set(0, i, 96, 94, 98);
      set(i, T - 1, 40, 38, 42); set(T - 1, i, 46, 44, 48);
    }
    for (let y = 3; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        const d = (rnd() - 0.5) * 10;
        set(x, y, 52 + d, 50 + d, 54 + d);
      }
    }
    // Rivets at the lid corners.
    for (const [rx, ry] of [[2, 2], [13, 2], [2, 13], [13, 13]]) {
      set(rx, ry, 128, 126, 130);
    }
  },

  [TILE.FURNACE_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, [70, 68, 72], 9);
    // Horizontal plate seams.
    for (const y of [4, 9]) {
      for (let x = 0; x < T; x++) { set(x, y, 40, 38, 42); set(x, y + 1, 92, 90, 94); }
    }
    for (let i = 0; i < T; i++) { set(i, 0, 106, 104, 108); set(i, T - 1, 38, 36, 40); }
    // Rivet columns down both edges.
    for (const y of [2, 7, 12]) { set(1, y, 126, 124, 128); set(14, y, 126, 124, 128); }
  },

  [TILE.FURNACE_FRONT]: (set, rnd) => {
    noiseFill(set, rnd, [70, 68, 72], 9);
    for (let i = 0; i < T; i++) { set(i, 0, 106, 104, 108); set(i, T - 1, 38, 36, 40); }

    // Heavy arched opening, cold and empty.
    furnaceMouth(set, rnd, null);
    // Rivets flanking the mouth.
    for (const y of [7, 11]) { set(1, y, 126, 124, 128); set(14, y, 126, 124, 128); }
  },

  [TILE.FURNACE_LIT]: (set, rnd) => {
    noiseFill(set, rnd, [78, 70, 66], 9);
    for (let i = 0; i < T; i++) { set(i, 0, 112, 104, 100); set(i, T - 1, 42, 36, 34); }

    // Same mouth, full of fire.
    furnaceMouth(set, rnd, true);
    for (const y of [7, 11]) { set(1, y, 138, 122, 112); set(14, y, 138, 122, 112); }
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

  [TILE.WOOL]: (set, rnd) => {
    // Soft, fluffy: clumped light noise rather than per-pixel grain.
    for (let y = 0; y < T; y += 2) {
      for (let x = 0; x < T; x += 2) {
        const d = (rnd() - 0.5) * 22;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) set(x + dx, y + dy, 232 + d, 230 + d, 226 + d);
        }
      }
    }
    speckle(set, rnd, [210, 208, 202], 14, 2);
  },

  // --- Mob drops -----------------------------------------------------------
  [TILE.BEEF]:           (set, rnd) => meatPainter(set, rnd, [196, 78, 78], [232, 150, 150]),
  [TILE.COOKED_BEEF]:    (set, rnd) => meatPainter(set, rnd, [126, 74, 40], [176, 116, 68]),
  [TILE.MUTTON]:         (set, rnd) => meatPainter(set, rnd, [214, 108, 110], [240, 168, 168]),
  [TILE.COOKED_MUTTON]:  (set, rnd) => meatPainter(set, rnd, [146, 92, 54], [190, 132, 84]),
  [TILE.CHICKEN_RAW]:    (set, rnd) => meatPainter(set, rnd, [232, 176, 160], [246, 212, 200]),
  [TILE.CHICKEN_COOKED]: (set, rnd) => meatPainter(set, rnd, [188, 136, 74], [216, 176, 116]),

  [TILE.LEATHER]: (set, rnd) => {
    // A ragged hide.
    for (let y = 3; y < 13; y++) {
      for (let x = 2; x < 14; x++) {
        if ((x === 2 || x === 13) && rnd() < 0.5) continue;
        if ((y === 3 || y === 12) && rnd() < 0.4) continue;
        const d = (rnd() - 0.5) * 22;
        set(x, y, 158 + d, 108 + d, 66 + d);
      }
    }
    speckle(set, rnd, [128, 84, 48], 8);
  },

  [TILE.FEATHER]: (set, rnd) => {
    // Quill running diagonally with barbs either side.
    for (let i = 0; i < 11; i++) {
      const x = 4 + Math.floor(i * 0.65);
      const y = 13 - i;
      set(x, y, 208, 206, 202);
      if (i > 1 && i < 9) {
        const spread = Math.round(Math.sin(i / 9 * Math.PI) * 3);
        for (let s = 1; s <= spread; s++) {
          const d = (rnd() - 0.5) * 18;
          set(x - s, y, 244 + d, 244 + d, 240 + d);
          set(x + s, y - 1, 232 + d, 232 + d, 228 + d);
        }
      }
    }
  },

  [TILE.BONE]: (set, rnd) => {
    // Shaft with knobbed ends.
    for (let x = 4; x < 12; x++) {
      for (let y = 7; y < 10; y++) {
        const d = (rnd() - 0.5) * 12;
        set(x, y, 236 + d, 234 + d, 220 + d);
      }
    }
    for (const bx of [3, 12]) {
      for (const by of [5, 6, 10, 11]) {
        set(bx, by, 240, 238, 224);
        set(bx + (bx === 3 ? 1 : -1), by, 226, 224, 210);
      }
    }
  },

  [TILE.STRING]: (set, rnd) => {
    // Loose coil.
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      const x = Math.round(8 + Math.sin(t * Math.PI * 3) * 4);
      const y = Math.round(3 + t * 10);
      set(x, y, 236, 236, 232);
      set(x + 1, y, 206, 206, 202);
    }
  },

  [TILE.ARROW]: (set, rnd) => {
    // Shaft bottom-left to top-right, flint head, feather fletching.
    for (let i = 0; i < 12; i++) {
      const x = 3 + i;
      const y = 12 - i;
      set(x, y, 142, 106, 62);
    }
    // Head.
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, 1], [-1, -1], [-2, 0], [0, 2]]) {
      set(14 + dx, 1 - dy + 1, 186, 190, 196);
    }
    // Fletching.
    for (let i = 0; i < 3; i++) {
      set(3 + i, 12 - i + 1, 234, 234, 230);
      set(3 + i + 1, 12 - i, 234, 234, 230);
    }
  },

  [TILE.SPIDER_EYE]: (set, rnd) => {
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) {
        if (Math.hypot(x - 7.5, y - 7.5) > 3.8) continue;
        const d = (rnd() - 0.5) * 18;
        set(x, y, 150 + d, 32 + d, 30 + d);
      }
    }
    // Pupil and glint.
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) set(x, y, 40, 20, 22);
    set(6, 6, 220, 180, 180);
  },

  // --- Doors, beds, torches, chests ---------------------------------------

  [TILE.DOOR]: (set, rnd) => {
    noiseFill(set, rnd, [148, 112, 66], 12);
    // Two recessed panels with a frame.
    for (let i = 0; i < T; i++) { set(i, 0, 176, 138, 88); set(i, T - 1, 104, 76, 44); }
    for (const [py0, py1] of [[2, 6], [9, 13]]) {
      for (let y = py0; y <= py1; y++) {
        for (let x = 3; x <= 12; x++) {
          const edge = y === py0 || y === py1 || x === 3 || x === 12;
          const d = (rnd() - 0.5) * 10;
          if (edge) set(x, y, 108 + d, 80 + d, 46 + d);
          else set(x, y, 160 + d, 122 + d, 74 + d);
        }
      }
    }
    // Handle.
    set(13, 8, 216, 200, 120);
    set(13, 7, 190, 174, 100);
  },

  [TILE.BED_TOP]: (set, rnd) => {
    // Red quilt with a pillow at one end.
    noiseFill(set, rnd, [172, 42, 44], 12);
    for (let y = 0; y < 5; y++) {
      for (let x = 1; x < T - 1; x++) {
        const d = (rnd() - 0.5) * 10;
        set(x, y, 238 + d, 234 + d, 228 + d);
      }
    }
    for (let i = 0; i < T; i++) { set(i, 5, 130, 30, 32); set(i, T - 1, 128, 28, 30); }
  },

  [TILE.BED_SIDE]: (set, rnd) => {
    // Mattress over a wooden frame.
    noiseFill(set, rnd, [172, 42, 44], 10);
    for (let y = 9; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const d = (rnd() - 0.5) * 12;
        set(x, y, 144 + d, 108 + d, 62 + d);
      }
    }
    for (let i = 0; i < T; i++) set(i, 9, 108, 78, 44);
  },

  [TILE.TORCH]: (set, rnd) => {
    // A torch is a 0.125-wide, 0.625-tall shape, and `emitShape` CROPS the tile
    // to that extent rather than squashing the whole thing into it. Only tile
    // columns 7..9 and rows 6..15 are ever visible, so anything drawn outside
    // that strip is invisible — which is why the flame, originally at rows 2..5,
    // never appeared and a torch looked like a bare stick.
    //
    // Everything therefore lives inside the strip, flame at the top of it.
    const FLAME_TOP = 6, FLAME_BOTTOM = 9;

    // Handle, filling the rest of the strip below the flame.
    for (let y = FLAME_BOTTOM; y < T; y++) {
      const d = (rnd() - 0.5) * 16;
      set(7, y, 138 + d, 102 + d, 58 + d);
      set(8, y, 116 + d, 84 + d, 46 + d);
    }

    // Flame. Wider than the strip on purpose so the crop never clips an edge.
    for (let y = FLAME_TOP; y < FLAME_BOTTOM; y++) {
      const heat = (FLAME_BOTTOM - y) / (FLAME_BOTTOM - FLAME_TOP);
      for (let x = 6; x < 10; x++) {
        const d = (rnd() - 0.5) * 34;
        set(x, y, 252 + d, 172 + heat * 62 + d, 56 + d);
      }
    }
    // Hot core at the very tip — this is also what the top face samples, since
    // that face reads the tile centre (columns 7..9, rows 7..9).
    set(7, FLAME_TOP, 255, 242, 186);
    set(8, FLAME_TOP, 255, 232, 158);
    set(7, FLAME_TOP + 1, 255, 226, 132);
    set(8, FLAME_TOP + 1, 255, 214, 118);
  },

  [TILE.CHEST_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [140, 100, 54], 12);
    for (let i = 0; i < T; i++) { set(i, 0, 168, 126, 72); set(i, T - 1, 100, 70, 36); }
    // Iron band across the lid.
    for (let x = 6; x < 10; x++) for (let y = 0; y < T; y++) set(x, y, 92, 92, 96);
  },

  [TILE.CHEST_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, [140, 100, 54], 12);
    // Lid seam.
    for (let x = 0; x < T; x++) { set(x, 5, 96, 68, 34); set(x, 6, 168, 126, 72); }
    // Latch.
    for (let y = 4; y < 9; y++) for (let x = 7; x < 10; x++) set(x, y, 96, 96, 100);
    set(8, 6, 214, 196, 120);
    for (let i = 0; i < T; i++) { set(i, 0, 166, 124, 70); set(i, T - 1, 98, 68, 34); }
  },

  [TILE.BOW]: (set, rnd) => {
    // Curved limb with a string across the chord.
    for (let i = 0; i < 13; i++) {
      const t = i / 12;
      const y = 2 + i;
      const x = 11 - Math.round(Math.sin(t * Math.PI) * 4);
      const d = (rnd() - 0.5) * 16;
      set(x, y, 142 + d, 102 + d, 56 + d);
      set(x + 1, y, 116 + d, 82 + d, 44 + d);
    }
    for (let i = 0; i < 13; i++) set(11, 2 + i, 232, 230, 222);
    set(12, 2, 116, 82, 44);
    set(12, 14, 116, 82, 44);
  },

  [TILE.GUNPOWDER]: (set, rnd) => {
    // Loose grey powder.
    for (let i = 0; i < 44; i++) {
      const x = 3 + ((rnd() * 10) | 0);
      const y = 4 + ((rnd() * 9) | 0);
      const d = (rnd() - 0.5) * 34;
      set(x, y, 96 + d, 96 + d, 100 + d);
    }
  },

  // --- Combium & the Comb dimension ---------------------------------------
  // The dimension's palette is bone-white with crimson highlights, so these
  // deliberately share one narrow colour range.

  [TILE.COMBIUM_ORE]: (set, rnd) => {
    // Stone matrix with bright white crystalline inclusions.
    noiseFill(set, rnd, STONE_GREY, 14);
    for (let i = 0; i < 5; i++) {
      const cx = 2 + ((rnd() * 11) | 0);
      const cy = 2 + ((rnd() * 11) | 0);
      // Small angular clusters rather than round blobs.
      for (const [dx, dy] of [[0,0],[1,0],[0,1],[1,1],[2,0],[0,2]]) {
        if (rnd() < 0.25) continue;
        const d = (rnd() - 0.5) * 22;
        set(cx + dx, cy + dy, 244 + d, 242 + d, 236 + d);
      }
      set(cx, cy, 255, 255, 252);
    }
  },

  [TILE.COMBIUM_BLOCK]: (set, rnd) => {
    noiseFill(set, rnd, [238, 236, 230], 8);
    // Hex-ish comb cell impressed into the face.
    const cells = [[3,3],[9,3],[6,8],[3,12],[9,12]];
    for (const [cx, cy] of cells) {
      for (const [dx, dy] of [[1,0],[2,0],[3,0],[0,1],[4,1],[0,2],[4,2],[1,3],[2,3],[3,3]]) {
        set(cx + dx, cy + dy, 208, 205, 198);
      }
    }
    for (let i = 0; i < T; i++) { set(i, 0, 252, 250, 246); set(i, T - 1, 214, 211, 204); }
  },

  [TILE.COMBIUM_INGOT]: (set, rnd) => ingotPainter(set, rnd, [246, 244, 238]),

  [TILE.COMB_STONE]: (set, rnd) => {
    noiseFill(set, rnd, [226, 223, 216], 11);
    speckle(set, rnd, [206, 202, 195], 18, 2);
    // Occasional faint red fleck so it never reads as plain white.
    for (let i = 0; i < 3; i++) {
      set((rnd() * T) | 0, (rnd() * T) | 0, 186, 108, 108);
    }
  },

  [TILE.COMB_SOIL]: (set, rnd) => {
    noiseFill(set, rnd, [206, 200, 192], 14);
    speckle(set, rnd, [182, 174, 166], 22);
    speckle(set, rnd, [228, 222, 214], 10);
  },

  [TILE.COMB_CRYSTAL]: (set, rnd) => {
    // Crimson crystal in a pale matrix — the dimension's accent colour.
    noiseFill(set, rnd, [220, 214, 208], 9);
    for (let i = 0; i < 4; i++) {
      const cx = 2 + ((rnd() * 11) | 0);
      const cy = 2 + ((rnd() * 11) | 0);
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          if (dx === 2 && dy === 2) continue;
          const d = (rnd() - 0.5) * 40;
          set(cx + dx, cy + dy, 196 + d, 38 + d * 0.4, 44 + d * 0.4);
        }
      }
      set(cx, cy, 255, 128, 128); // glint
    }
  },

  [TILE.COMB_GROWTH]: (set, rnd) => {
    // Sparse upright fronds; transparent background for the cutout material.
    for (let i = 0; i < 5; i++) {
      const x = 2 + ((rnd() * 12) | 0);
      const h = 5 + ((rnd() * 8) | 0);
      for (let y = T - 1; y > T - 1 - h; y--) {
        const d = (rnd() - 0.5) * 24;
        const red = (T - y) / h;
        set(x, y, 210 + d, 90 + red * 90 + d, 96 + d);
      }
      set(x, T - h, 240, 150, 150);
    }
  },

  [TILE.COMB_BRICK]: (set, rnd) => {
    noiseFill(set, rnd, [212, 208, 200], 7);
    // Running-bond brick in pale stone with red mortar.
    for (let row = 0; row < 4; row++) {
      const offset = row % 2 === 0 ? 0 : 4;
      for (let brick = -1; brick < 2; brick++) {
        const bx = offset + brick * 8;
        for (let y = row * 4; y < row * 4 + 3; y++) {
          for (let x = bx; x < bx + 7; x++) {
            if (x < 0 || x >= T) continue;
            const d = (rnd() - 0.5) * 16;
            set(x, y, 234 + d, 230 + d, 222 + d);
          }
        }
      }
    }
    for (let x = 0; x < T; x++) for (const y of [3, 7, 11, 15]) set(x, y, 150, 76, 78);
  },

  [TILE.THRONE_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [236, 232, 224], 8);
    // Inlaid red comb sigil.
    for (const [dx, dy] of [[7,3],[8,3],[5,5],[6,4],[9,4],[10,5],[5,9],[10,9],[6,11],[9,11],[7,12],[8,12]]) {
      set(dx, dy, 190, 40, 46);
      set(dx, dy + 1, 150, 30, 36);
    }
    for (let i = 0; i < T; i++) { set(i, 0, 250, 247, 240); set(i, T - 1, 206, 202, 194); }
  },

  [TILE.THRONE_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, [224, 220, 212], 9);
    for (let y = 4; y < 12; y++) {
      for (let x = 5; x < 11; x++) {
        const d = (rnd() - 0.5) * 26;
        set(x, y, 178 + d, 40 + d * 0.4, 46 + d * 0.4);
      }
    }
    for (let i = 0; i < T; i++) { set(i, 0, 246, 243, 236); set(i, T - 1, 198, 194, 186); }
  },

  [TILE.PORTAL]: (set, rnd) => {
    // Milky white sheet shot through with red filaments.
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const swirl = Math.sin((x * 0.6 + y * 0.9)) * 14 + Math.sin(y * 0.4) * 10;
        const d = swirl + (rnd() - 0.5) * 18;
        set(x, y, 240 + d, 226 + d, 226 + d, 205);
      }
    }
    for (let i = 0; i < 26; i++) {
      const x = (rnd() * T) | 0, y = (rnd() * T) | 0;
      set(x, y, 226, 96, 104, 230);
    }
  },

  // --- Buckets --------------------------------------------------------------

  [TILE.BUCKET]:       (set, rnd) => bucketPainter(set, rnd, null),
  [TILE.BUCKET_WATER]: (set, rnd) => bucketPainter(set, rnd, [58, 112, 200]),
  [TILE.BUCKET_LAVA]:  (set, rnd) => bucketPainter(set, rnd, [226, 96, 26]),
  [TILE.BUCKET_MILK]:  (set, rnd) => bucketPainter(set, rnd, [246, 246, 242]),

  [TILE.COMB_SHARD]:  (set, rnd) => gemPainter(set, rnd, [206, 52, 58]),
  [TILE.COMB_HEART]:  (set, rnd) => {
    // A pulsing core: white shell with a red centre.
    for (let y = 3; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        const dist = Math.hypot(x - 8, y - 8);
        if (dist > 4.8) continue;
        const d = (rnd() - 0.5) * 18;
        if (dist < 2.2) set(x, y, 224 + d, 48 + d, 56 + d);
        else set(x, y, 242 + d, 238 + d, 232 + d);
      }
    }
    set(7, 6, 255, 200, 200);
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
    '......hhh.......',
    '......hhh.......',
    '......hhh.......',
    '......hhh.......',
    '......hhh.......',
    '.......h........',
    '.......h........',
    '......ddd.......',
    '.......d........',
    '................',
  ],
  sword: [
    '................',
    '.......m........',
    '......mlm.......',
    '......mlm.......',
    '......mlm.......',
    '......mlm.......',
    '.....mlllm......',
    '.....mlllm......',
    '......dmd.......',
    '....dddmddd.....',
    '......hhh.......',
    '......hhh.......',
    '......hhh.......',
    '......hhh.......',
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

/**
 * Paint a 16x16 sprite whose characters map to literal colours.
 *
 * `drawSprite` tints one shape across every material, which is what keeps the
 * twenty-odd tool icons consistent. A hand-drawn icon needs its own palette
 * instead, so it gets its own painter rather than being forced through the
 * material tint.
 */
function drawExactSprite(set, rows, palette) {
  for (let y = 0; y < Math.min(rows.length, T); y++) {
    const row = rows[y];
    for (let x = 0; x < Math.min(row.length, T); x++) {
      const hex = palette[row[x]];
      if (hex === undefined) continue;
      set(x, y, (hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
    }
  }
}

/**
 * The combium sword, traced from the sprite supplied for it rather than
 * generated: a white blade with a crimson fuller, black outline, and a brown
 * grip with a gold pommel.
 */
const COMBIUM_SWORD_SPRITE = [
  '.............AAB',
  '............ACCA',
  '...........AABCA',
  '..........DABAA.',
  '.........DDBAA..',
  '........EEBDD...',
  '.......FEBED....',
  '..GG..FFBEE.....',
  '...GGCCBFF......',
  '....GCBCF.......',
  '....HGCC........',
  '...HIHGG........',
  '..HIH..GG.......',
  'GGJH....G.......',
  'GJG.............',
  'GGG.............',
];

const COMBIUM_SWORD_PALETTE = {
  A: 0xfffefe, // blade highlight
  B: 0xfb0000, // fuller, bright
  C: 0x9e0000, // fuller, shadowed
  D: 0xe9e9e9,
  E: 0xd4cfcf,
  F: 0xb2b0b0, // blade shadow
  G: 0x000000, // outline
  H: 0x573703, // grip
  I: 0xb46f00, // pommel
  J: 0x031257,
};

// Register the generated icons alongside the hand-written painters.
for (const kind of TOOL_KINDS) {
  for (const material of GEAR_MATERIALS) {
    const color = unpack(TOOL_MATERIALS[material].color);
    PAINTERS[toolTile(kind, material)] = (set) => drawSprite(set, TOOL_SPRITES[kind], color);
  }
}

// ...then override the one that has a bespoke sprite. Registered after the loop
// so it wins, and keyed off the same `toolTile` so it cannot drift if the gear
// ids are renumbered again.
PAINTERS[toolTile('sword', 'combium')] =
  (set) => drawExactSprite(set, COMBIUM_SWORD_SPRITE, COMBIUM_SWORD_PALETTE);

for (const piece of ARMOR_PIECES) {
  for (const material of ARMOR_MATERIAL_NAMES) {
    const color = unpack(TOOL_MATERIALS[material].color);
    PAINTERS[armorTile(piece, material)] = (set) => drawSprite(set, ARMOR_SPRITES[piece], color);
  }
}

// ---------------------------------------------------------------------------
// Grip points
// ---------------------------------------------------------------------------

const gripCache = new Map();

/**
 * Where a tool's icon should sit in the fist, as {u, v} fractions of the tile
 * (u from the left, v from the top).
 *
 * Measured from the icon rather than tabulated per tool, so adding or redrawing
 * a sprite cannot leave a stale offset behind. The rule is the midpoint of the
 * lowest opaque row: every tool sprite here runs handle-at-the-bottom, blade or
 * head at the top, so that lands on the butt of the grip — a diagonal pickaxe
 * at bottom-left, a straight shovel at bottom-centre, both correct.
 */
export function getGripPoint(tile) {
  const cached = gripCache.get(tile);
  if (cached) return cached;

  let grip = { u: 0.5, v: 0.5 };
  const painter = PAINTERS[tile];

  if (painter) {
    // Replay the painter into a recorder instead of reading back the atlas,
    // which keeps this usable before the atlas has been built.
    const columnsByRow = [];
    const record = (x, y, r, g, bl, a = 255) => {
      if (a < 128 || x < 0 || x >= T || y < 0 || y >= T) return;
      (columnsByRow[y] ??= []).push(x);
    };
    painter(record, mulberry32(0x9e3779b9 ^ (tile * 7919)));

    for (let y = T - 1; y >= 0; y--) {
      const cols = columnsByRow[y];
      if (!cols || cols.length === 0) continue;
      const minX = Math.min(...cols);
      const maxX = Math.max(...cols);
      grip = { u: (minX + maxX + 1) / 2 / T, v: (y + 1) / T };
      break;
    }
  }

  gripCache.set(tile, grip);
  return grip;
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
