/**
 * portal.js — Combium portals between the Overworld and the Comb.
 *
 * A frame is built from combium blocks in nether-portal proportions and lit
 * with a bucket of milk. Detection walks outward from the block you clicked to
 * find the enclosed opening, then verifies the ring around it — so the frame can
 * be built in either orientation and at any size within the allowed range,
 * rather than only matching one hard-coded template.
 */

import { AIR, COMBIUM_BLOCK, PORTAL, isLiquid } from './blocks.js';
import { DIMENSIONS } from './dimensions.js';

/** Interior size limits, matching a nether portal's 2x3 minimum. */
const MIN_W = 2, MAX_W = 4;
const MIN_H = 3, MAX_H = 5;

/** How far a search will wander before giving up. */
const SEARCH_LIMIT = 64;

/**
 * Try to light a portal from a block face.
 *
 * @param world       the World
 * @param x,y,z       the block that was clicked (part of the frame or the gap)
 * @returns {{cells: Array, axis: string}|null} the interior cells filled, or null
 */
export function ignitePortal(world, x, y, z) {
  // The raycast stops on the frame, never on the air inside it, so the click
  // lands on a frame block and the interior has to be inferred. Aiming at the
  // inner floor is the usual case; the horizontal neighbours cover clicking a
  // side wall, and the block itself covers a creative-mode click on air.
  const starts = [
    [x, y + 1, z],
    [x + 1, y, z], [x - 1, y, z],
    [x, y, z + 1], [x, y, z - 1],
    [x, y, z],
  ];

  for (const [sx, sy, sz] of starts) {
    for (const axis of ['x', 'z']) {
      const found = findInterior(world, sx, sy, sz, axis);
      if (!found) continue;
      for (const [cx, cy, cz] of found.cells) world.setBlock(cx, cy, cz, PORTAL.id);
      return found;
    }
  }
  return null;
}

/**
 * Flood the open cells from a starting point within one vertical plane, then
 * check every cell bordering that region is a combium block.
 */
function findInterior(world, sx, sy, sz, axis) {
  if (!isOpen(world, sx, sy, sz)) return null;

  // Step vectors: the plane spans `axis` horizontally and Y vertically.
  const ax = axis === 'x' ? 1 : 0;
  const az = axis === 'z' ? 1 : 0;

  const seen = new Set();
  const cells = [];
  const queue = [[sx, sy, sz]];
  let minA = Infinity, maxA = -Infinity, minY = Infinity, maxY = -Infinity;

  while (queue.length > 0) {
    const [cx, cy, cz] = queue.pop();
    const key = `${cx},${cy},${cz}`;
    if (seen.has(key)) continue;
    if (!isOpen(world, cx, cy, cz)) continue;
    seen.add(key);
    cells.push([cx, cy, cz]);
    if (cells.length > SEARCH_LIMIT) return null; // opening is not enclosed

    const a = axis === 'x' ? cx : cz;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;

    queue.push([cx + ax, cy, cz + az]);
    queue.push([cx - ax, cy, cz - az]);
    queue.push([cx, cy + 1, cz]);
    queue.push([cx, cy - 1, cz]);
  }

  const width = maxA - minA + 1;
  const height = maxY - minY + 1;
  if (width < MIN_W || width > MAX_W || height < MIN_H || height > MAX_H) return null;
  // The flood must have filled a solid rectangle, not an L-shape.
  if (cells.length !== width * height) return null;

  // Every cell around the rectangle must be frame.
  for (let i = minA - 1; i <= maxA + 1; i++) {
    for (let cy = minY - 1; cy <= maxY + 1; cy++) {
      const inside = i >= minA && i <= maxA && cy >= minY && cy <= maxY;
      if (inside) continue;
      // Corners are not required, as in Minecraft.
      const onCorner = (i === minA - 1 || i === maxA + 1) && (cy === minY - 1 || cy === maxY + 1);
      if (onCorner) continue;

      const bx = axis === 'x' ? i : sx;
      const bz = axis === 'z' ? i : sz;
      if (world.getBlock(bx, cy, bz) !== COMBIUM_BLOCK.id) return null;
    }
  }

  return { cells, axis, width, height };
}

/** A portal interior may only contain air or an existing portal surface. */
function isOpen(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === AIR || id === PORTAL.id;
}

/**
 * Break every portal block connected to this one.
 * Called when part of a frame is destroyed, so a portal cannot outlive its ring.
 */
export function extinguishPortal(world, x, y, z) {
  const queue = [[x, y, z]];
  const seen = new Set();
  let cleared = 0;

  while (queue.length > 0) {
    const [cx, cy, cz] = queue.pop();
    const key = `${cx},${cy},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (world.getBlock(cx, cy, cz) !== PORTAL.id) continue;

    world.setBlock(cx, cy, cz, AIR);
    cleared++;
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      queue.push([cx + dx, cy + dy, cz + dz]);
    }
  }
  return cleared;
}

/** Where a portal should be built on arrival, and the frame to build with it. */
export function buildReturnPortal(world, x, y, z) {
  // Clear a pocket so the frame is never fused into terrain.
  for (let dx = -2; dx <= 3; dx++) {
    for (let dy = -1; dy <= 5; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const id = world.getBlock(x + dx, y + dy, z + dz);
        if (id !== AIR && !isLiquid(id)) world.setBlock(x + dx, y + dy, z + dz, AIR);
      }
    }
  }

  // Solid footing underneath, so you do not arrive in mid-air.
  for (let dx = -1; dx <= 2; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      world.setBlock(x + dx, y - 1, z + dz, COMBIUM_BLOCK.id);
    }
  }

  // Frame: 4 wide x 5 tall along X, with a 2x3 interior.
  for (let dx = 0; dx <= 3; dx++) {
    world.setBlock(x + dx, y, z, COMBIUM_BLOCK.id);
    world.setBlock(x + dx, y + 4, z, COMBIUM_BLOCK.id);
  }
  for (let dy = 0; dy <= 4; dy++) {
    world.setBlock(x, y + dy, z, COMBIUM_BLOCK.id);
    world.setBlock(x + 3, y + dy, z, COMBIUM_BLOCK.id);
  }

  // Interior.
  const cells = [];
  for (let dx = 1; dx <= 2; dx++) {
    for (let dy = 1; dy <= 3; dy++) {
      world.setBlock(x + dx, y + dy, z, PORTAL.id);
      cells.push([x + dx, y + dy, z]);
    }
  }

  // `stand` is deliberately *outside* the frame, on the footing in front of it:
  // arriving inside the portal would leave the player embedded in the frame's
  // bottom row and re-trigger the trip the moment the cooldown lapsed.
  return {
    cells,
    x: x + 1, y: y + 1, z,
    stand: { x: x + 1.5, y: y, z: z + 1.5 },
  };
}

/** The dimension a portal leads to from where you currently are. */
export function destinationOf(dimension) {
  return dimension === DIMENSIONS.COMB ? DIMENSIONS.OVERWORLD : DIMENSIONS.COMB;
}
