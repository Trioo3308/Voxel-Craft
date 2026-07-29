/**
 * raycast.js — Voxel ray traversal (Amanatides & Woo).
 *
 * Walks the ray voxel-by-voxel in order, so the first solid block it meets is
 * genuinely the nearest one. Cost is proportional to distance travelled, not to
 * the number of blocks in the world.
 *
 * Used for block targeting (break/place) and for mob line-of-sight.
 */

import { AIR, isLiquid } from '../world/blocks.js';

/**
 * @param world anything exposing getBlock(x,y,z)
 * @param origin {x,y,z} ray start
 * @param direction {x,y,z} normalised direction
 * @param maxDistance how far to walk, in blocks
 * @param predicate optional (blockId) => boolean; default = solid, non-liquid
 * @returns {{x,y,z,block,normal:{x,y,z},distance}|null}
 */
export function raycastVoxels(world, origin, direction, maxDistance, predicate) {
  const test = predicate ?? ((id) => id !== AIR && !isLiquid(id));

  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = Math.sign(direction.x);
  const stepY = Math.sign(direction.y);
  const stepZ = Math.sign(direction.z);

  // Distance along the ray between successive grid planes on each axis.
  const tDeltaX = stepX !== 0 ? Math.abs(1 / direction.x) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / direction.y) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / direction.z) : Infinity;

  // Distance from the origin to the first grid plane crossing on each axis.
  const distToBoundary = (coord, cell, step) =>
    step > 0 ? cell + 1 - coord : coord - cell;

  let tMaxX = stepX !== 0 ? distToBoundary(origin.x, x, stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? distToBoundary(origin.y, y, stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? distToBoundary(origin.z, z, stepZ) * tDeltaZ : Infinity;

  // Face normal of the voxel we most recently stepped into.
  let normal = { x: 0, y: 0, z: 0 };
  let distance = 0;

  // The block containing the ray origin counts too.
  const startBlock = world.getBlock(x, y, z);
  if (test(startBlock)) {
    return { x, y, z, block: startBlock, normal, distance: 0 };
  }

  while (distance <= maxDistance) {
    // Advance along whichever axis reaches its next grid plane first.
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      distance = tMaxX;
      tMaxX += tDeltaX;
      normal = { x: -stepX, y: 0, z: 0 };
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      distance = tMaxY;
      tMaxY += tDeltaY;
      normal = { x: 0, y: -stepY, z: 0 };
    } else {
      z += stepZ;
      distance = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = { x: 0, y: 0, z: -stepZ };
    }

    if (distance > maxDistance) break;

    const block = world.getBlock(x, y, z);
    if (test(block)) {
      return { x, y, z, block, normal, distance };
    }
  }

  return null;
}
