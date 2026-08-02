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

  [TILE.MOSSY_COBBLE]: (set, rnd) => {
    // Cobble, then moss creeping over it from the top down.
    noiseFill(set, rnd, [124, 124, 128], 22);
    speckle(set, rnd, [96, 96, 100], 26, 2);
    speckle(set, rnd, [158, 158, 162], 14, 2);
    for (let y = 0; y < T; y++) {
      // Denser near the top, so the moss looks like it grew rather than
      // being sprayed on evenly.
      const density = 0.42 * (1 - y / T) + 0.10;
      for (let x = 0; x < T; x++) {
        if (rnd() > density) continue;
        const d = (rnd() - 0.5) * 26;
        set(x, y, 74 + d, 104 + d, 56 + d);
      }
    }
  },

  // --- Farming -------------------------------------------------------------

  // Four growth stages: shoots, leafing, heading, ripe. Green to gold, thin to
  // dense. The stalks fill the tile top to bottom because these are drawn as
  // crossed quads whose *height* already scales per stage — leaving empty rows
  // in the texture would just make the quad look cropped.
  ...Object.fromEntries([0, 1, 2, 3].map((stage) => [
    TILE.WHEAT_0 + stage,
    (set, rnd) => {
      const ripeness = stage / 3;
      const r = 92 + ripeness * 120;
      const g = 140 + ripeness * 44;
      const b = 52 + ripeness * 14;

      // More stalks as the crop fills in.
      const columns = [[3, 11], [2, 7, 12], [1, 5, 9, 13], [1, 4, 7, 10, 13]][stage];

      for (const x of columns) {
        for (let y = 0; y < T; y++) {
          const d = (rnd() - 0.5) * 22;
          set(x, y, r + d, g + d, b + d);
          if (stage >= 1 && x + 1 < T) set(x + 1, y, r - 18 + d, g - 16 + d, b - 8 + d);
        }
        // Ripe stalks carry a heavy grain head at the tip.
        if (stage === 3) {
          for (let y = 0; y < 5; y++) {
            set(x, y, 236 - y * 4, 200 - y * 5, 96 - y * 3);
            if (x + 1 < T) set(x + 1, y, 214 - y * 4, 176 - y * 5, 78 - y * 3);
          }
        } else if (stage === 2) {
          for (let y = 0; y < 3; y++) set(x, y, r + 30, g + 20, b + 10);
        }
      }
    },
  ])),

  [TILE.FARMLAND]: (set, rnd) => {
    noiseFill(set, rnd, DIRT_BROWN, 14);
    // Plough furrows: four darker grooves with a lit lip above each.
    for (let row = 0; row < 4; row++) {
      const y = row * 4 + 1;
      for (let x = 0; x < T; x++) {
        const d = (rnd() - 0.5) * 10;
        set(x, y, 96 + d, 68 + d, 44 + d);
        set(x, y + 1, 120 + d, 88 + d, 58 + d);
      }
    }
    speckle(set, rnd, [150, 112, 80], 10);
  },

  [TILE.FARMLAND_MOIST]: (set, rnd) => {
    // The same furrows, darker and cooler — wet earth.
    noiseFill(set, rnd, [92, 62, 40], 12);
    for (let row = 0; row < 4; row++) {
      const y = row * 4 + 1;
      for (let x = 0; x < T; x++) {
        const d = (rnd() - 0.5) * 9;
        set(x, y, 62 + d, 42 + d, 28 + d);
        set(x, y + 1, 82 + d, 56 + d, 38 + d);
      }
    }
    speckle(set, rnd, [70, 52, 40], 12);
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

  [TILE.WHEAT_ITEM]: (set, rnd) => {
    // A bundled sheaf: stalks fanning from a tied waist, with grain heads.
    for (let i = 0; i < 5; i++) {
      const lean = i - 2;
      for (let y = 3; y < 14; y++) {
        const x = 7 + Math.round((lean * (14 - y)) / 9);
        const d = (rnd() - 0.5) * 18;
        set(x, y, 206 + d, 170 + d, 60 + d);
      }
      // Grain head at the top of each stalk.
      const hx = 7 + Math.round((lean * 11) / 9);
      set(hx, 2, 232, 198, 88);
      set(hx, 3, 224, 186, 74);
    }
    // The tie.
    for (let x = 5; x <= 9; x++) set(x, 10, 150, 110, 46);
  },

  [TILE.SEEDS]: (set, rnd) => {
    // A loose scatter of husks rather than a solid blob.
    for (let i = 0; i < 16; i++) {
      const x = 3 + ((rnd() * 10) | 0);
      const y = 5 + ((rnd() * 7) | 0);
      const d = (rnd() - 0.5) * 22;
      set(x, y, 146 + d, 168 + d, 74 + d);
      set(x, y + 1, 118 + d, 138 + d, 58 + d);
    }
  },

  [TILE.BREAD]: (set, rnd) => {
    // A rounded loaf with slashes across the crust.
    for (let y = 5; y < 12; y++) {
      const inset = y === 5 || y === 11 ? 4 : y === 6 || y === 10 ? 3 : 2;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 16;
        set(x, y, 186 + d, 132 + d, 66 + d);
      }
    }
    // Highlight along the top, shadow under the bottom.
    for (let x = 4; x < 12; x++) set(x, 6, 214, 164, 92);
    for (let x = 4; x < 12; x++) set(x, 11, 142, 96, 44);
    // Scored crust.
    for (const x of [6, 9]) for (let y = 6; y < 11; y++) set(x, y, 156, 106, 50);
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
    // Pale fronds with crimson tips, drawn as crossed quads. Rooted at the
    // bottom of the tile and reaching most of the way up, so the plant has a
    // base rather than floating.
    for (let i = 0; i < 6; i++) {
      const x = 1 + ((rnd() * 14) | 0);
      const top = 1 + ((rnd() * 5) | 0);
      for (let y = T - 1; y >= top; y--) {
        const d = (rnd() - 0.5) * 20;
        // Blush toward the tip.
        const tip = (T - 1 - y) / (T - top);
        set(x, y, 226 + d, 200 - tip * 96 + d, 200 - tip * 84 + d);
      }
      set(x, top, 226, 74, 82);
      if (top + 1 < T) set(x, top + 1, 214, 108, 112);
    }
  },

  // --- Saplings and ladders ------------------------------------------------

  // Three saplings sharing one shape, differing in leaf colour so they read as
  // the tree they will become.
  ...Object.fromEntries([
    [TILE.SAPLING_OAK, [86, 140, 52]],
    [TILE.SAPLING_ACACIA, [128, 152, 58]],
    [TILE.SAPLING_SPRUCE, [54, 104, 62]],
  ].map(([tile, [lr, lg, lb]]) => [
    tile,
    (set, rnd) => {
      // A short stem with a small crown of leaves.
      for (let y = 9; y < T; y++) {
        const d = (rnd() - 0.5) * 14;
        set(7, y, 116 + d, 84 + d, 48 + d);
        set(8, y, 96 + d, 68 + d, 38 + d);
      }
      for (let y = 3; y < 10; y++) {
        const spread = y < 5 ? 2 : y < 8 ? 3 : 2;
        for (let x = 7 - spread; x <= 8 + spread; x++) {
          if (rnd() < 0.22) continue;   // ragged edges
          const d = (rnd() - 0.5) * 30;
          set(x, y, lr + d, lg + d, lb + d);
        }
      }
      set(7, 2, lr + 24, lg + 24, lb + 16);
      set(8, 2, lr + 18, lg + 18, lb + 12);
    },
  ])),

  [TILE.SHEARS]: (set, rnd) => {
    // Two crossed blades on a dark pivot.
    for (let i = 0; i < 8; i++) {
      set(3 + i, 3 + i, 214, 216, 222);
      set(4 + i, 3 + i, 176, 178, 186);
      set(12 - i, 3 + i, 214, 216, 222);
      set(11 - i, 3 + i, 176, 178, 186);
    }
    set(7, 7, 60, 60, 66); set(8, 7, 60, 60, 66);
    // Handles.
    for (let i = 0; i < 3; i++) { set(3 + i, 12 + i, 96, 74, 46); set(12 - i, 12 + i, 96, 74, 46); }
  },

  [TILE.FISHING_ROD]: (set, rnd) => {
    // A diagonal rod with a line hanging off the tip.
    for (let i = 0; i < 11; i++) {
      const d = (rnd() - 0.5) * 14;
      set(3 + i, 12 - i, 146 + d, 104 + d, 58 + d);
      if (4 + i < T) set(4 + i, 12 - i, 118 + d, 82 + d, 44 + d);
    }
    for (let y = 2; y < 12; y++) set(14, y, 236, 236, 230);
    set(14, 12, 208, 208, 200);
  },

  [TILE.FISH]: (set, rnd) => {
    // A silvery body with a tail fin and an eye.
    for (let y = 6; y < 11; y++) {
      const inset = y === 6 || y === 10 ? 2 : 1;
      for (let x = 4 + inset; x < 12 - inset + 1; x++) {
        const d = (rnd() - 0.5) * 22;
        set(x, y, 172 + d, 186 + d, 200 + d);
      }
    }
    for (let i = 0; i < 3; i++) { set(3 + i, 6 + i, 140, 154, 172); set(3 + i, 10 - i, 140, 154, 172); }
    set(10, 8, 30, 32, 38);
    for (let x = 6; x < 11; x++) set(x, 6, 206, 218, 230);
  },

  [TILE.COOKED_FISH]: (set, rnd) => {
    // The same fish, browned.
    for (let y = 6; y < 11; y++) {
      const inset = y === 6 || y === 10 ? 2 : 1;
      for (let x = 4 + inset; x < 12 - inset + 1; x++) {
        const d = (rnd() - 0.5) * 20;
        set(x, y, 196 + d, 148 + d, 84 + d);
      }
    }
    for (let i = 0; i < 3; i++) { set(3 + i, 6 + i, 164, 118, 62); set(3 + i, 10 - i, 164, 118, 62); }
    set(10, 8, 46, 32, 22);
    for (let x = 6; x < 11; x++) set(x, 6, 220, 176, 110);
  },

  [TILE.LADDER]: (set, rnd) => {
    // Two rails and evenly spaced rungs; everything else transparent.
    for (let y = 0; y < T; y++) {
      const d = (rnd() - 0.5) * 16;
      set(2, y, 148 + d, 108 + d, 60 + d);
      set(3, y, 122 + d, 88 + d, 48 + d);
      set(12, y, 148 + d, 108 + d, 60 + d);
      set(13, y, 122 + d, 88 + d, 48 + d);
    }
    for (let y = 2; y < T; y += 5) {
      for (let x = 3; x < 13; x++) {
        const d = (rnd() - 0.5) * 14;
        set(x, y, 156 + d, 116 + d, 66 + d);
        set(x, y + 1, 128 + d, 92 + d, 52 + d);
      }
    }
  },

  // --- Comb expansion -------------------------------------------------------

  [TILE.AMBER_ORE]: (set, rnd) => {
    noiseFill(set, rnd, [96, 90, 84], 14);
    speckle(set, rnd, [78, 72, 68], 18, 2);
    // Amber pockets: warm blobs with a bright core.
    for (const [cx, cy] of [[4, 5], [10, 9], [6, 12]]) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2) continue;
        const d = (rnd() - 0.5) * 24;
        set(cx + dx, cy + dy, 226 + d, 158 + d, 52 + d);
      }
      set(cx, cy, 255, 214, 120);
      set(cx - 1, cy - 1, 248, 196, 96);
    }
  },

  [TILE.HIVE_WALL]: (set, rnd) => {
    // Dense wax, stamped with a hexagonal cell grid.
    noiseFill(set, rnd, [214, 172, 96], 12);
    for (let cy = 1; cy < T; cy += 5) {
      for (let cx = (cy % 10 === 1) ? 1 : 4; cx < T; cx += 6) {
        for (let i = 0; i < 4; i++) {
          set(cx + i, cy, 168, 128, 62);
          set(cx, cy + i, 176, 134, 66);
          if (cx + 4 < T) set(cx + 4, cy + i, 176, 134, 66);
          if (cy + 4 < T) set(cx + i, cy + 4, 168, 128, 62);
        }
      }
    }
    speckle(set, rnd, [236, 198, 128], 10);
  },

  [TILE.HIVE_CORE]: (set, rnd) => {
    // A glowing cell of jelly behind a wax rim.
    noiseFill(set, rnd, [198, 152, 78], 10);
    for (let y = 3; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        const r = Math.hypot(dx, dy);
        if (r > 4.6) continue;
        const d = (rnd() - 0.5) * 22;
        if (r > 3.6) set(x, y, 176, 132, 60);
        else set(x, y, 255, 206 + d, 96 + d);
      }
    }
    set(7, 7, 255, 246, 190); set(8, 7, 255, 240, 176);
  },

  [TILE.RESIN_TORCH]: (set, rnd) => {
    // Same crop as the torch: only columns 7..9 and rows 6..15 are ever drawn.
    for (let y = 9; y < T; y++) {
      const d = (rnd() - 0.5) * 14;
      set(7, y, 134 + d, 100 + d, 56 + d);
      set(8, y, 112 + d, 82 + d, 46 + d);
    }
    for (let y = 6; y < 9; y++) {
      for (let x = 6; x < 10; x++) {
        const d = (rnd() - 0.5) * 26;
        set(x, y, 250 + d, 200 + d, 110 + d);
      }
    }
    set(7, 6, 255, 244, 198); set(8, 6, 255, 236, 176);
  },

  [TILE.COMB_MOSS]: (set, rnd) => {
    noiseFill(set, rnd, [176, 190, 156], 16);
    speckle(set, rnd, [140, 164, 122], 30, 2);
    speckle(set, rnd, [206, 216, 186], 16);
  },

  [TILE.COMB_ASH]: (set, rnd) => {
    noiseFill(set, rnd, [156, 148, 146], 18);
    speckle(set, rnd, [122, 114, 114], 28, 2);
    speckle(set, rnd, [190, 182, 180], 14);
  },

  [TILE.DEEP_COMB]: (set, rnd) => {
    // Darker and denser than surface comb stone.
    noiseFill(set, rnd, [104, 100, 104], 16);
    speckle(set, rnd, [80, 76, 82], 26, 2);
    speckle(set, rnd, [132, 126, 132], 14, 2);
  },

  [TILE.CRYSTAL_CLUSTER]: (set, rnd) => {
    // Several tall crimson shards rising together.
    for (const [x, top] of [[3, 4], [7, 1], [11, 5], [9, 7]]) {
      for (let y = T - 1; y >= top; y--) {
        const d = (rnd() - 0.5) * 24;
        const tip = (T - 1 - y) / (T - top);
        set(x, y, 176 + tip * 70 + d, 40 + tip * 24 + d, 52 + tip * 30 + d);
        if (x + 1 < T) set(x + 1, y, 146 + tip * 60 + d, 30 + d, 42 + d);
      }
      set(x, top - 1 < 0 ? 0 : top - 1, 255, 216, 216);
    }
  },

  [TILE.AMBER_ITEM]: (set, rnd) => {
    // A faceted drop of amber.
    for (let y = 3; y < 13; y++) {
      const inset = y < 5 ? 5 : y < 7 ? 4 : y < 11 ? 3 : 5;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 22;
        set(x, y, 230 + d, 162 + d, 56 + d);
      }
    }
    for (let x = 6; x < 10; x++) set(x, 5, 250, 208, 120);
    set(6, 6, 255, 232, 168);
    for (let x = 6; x < 10; x++) set(x, 11, 190, 122, 34);
  },

  [TILE.ROYAL_JELLY]: (set, rnd) => {
    // A viscous golden blob in a shallow dish.
    for (let y = 5; y < 12; y++) {
      const inset = y === 5 ? 4 : y === 11 ? 4 : 3;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 18;
        set(x, y, 250 + d, 214 + d, 96 + d);
      }
    }
    for (let x = 5; x < 11; x++) set(x, 12, 176, 140, 58);
    set(6, 6, 255, 246, 200); set(7, 6, 255, 240, 184);
  },

  [TILE.SHRINE_COMPASS]: (set, rnd) => {
    // A pale case with a crimson needle.
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        const r = Math.hypot(x - 7.5, y - 7.5);
        if (r > 6) continue;
        const d = (rnd() - 0.5) * 14;
        if (r > 4.8) set(x, y, 226 + d, 220 + d, 208 + d);
        else set(x, y, 40 + d, 34 + d, 40 + d);
      }
    }
    // Needle pointing up-right, and its counterweight.
    for (let i = 0; i < 4; i++) set(7 + i, 8 - i, 224, 62, 70);
    for (let i = 0; i < 3; i++) set(7 - i, 8 + i, 218, 212, 200);
    set(7, 8, 255, 236, 180);
  },

  [TILE.SUSTINGUS_JELLY]: (set, rnd) => {
    // A pale wobbling glob that refuses to hold a shape.
    for (let y = 4; y < 13; y++) {
      const inset = y === 4 ? 5 : y === 5 ? 3 : y === 12 ? 4 : 2;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 20;
        set(x, y, 216 + d, 226 + d, 206 + d);
      }
    }
    // Three dark specks, because it has three of everything else too.
    set(6, 7, 60, 66, 62); set(10, 8, 60, 66, 62); set(8, 10, 60, 66, 62);
    for (let x = 5; x < 9; x++) set(x, 5, 240, 248, 232);
  },

  [TILE.ROCKET]: (set, rnd) => {
    // A tube with a nose cone and fins, plus a fuse.
    for (let y = 5; y < 13; y++) {
      for (let x = 6; x < 10; x++) {
        const d = (rnd() - 0.5) * 14;
        set(x, y, x < 8 ? 226 + d : 196 + d, 216 + d, 208 + d);
      }
    }
    // Nose.
    for (let i = 0; i < 3; i++) {
      for (let x = 6 + i; x < 10 - i; x++) set(x, 4 - i, 208, 62, 68);
    }
    // Fins and fuse.
    for (let y = 10; y < 13; y++) { set(5, y, 178, 54, 60); set(10, y, 178, 54, 60); }
    for (let y = 13; y < 16; y++) set(8, y, 120, 100, 70);
    set(8, 15, 255, 200, 90);
  },

  [TILE.SKATEBOARD]: (set, rnd) => {
    // A deck seen at an angle, with trucks and wheels hanging off it.
    const deckY = (x) => 9 - Math.round((x - 2) * 0.35);
    for (let x = 2; x < 14; x++) {
      const y = deckY(x);
      const d = (rnd() - 0.5) * 16;
      // Grip tape on top, then the two plies of the deck itself.
      set(x, y - 1, 52 + d, 48 + d, 52 + d);
      set(x, y, 168 + d, 116 + d, 66 + d);
      set(x, y + 1, 140 + d, 94 + d, 52 + d);
    }
    // Kicked-up tail and nose.
    set(1, deckY(2), 178, 126, 74); set(1, deckY(2) - 1, 178, 126, 74);
    set(14, deckY(14), 178, 126, 74); set(14, deckY(14) - 1, 178, 126, 74);

    // Wheels hang directly under the deck, one truck-height below it, so the
    // board reads as one object rather than a plank with dice under it.
    for (const wx of [4, 11]) {
      const y = deckY(wx) + 2;
      set(wx, y, 150, 150, 158); set(wx + 1, y, 150, 150, 158);       // truck
      set(wx, y + 1, 236, 228, 208); set(wx + 1, y + 1, 236, 228, 208); // wheel
      set(wx, y + 2, 198, 190, 172); set(wx + 1, y + 2, 198, 190, 172);
    }
  },

  // --- Rails, records, plates and food --------------------------------------

  [TILE.RAIL]: (set, rnd) => {
    // Sleepers under a pair of polished steel bars, seen from above.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 12;
      set(x, y, 96 + d, 74 + d, 48 + d);
    }
    for (let y = 0; y < T; y += 4) {
      for (let x = 0; x < T; x++) {
        const d = (rnd() - 0.5) * 10;
        set(x, y, 122 + d, 94 + d, 60 + d);
      }
    }
    for (const x of [4, 11]) {
      for (let y = 0; y < T; y++) {
        const d = (rnd() - 0.5) * 16;
        set(x, y, 190 + d, 194 + d, 202 + d);
        set(x + 1, y, 148 + d, 152 + d, 160 + d);
      }
    }
  },

  [TILE.SIGN]: (set, rnd) => {
    // A pale plank with scratched-on lines of writing.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 14;
      set(x, y, 190 + d, 152 + d, 96 + d);
    }
    for (let x = 0; x < T; x++) { set(x, 0, 150, 116, 70); set(x, T - 1, 150, 116, 70); }
    for (const y of [4, 7, 10]) {
      const width = 4 + Math.floor(rnd() * 7);
      for (let x = 3; x < 3 + width; x++) set(x, y, 92, 68, 40);
    }
  },

  [TILE.JUKEBOX_TOP]: (set, rnd) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 14;
      set(x, y, 122 + d, 84 + d, 54 + d);
    }
    // The record itself, with a light label at the spindle.
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
      const dx = x - 7.5, dy = y - 7.5, r = Math.hypot(dx, dy);
      if (r > 5.6) continue;
      if (r < 1.4) { set(x, y, 214, 202, 172); continue; }
      // Grooves.
      const g = Math.round(r) % 2 === 0 ? 44 : 28;
      set(x, y, g, g, g + 6);
    }
  },

  [TILE.JUKEBOX_SIDE]: (set, rnd) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 14;
      set(x, y, 108 + d, 74 + d, 48 + d);
    }
    // A speaker grille and a brass corner band.
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
      const on = (x + y) % 2 === 0;
      set(x, y, on ? 52 : 38, on ? 46 : 34, on ? 42 : 32);
    }
    for (let x = 0; x < T; x++) { set(x, 1, 186, 146, 74); set(x, 14, 186, 146, 74); }
  },

  [TILE.PRESSURE_PLATE]: (set, rnd) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const edge = x < 2 || y < 2 || x > 13 || y > 13;
      const d = (rnd() - 0.5) * 12;
      set(x, y, (edge ? 128 : 164) + d, (edge ? 92 : 120) + d, (edge ? 56 : 72) + d);
    }
  },

  [TILE.MUSHROOM_RED]: (set, rnd) => {
    // Cap on a short pale stalk.
    for (let y = 9; y < 15; y++) for (let x = 6; x < 10; x++) {
      const d = (rnd() - 0.5) * 12;
      set(x, y, 226 + d, 220 + d, 202 + d);
    }
    for (let y = 4; y < 10; y++) {
      const inset = y === 4 ? 5 : y === 5 ? 3 : y >= 9 ? 3 : 2;
      for (let x = inset; x < T - inset; x++) set(x, y, 186, 48, 44);
    }
    for (const [x, y] of [[5, 6], [9, 5], [11, 7], [7, 8]]) set(x, y, 238, 234, 224);
  },

  [TILE.MUSHROOM_BROWN]: (set, rnd) => {
    for (let y = 9; y < 15; y++) for (let x = 6; x < 10; x++) {
      const d = (rnd() - 0.5) * 12;
      set(x, y, 208 + d, 196 + d, 172 + d);
    }
    for (let y = 5; y < 10; y++) {
      const inset = y === 5 ? 4 : y >= 9 ? 3 : 2;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 18;
        set(x, y, 146 + d, 106 + d, 66 + d);
      }
    }
  },

  [TILE.BOAT]: (set, rnd) => {
    // A hull in profile, wider at the top, with an oar across it.
    for (let y = 7; y < 13; y++) {
      const inset = y < 9 ? 1 : y < 11 ? 2 : 4;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 16;
        set(x, y, 156 + d, 108 + d, 62 + d);
      }
    }
    for (let x = 1; x < 15; x++) set(x, 7, 190, 140, 84);   // gunwale
    for (let x = 5; x < 11; x++) set(x, 8, 96, 66, 38);     // the seat, in shadow
    for (let i = 0; i < 8; i++) set(3 + i, 5 - Math.round(i * 0.4), 176, 132, 78); // oar
  },

  [TILE.BOWL]: (set, rnd) => {
    for (let y = 8; y < 13; y++) {
      const inset = y < 11 ? 3 : 5;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 14;
        set(x, y, 150 + d, 104 + d, 62 + d);
      }
    }
    for (let x = 3; x < 13; x++) set(x, 8, 106, 72, 42); // the hollow, in shadow
  },

  [TILE.MUSHROOM_STEW]: (set, rnd) => {
    for (let y = 8; y < 13; y++) {
      const inset = y < 11 ? 3 : 5;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 14;
        set(x, y, 150 + d, 104 + d, 62 + d);
      }
    }
    for (let x = 3; x < 13; x++) {
      const d = (rnd() - 0.5) * 20;
      set(x, 8, 152 + d, 108 + d, 62 + d);
      set(x, 7, 168 + d, 122 + d, 72 + d);
    }
    // Bits floating in it.
    for (const [x, y] of [[5, 7], [9, 8], [11, 7]]) set(x, y, 190, 60, 52);
  },

  [TILE.APPLE]: (set, rnd) => {
    for (let y = 5; y < 14; y++) {
      const inset = y === 5 ? 5 : y === 6 ? 4 : y === 13 ? 5 : 3;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 22;
        set(x, y, 198 + d, 52 + d, 48 + d);
      }
    }
    for (let y = 7; y < 11; y++) set(5, y, 232, 118, 104); // highlight
    set(8, 4, 110, 80, 44); set(8, 3, 110, 80, 44);        // stalk
    set(9, 3, 92, 158, 70); set(10, 3, 92, 158, 70);       // leaf
  },

  [TILE.GOLDEN_APPLE]: (set, rnd) => {
    for (let y = 5; y < 14; y++) {
      const inset = y === 5 ? 5 : y === 6 ? 4 : y === 13 ? 5 : 3;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 22;
        set(x, y, 232 + d, 186 + d, 62 + d);
      }
    }
    for (let y = 7; y < 11; y++) set(5, y, 255, 238, 168);
    set(8, 4, 150, 116, 52); set(8, 3, 150, 116, 52);
    set(9, 3, 214, 236, 150); set(10, 3, 214, 236, 150);
  },

  // The three records differ only in label colour, so they share a painter.
  ...Object.fromEntries([
    [TILE.DISC_DRIFT, [92, 150, 214]],
    [TILE.DISC_HOLLOW, [206, 198, 178]],
    [TILE.DISC_GRIND, [212, 96, 60]],
  ].map(([tile, label]) => [tile, (set, rnd) => {
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
      const dx = x - 7.5, dy = y - 7.5, r = Math.hypot(dx, dy);
      if (r > 6.8) continue;
      if (r < 2.2) { set(x, y, label[0], label[1], label[2]); continue; }
      if (r < 0.9) { set(x, y, 20, 20, 24); continue; }
      const g = Math.round(r) % 2 === 0 ? 46 : 30;
      const d = (rnd() - 0.5) * 6;
      set(x, y, g + d, g + d, g + 8 + d);
    }
    set(7, 7, 18, 18, 22); set(8, 7, 18, 18, 22);
    set(7, 8, 18, 18, 22); set(8, 8, 18, 18, 22);
  }])),

  // --- Beds and the deep ----------------------------------------------------

  [TILE.BED_HEAD_TOP]: (set, rnd) => {
    // Same blanket as the foot end, with a pillow across the top so which way
    // the bed points is readable without needing a rotated texture.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 16;
      set(x, y, 176 + d, 54 + d, 58 + d);
    }
    for (let y = 1; y < 6; y++) {
      for (let x = 2; x < T - 2; x++) {
        const d = (rnd() - 0.5) * 12;
        set(x, y, 236 + d, 232 + d, 222 + d);
      }
    }
    for (let x = 2; x < T - 2; x++) set(x, 6, 198, 194, 184);
  },

  [TILE.DEEPSLATE]: (set, rnd) => {
    // Dark, tight-grained, with a faint banding so it does not read as a void.
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const band = Math.sin(y * 0.9) * 4;
        const d = (rnd() - 0.5) * 14;
        set(x, y, 62 + d + band, 62 + d + band, 70 + d + band);
      }
    }
    for (let i = 0; i < 22; i++) {
      const x = Math.floor(rnd() * T), y = Math.floor(rnd() * T);
      set(x, y, 44, 44, 52);
    }
  },

  [TILE.DEEPSLATE_COBBLE]: (set, rnd) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 24;
      set(x, y, 66 + d, 66 + d, 74 + d);
    }
    // Broken-up chunks, same idea as cobblestone but darker and blockier.
    for (let i = 0; i < 7; i++) {
      const cx = Math.floor(rnd() * T), cy = Math.floor(rnd() * T);
      const w = 2 + Math.floor(rnd() * 3), h = 2 + Math.floor(rnd() * 3);
      for (let y = cy; y < cy + h; y++) {
        for (let x = cx; x < cx + w; x++) {
          if (x >= T || y >= T) continue;
          const edge = x === cx || y === cy;
          set(x, y, edge ? 40 : 84, edge ? 40 : 84, edge ? 48 : 92);
        }
      }
    }
  },

  // The three dripstone pieces share one painter, differing only in how the
  // width varies down the tile: a point at the top, a point at the bottom, or
  // no taper at all. Stacking shaft behind tip is what makes a run of them read
  // as a single spike rather than a row of separate cones.
  ...Object.fromEntries([
    // [tile, half-width at row y]
    [TILE.DRIPSTONE, (y) => Math.round(y * 0.28) + 1],            // tip up
    [TILE.DRIPSTONE_HANGING, (y) => Math.round((T - 1 - y) * 0.28) + 1], // tip down
    [TILE.DRIPSTONE_SHAFT, () => 4],                              // straight
  ].map(([tile, widthAt]) => [tile, (set, rnd) => {
    for (let y = 0; y < T; y++) {
      const half = Math.min(6, widthAt(y));
      const left = 8 - half, right = 7 + half;
      for (let x = left; x <= right; x++) {
        if (x < 0 || x >= T) continue;
        const d = (rnd() - 0.5) * 18;
        const edge = x === left || x === right;
        set(x, y, (edge ? 124 : 158) + d, (edge ? 104 : 134) + d, (edge ? 88 : 114) + d);
      }
    }
  }])),

  [TILE.GLOW_LICHEN]: (set, rnd) => {
    // A sprawl of pale green filaments. Mostly transparent, so it reads as
    // something growing on the rock rather than a pane of glass over it.
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(rnd() * T), y = Math.floor(rnd() * T);
      const d = (rnd() - 0.5) * 40;
      set(x, y, 128 + d, 208 + d, 150 + d);
    }
    // A few brighter nodes, which is where the light reads as coming from.
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(rnd() * T), y = Math.floor(rnd() * T);
      set(x, y, 210, 255, 200);
      set(Math.min(T - 1, x + 1), y, 180, 240, 178);
    }
  },

  [TILE.GEODE_SHELL]: (set, rnd) => {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 18;
      set(x, y, 104 + d, 92 + d, 118 + d);
    }
    // A knobbly rind.
    for (let i = 0; i < 14; i++) {
      const cx = Math.floor(rnd() * T), cy = Math.floor(rnd() * T);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = (cx + dx) % T, y = (cy + dy) % T;
        set(x, y, 130, 116, 148);
      }
    }
  },

  [TILE.GEODE_CRYSTAL]: (set, rnd) => {
    // Clustered violet shards on a dark matrix.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 12;
      set(x, y, 58 + d, 44 + d, 74 + d);
    }
    for (const [bx, by, h] of [[3, 12, 7], [7, 14, 9], [11, 11, 6], [13, 14, 4], [1, 13, 4]]) {
      for (let i = 0; i < h; i++) {
        const y = by - i;
        if (y < 0) continue;
        const w = i < h - 2 ? 1 : 0;
        for (let x = bx - w; x <= bx + w; x++) {
          if (x < 0 || x >= T) continue;
          const t = i / h;
          set(x, y, 150 + t * 90, 96 + t * 80, 214 + t * 40);
        }
      }
    }
  },

  [TILE.CAVE_CRYSTAL]: (set, rnd) => {
    // A cut gem: bright core, darker facets down the sides.
    for (let y = 3; y < 14; y++) {
      const half = y < 6 ? y - 2 : Math.max(1, 13 - y + 2);
      for (let x = 8 - half; x <= 7 + half; x++) {
        if (x < 0 || x >= T) continue;
        const d = (rnd() - 0.5) * 16;
        const lit = x < 8;
        set(x, y, (lit ? 196 : 150) + d, (lit ? 140 : 96) + d, (lit ? 236 : 200) + d);
      }
    }
    for (let y = 5; y < 11; y++) set(7, y, 236, 206, 255);
  },

  [TILE.GLOW_BERRY]: (set, rnd) => {
    // Three small luminous berries on a stem.
    for (let y = 2; y < 7; y++) set(8, y, 96, 132, 84);
    for (const [cx, cy] of [[5, 8], [10, 7], [8, 11]]) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 4) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || x >= T || y < 0 || y >= T) continue;
          const d = (rnd() - 0.5) * 20;
          const core = dx * dx + dy * dy <= 1;
          set(x, y, (core ? 255 : 224) + d, (core ? 214 : 164) + d, (core ? 120 : 60) + d);
        }
      }
    }
  },

  [TILE.CAVE_LANTERN]: (set, rnd) => {
    // A caged crystal: iron frame, glowing middle.
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const d = (rnd() - 0.5) * 10;
      set(x, y, 78 + d, 76 + d, 84 + d);
    }
    for (let y = 3; y < 13; y++) {
      for (let x = 3; x < 13; x++) {
        const edge = Math.abs(x - 7.5) > 3.5 || Math.abs(y - 7.5) > 4;
        const d = (rnd() - 0.5) * 24;
        set(x, y, (edge ? 150 : 226) + d, (edge ? 110 : 190) + d, (edge ? 210 : 255) + d);
      }
    }
    // Frame bars.
    for (let x = 0; x < T; x++) { set(x, 1, 118, 116, 126); set(x, 14, 118, 116, 126); }
    for (let y = 0; y < T; y++) { set(1, y, 118, 116, 126); set(14, y, 118, 116, 126); }
    set(8, 0, 140, 138, 148);
  },

  // --- Comb materials ------------------------------------------------------

  [TILE.COMB_RESIN]: (set, rnd) => {
    // Amber seams running through pale wax.
    noiseFill(set, rnd, [232, 214, 176], 12);
    for (let i = 0; i < 5; i++) {
      let x = (rnd() * T) | 0;
      for (let y = 0; y < T; y++) {
        x = Math.max(0, Math.min(T - 1, x + ((rnd() * 3) | 0) - 1));
        const d = (rnd() - 0.5) * 20;
        set(x, y, 214 + d, 154 + d, 68 + d);
        if (x + 1 < T) set(x + 1, y, 196 + d, 138 + d, 58 + d);
      }
    }
    speckle(set, rnd, [246, 232, 200], 12);
  },

  [TILE.COMB_WAX]: (set, rnd) => {
    // Flat sealed wax with faint hexagonal impressions.
    noiseFill(set, rnd, [238, 228, 206], 8);
    for (let cy = 0; cy < T; cy += 5) {
      for (let cx = (cy % 10 === 0) ? 0 : 3; cx < T; cx += 6) {
        for (let i = 0; i < 4; i++) {
          set(cx + i, cy, 220, 206, 178);
          set(cx, cy + i, 224, 210, 182);
        }
      }
    }
  },

  [TILE.COMB_LANTERN]: (set, rnd) => {
    // A bright core behind a pale lattice frame.
    noiseFill(set, rnd, [255, 246, 214], 10);
    for (let i = 0; i < T; i++) {
      set(i, 0, 226, 210, 180); set(i, T - 1, 226, 210, 180);
      set(0, i, 226, 210, 180); set(T - 1, i, 226, 210, 180);
    }
    // Crimson filament in the middle.
    for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
      const edge = x === 5 || x === 10 || y === 5 || y === 10;
      const d = (rnd() - 0.5) * 20;
      if (edge) set(x, y, 208 + d, 96 + d, 96 + d);
      else set(x, y, 255, 214 + d, 150 + d);
    }
  },

  [TILE.COMB_GLASS]: (set, rnd) => {
    // Mostly transparent, with a pale frame and a couple of highlights.
    for (let i = 0; i < T; i++) {
      set(i, 0, 236, 230, 220, 190); set(i, T - 1, 236, 230, 220, 190);
      set(0, i, 236, 230, 220, 190); set(T - 1, i, 236, 230, 220, 190);
    }
    for (let i = 2; i < 7; i++) set(i, i, 255, 252, 246, 120);
    set(11, 4, 255, 252, 246, 100);
    set(12, 5, 255, 252, 246, 100);
  },

  [TILE.COMB_TILE]: (set, rnd) => {
    // Polished slab, quartered, with a crimson inlay at the centre.
    noiseFill(set, rnd, [230, 224, 212], 8);
    for (let i = 0; i < T; i++) { set(7, i, 208, 200, 186); set(8, i, 214, 206, 192); }
    for (let i = 0; i < T; i++) { set(i, 7, 208, 200, 186); set(i, 8, 214, 206, 192); }
    for (const [x, y] of [[7,7],[8,7],[7,8],[8,8]]) set(x, y, 186, 58, 66);
  },

  [TILE.COMB_PILLAR_SIDE]: (set, rnd) => {
    // Vertical fluting.
    noiseFill(set, rnd, [228, 222, 210], 8);
    for (let x = 1; x < T; x += 4) {
      for (let y = 0; y < T; y++) {
        const d = (rnd() - 0.5) * 8;
        set(x, y, 198 + d, 190 + d, 176 + d);
        set(x + 1, y, 242 + d, 236 + d, 224 + d);
      }
    }
  },

  [TILE.COMB_PILLAR_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [232, 226, 214], 8);
    // A ring, so the cap reads as turned stone.
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      const x = Math.round(7.5 + Math.cos(t) * 5.2);
      const y = Math.round(7.5 + Math.sin(t) * 5.2);
      set(x, y, 200, 192, 178);
    }
    for (const [x, y] of [[7,7],[8,7],[7,8],[8,8]]) set(x, y, 186, 58, 66);
  },

  [TILE.COMB_SPINE]: (set, rnd) => {
    // Sharp crimson needles rising from the floor.
    for (let i = 0; i < 5; i++) {
      const x = 1 + ((rnd() * 14) | 0);
      const top = 2 + ((rnd() * 5) | 0);
      for (let y = T - 1; y >= top; y--) {
        const d = (rnd() - 0.5) * 22;
        const tip = (T - 1 - y) / (T - top);
        set(x, y, 168 + tip * 78 + d, 34 + d, 44 + d);
      }
      set(x, top, 250, 224, 224);
    }
  },

  [TILE.PALE_FUNGUS]: (set, rnd) => {
    // Short stems under domed caps.
    for (let i = 0; i < 3; i++) {
      const x = 3 + ((rnd() * 10) | 0);
      const capY = 5 + ((rnd() * 4) | 0);
      for (let y = T - 1; y > capY; y--) set(x, y, 226, 220, 206);
      for (let dx = -2; dx <= 2; dx++) {
        const h = 2 - Math.abs(dx);
        for (let dy = 0; dy <= h; dy++) {
          const d = (rnd() - 0.5) * 16;
          set(x + dx, capY - dy, 248 + d, 236 + d, 214 + d);
        }
      }
      set(x, capY - 2, 255, 246, 226);
    }
  },

  [TILE.THRONE_AWAKENED_TOP]: (set, rnd) => {
    noiseFill(set, rnd, [244, 238, 226], 8);
    // A blazing heart set into the seat.
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      const r = Math.hypot(dx, dy);
      if (r > 3.6) continue;
      const d = (rnd() - 0.5) * 26;
      set(x, y, 255, r < 2 ? 210 + d : 96 + d, r < 2 ? 160 + d : 92 + d);
    }
  },

  [TILE.THRONE_AWAKENED_SIDE]: (set, rnd) => {
    noiseFill(set, rnd, [236, 230, 218], 10);
    // Veins of light running up the sides.
    for (const x of [3, 7, 12]) {
      for (let y = 2; y < T; y++) {
        const d = (rnd() - 0.5) * 20;
        set(x, y, 255, 140 + d, 120 + d);
      }
    }
    for (let i = 0; i < T; i++) set(i, 0, 208, 200, 188);
  },

  [TILE.COMB_RESIN_ITEM]: (set, rnd) => {
    // A blob of amber.
    for (let y = 4; y < 13; y++) {
      const inset = y === 4 || y === 12 ? 5 : y === 5 || y === 11 ? 4 : 3;
      for (let x = inset; x < T - inset; x++) {
        const d = (rnd() - 0.5) * 20;
        set(x, y, 224 + d, 164 + d, 72 + d);
      }
    }
    for (let x = 6; x < 10; x++) set(x, 5, 246, 208, 128);
    set(6, 6, 252, 226, 168);
  },

  [TILE.CROWN]: (set, rnd) => {
    // A banded circlet with three points and a red stone.
    const gold = (x, y, shade = 0) => set(x, y, 238 + shade, 206 + shade, 96 + shade);
    for (let x = 3; x < 13; x++) { gold(x, 10); gold(x, 11, -26); }
    for (const [x, h] of [[4, 3], [7, 5], [10, 3]]) {
      for (let y = 10 - h; y < 10; y++) { gold(x, y); if (x + 1 < T) gold(x + 1, y, -18); }
      set(x, 10 - h - 1, 255, 236, 160);
    }
    // The stone.
    set(7, 8, 208, 48, 56); set(8, 8, 176, 34, 42);
    set(7, 9, 232, 78, 84); set(8, 9, 196, 52, 58);
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
    '......hhh.......',
    '......hhh.......',
    '......hdh.......',
    '......ddd.......',
    '................',
  ],
  // Blade across the top-right, handle running down to the bottom-left — the
  // same diagonal as the pickaxe, so it grips correctly under the measured rule.
  hoe: [
    '................',
    '.....mmmmm......',
    '.....mllllm.....',
    '.....mdd..m.....',
    '......m.hh......',
    '........hh......',
    '.......hh.......',
    '.......hh.......',
    '......hh........',
    '......hh........',
    '.....hh.........',
    '.....hh.........',
    '....hh..........',
    '....hh..........',
    '...hh...........',
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

const tilePaletteCache = new Map();

/**
 * The opaque colours in a tile, as packed 0xRRGGBB.
 *
 * Particles pick from this so a shard of stone is stone-coloured and a shard of
 * grass is green, without the particle system needing to know anything about
 * blocks. Sampled from the built atlas, so it reflects whatever the painter
 * actually drew rather than a second hand-maintained colour table.
 */
export function getTilePalette(tile) {
  const cached = tilePaletteCache.get(tile);
  if (cached) return cached;

  getAtlasTexture(); // ensure the canvas exists
  const ctx = atlasCanvas.getContext('2d', { willReadFrequently: true });
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  const data = ctx.getImageData(col * T, row * T, T, T).data;

  const colors = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    colors.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  // A fully transparent tile still needs something to hand back.
  if (colors.length === 0) colors.push(0x9a9a9a);

  tilePaletteCache.set(tile, colors);
  return colors;
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
