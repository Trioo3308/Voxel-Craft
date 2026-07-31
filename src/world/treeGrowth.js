/**
 * treeGrowth.js — Growing a sapling into a tree at runtime.
 *
 * Distinct from the trees the terrain generator stamps: those write into a raw
 * voxel array during chunk generation, this writes through `world.setBlock` so
 * the result is a player edit that saves and syncs to the worker like any other.
 * Sharing one code path would mean threading a "how do I write a block" callback
 * through the generator's hot loop for the sake of an event that happens a few
 * times a session.
 *
 * The shapes deliberately echo the generator's, so a grown tree does not look
 * like a different species from the ones around it.
 */

import { AIR, BLOCKS, LOG, LEAVES, ACACIA_LOG, ACACIA_LEAVES, SPRUCE_LOG, SPRUCE_LEAVES } from './blocks.js';

const STYLES = {
  oak: { log: LOG.id, leaves: LEAVES.id, minHeight: 4, maxHeight: 6, shape: 'round' },
  acacia: { log: ACACIA_LOG.id, leaves: ACACIA_LEAVES.id, minHeight: 5, maxHeight: 7, shape: 'flat' },
  spruce: { log: SPRUCE_LOG.id, leaves: SPRUCE_LEAVES.id, minHeight: 6, maxHeight: 9, shape: 'conifer' },
};

/** Blocks a growing tree is allowed to overwrite. */
function canReplace(id) {
  const block = BLOCKS[id];
  return id === AIR || (block && !block.solid && !block.liquid);
}

/**
 * Is there room for this tree?
 *
 * Checked before anything is placed, so a sapling in a tunnel simply stays a
 * sapling rather than growing a trunk through the ceiling.
 */
function hasRoom(world, x, y, z, height) {
  for (let dy = 0; dy <= height + 1; dy++) {
    const radius = dy > height - 3 ? 2 : 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!canReplace(world.getBlock(x + dx, y + dy, z + dz))) return false;
      }
    }
  }
  return true;
}

/**
 * Grow a tree at a sapling's position.
 *
 * @param style one of 'oak' | 'acacia' | 'spruce'
 * @param random injectable for deterministic tests
 * @returns {boolean} whether it grew
 */
export function growTree(world, x, y, z, style, random = Math.random) {
  const spec = STYLES[style];
  if (!spec) return false;

  const height = spec.minHeight + Math.floor(random() * (spec.maxHeight - spec.minHeight + 1));
  if (!hasRoom(world, x, y, z, height)) return false;

  const leaf = (lx, ly, lz) => {
    // Never paint over the trunk, and never replace solid ground.
    if (!canReplace(world.getBlock(lx, ly, lz))) return;
    world.setBlock(lx, ly, lz, spec.leaves, true);
  };

  // Trunk.
  for (let dy = 0; dy < height; dy++) {
    world.setBlock(x, y + dy, z, spec.log, true);
  }

  const top = y + height;

  if (spec.shape === 'conifer') {
    // Stacked shrinking rings, widest low down.
    let radius = 2;
    for (let ly = top - 1; ly >= y + 2; ly -= 1) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > radius + 1) continue;
          if (dx === 0 && dz === 0) continue;
          leaf(x + dx, ly, z + dz);
        }
      }
      radius = radius === 2 ? 1 : 2;
    }
    leaf(x, top, z);
  } else if (spec.shape === 'flat') {
    // A wide, thin crown — acacia.
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > 4) continue;
        leaf(x + dx, top - 1, z + dz);
        if (Math.abs(dx) + Math.abs(dz) <= 2) leaf(x + dx, top, z + dz);
      }
    }
  } else {
    // Classic oak blob.
    for (let dy = -2; dy <= 1; dy++) {
      const radius = dy >= 1 ? 1 : 2;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          // Trim the corners so it reads round rather than cubic.
          if (Math.abs(dx) === radius && Math.abs(dz) === radius && random() < 0.7) continue;
          leaf(x + dx, top + dy, z + dz);
        }
      }
    }
  }

  return true;
}

/** The tree styles a sapling can name, for validation and tests. */
export const TREE_STYLES = Object.keys(STYLES);
