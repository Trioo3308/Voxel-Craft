/**
 * portal.js — Portals to the Comb, the Nether and the Aether.
 *
 * A frame is built in nether-portal proportions and lit with the right thing.
 * Detection walks outward from the block you clicked to find the enclosed
 * opening, then verifies the ring around it — so a frame can be built in either
 * orientation and at any size within the allowed range, rather than only
 * matching one hard-coded template.
 *
 * Which frame leads where lives in `PORTAL_KINDS`. It began as one hard-coded
 * frame block, one portal block and one igniter, with `destinationOf` as a
 * two-way toggle; adding two more dimensions turned all of that into table
 * lookups, so a fourth would be one entry and no new code.
 */

import {
  AIR, COMBIUM_BLOCK, OBSIDIAN, GLOWSTONE,
  PORTAL, PORTAL_NETHER, PORTAL_AETHER, isLiquid, getBlock,
} from './blocks.js';
import { DIMENSIONS } from './dimensions.js';

/**
 * The portals this world knows how to build.
 *
 * `igniter` is matched against an item's `igniter` field (flint and steel) or a
 * bucket's `bucket.igniter` (milk, water) — the bucket form predates the
 * general one and is kept so existing saves and recipes are untouched.
 */
export const PORTAL_KINDS = [
  {
    id: 'comb',
    frame: COMBIUM_BLOCK.id,
    surface: PORTAL.id,
    igniter: 'milk',
    destination: DIMENSIONS.COMB,
    name: 'Combium Portal',
  },
  {
    id: 'nether',
    frame: OBSIDIAN.id,
    surface: PORTAL_NETHER.id,
    igniter: 'fire',
    destination: DIMENSIONS.NETHER,
    name: 'Nether Portal',
  },
  {
    id: 'aether',
    frame: GLOWSTONE.id,
    surface: PORTAL_AETHER.id,
    igniter: 'water',
    destination: DIMENSIONS.AETHER,
    name: 'Aether Portal',
  },
];

const KIND_BY_SURFACE = new Map(PORTAL_KINDS.map((k) => [k.surface, k]));
const KIND_BY_FRAME = new Map(PORTAL_KINDS.map((k) => [k.frame, k]));

/** Every block id that is a portal surface, for the "am I standing in one" test. */
export const PORTAL_SURFACES = PORTAL_KINDS.map((k) => k.surface);

export function portalKindForIgniter(igniter) {
  return PORTAL_KINDS.find((k) => k.igniter === igniter) ?? null;
}

export function portalKindForSurface(id) {
  return KIND_BY_SURFACE.get(id) ?? null;
}

export function portalKindForFrame(id) {
  return KIND_BY_FRAME.get(id) ?? null;
}

/** What an item lights portals with, or null. Covers both spellings. */
export function igniterOf(item) {
  if (!item) return null;
  if (item.igniter) return item.igniter;
  if (item.bucket && item.bucket.igniter) return item.bucket.fluid;
  return null;
}

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
export function ignitePortal(world, x, y, z, kind = PORTAL_KINDS[0]) {
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
      const found = findInterior(world, sx, sy, sz, axis, kind);
      if (!found) continue;
      for (const [cx, cy, cz] of found.cells) world.setBlock(cx, cy, cz, kind.surface);
      return { ...found, kind };
    }
  }
  return null;
}

/**
 * Flood the open cells from a starting point within one vertical plane, then
 * check every cell bordering that region is a combium block.
 */
function findInterior(world, sx, sy, sz, axis, kind) {
  if (!isOpen(world, sx, sy, sz, kind)) return null;

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
    if (!isOpen(world, cx, cy, cz, kind)) continue;
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
      if (world.getBlock(bx, cy, bz) !== kind.frame) return null;
    }
  }

  return { cells, axis, width, height };
}

/**
 * A portal interior may only contain air or this kind's own surface.
 *
 * Its *own* surface specifically: relighting an existing portal with a
 * different igniter should not silently convert where it goes.
 */
function isOpen(world, x, y, z, kind) {
  const id = world.getBlock(x, y, z);
  return id === AIR || id === kind.surface;
}

/**
 * Break every portal block connected to this one.
 * Called when part of a frame is destroyed, so a portal cannot outlive its ring.
 */
export function extinguishPortal(world, x, y, z) {
  const surface = world.getBlock(x, y, z);
  if (!KIND_BY_SURFACE.has(surface)) return 0;

  const queue = [[x, y, z]];
  const seen = new Set();
  let cleared = 0;

  while (queue.length > 0) {
    const [cx, cy, cz] = queue.pop();
    const key = `${cx},${cy},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Only this portal's own surface, so two portals of different kinds sharing
    // a wall do not put each other out.
    if (world.getBlock(cx, cy, cz) !== surface) continue;

    world.setBlock(cx, cy, cz, AIR);
    cleared++;
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      queue.push([cx + dx, cy + dy, cz + dz]);
    }
  }
  return cleared;
}

/** Where a portal should be built on arrival, and the frame to build with it. */
export function buildReturnPortal(world, x, y, z, kind = PORTAL_KINDS[0]) {
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
      world.setBlock(x + dx, y - 1, z + dz, kind.frame);
    }
  }

  // Frame: 4 wide x 5 tall along X, with a 2x3 interior.
  for (let dx = 0; dx <= 3; dx++) {
    world.setBlock(x + dx, y, z, kind.frame);
    world.setBlock(x + dx, y + 4, z, kind.frame);
  }
  for (let dy = 0; dy <= 4; dy++) {
    world.setBlock(x, y + dy, z, kind.frame);
    world.setBlock(x + 3, y + dy, z, kind.frame);
  }

  // Interior.
  const cells = [];
  for (let dx = 1; dx <= 2; dx++) {
    for (let dy = 1; dy <= 3; dy++) {
      world.setBlock(x + dx, y + dy, z, kind.surface);
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

/**
 * Where the portal you are standing in leads.
 *
 * Read off the surface block rather than from the dimension you are in, because
 * with three destinations "the other one" is no longer a question with an
 * answer. Anywhere that is not the Overworld leads home; the Overworld leads
 * wherever the portal says.
 */
export function destinationOf(dimension, surfaceId = null) {
  if (dimension !== DIMENSIONS.OVERWORLD) return DIMENSIONS.OVERWORLD;
  const kind = surfaceId === null ? null : KIND_BY_SURFACE.get(surfaceId);
  return kind ? kind.destination : DIMENSIONS.COMB;
}

/** The portal kind that gets you home from a given dimension. */
export function kindForDimension(dimension) {
  return PORTAL_KINDS.find((k) => k.destination === dimension) ?? PORTAL_KINDS[0];
}
