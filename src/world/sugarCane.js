/**
 * sugarCane.js — Where sugar cane may stand and how tall it grows.
 *
 * One set of rules shared by planting it, growing it, breaking it and
 * generating it, so the four cannot drift apart: cane stands on more cane, or
 * on sand, grass or dirt with water beside that block, and grows to three.
 */

import { SUGAR_CANE, SAND, GRASS, DIRT, PODZOL, DRY_GRASS, SWAMP_GRASS, isFluidFamily } from './blocks.js';

export const CANE_MAX_HEIGHT = 3;

export const CANE_SOIL = new Set([SAND.id, GRASS.id, DIRT.id, PODZOL.id, DRY_GRASS.id, SWAMP_GRASS.id]);

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Can cane stand at (x, y, z)? `getBlock` reads the world. */
export function caneCanStand(getBlock, x, y, z) {
  const below = getBlock(x, y - 1, z);
  if (below === SUGAR_CANE.id) return true;
  if (!CANE_SOIL.has(below)) return false;
  for (const [dx, dz] of SIDES) {
    if (isFluidFamily(getBlock(x + dx, y - 1, z + dz), 'water')) return true;
  }
  return false;
}

/** How many cane blocks stand in the column ending at (x, y, z). */
export function caneHeight(getBlock, x, y, z) {
  let height = 0;
  while (height <= CANE_MAX_HEIGHT && getBlock(x, y - height, z) === SUGAR_CANE.id) height++;
  return height;
}
