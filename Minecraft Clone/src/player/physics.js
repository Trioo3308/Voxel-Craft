/**
 * physics.js — Axis-aligned box collision against the voxel grid.
 *
 * Shared by the player and every mob, so movement behaves consistently.
 * The approach is the standard one for voxel worlds: move one axis at a time
 * and, on overlap, snap the box flush against the block face it crossed.
 * Resolving axes separately is what gives smooth sliding along walls.
 */

const EPS = 1e-3;

/**
 * Does an AABB overlap any solid voxel?
 * `position` is the *feet centre*: X/Z centred, Y at the bottom of the box.
 */
export function collidesWithWorld(world, position, width, height) {
  const hw = width / 2;

  const minX = Math.floor(position.x - hw);
  const minY = Math.floor(position.y);
  const minZ = Math.floor(position.z - hw);
  // `ceil(v) - 1` is the correct inclusive upper voxel: it equals floor(v) for
  // fractional values but excludes the next voxel when v lands exactly on a
  // boundary (which would otherwise make a flush box collide with thin air).
  const maxX = Math.ceil(position.x + hw) - 1;
  const maxY = Math.ceil(position.y + height) - 1;
  const maxZ = Math.ceil(position.z + hw) - 1;

  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (world.isSolid(x, y, z)) return true;
      }
    }
  }
  return false;
}

/** Is any part of the box inside a liquid? */
export function isInLiquid(world, position, width, height) {
  const hw = width / 2;
  const minX = Math.floor(position.x - hw);
  const minY = Math.floor(position.y);
  const minZ = Math.floor(position.z - hw);
  const maxX = Math.ceil(position.x + hw) - 1;
  const maxY = Math.ceil(position.y + height) - 1;
  const maxZ = Math.ceil(position.z + hw) - 1;

  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (world.isLiquid(x, y, z)) return true;
      }
    }
  }
  return false;
}

/**
 * Try to lift the box over a low obstacle (slabs, stairs — anything shorter
 * than `stepHeight`). Full blocks stay un-climbable, so jumping still matters.
 * Mutates `position.y` on success.
 */
function tryStepUp(world, position, width, height, stepHeight) {
  if (stepHeight <= 0) return false;
  const originalY = position.y;
  for (let lift = 0.25; lift <= stepHeight + 1e-4; lift += 0.25) {
    position.y = originalY + lift;
    if (!collidesWithWorld(world, position, width, height)) return true;
  }
  position.y = originalY;
  return false;
}

/**
 * Integrate velocity into position with collision response.
 *
 * @param world  anything exposing isSolid(x,y,z)
 * @param position {x,y,z} mutated in place (feet centre)
 * @param velocity {x,y,z} mutated in place (zeroed on the axes that hit)
 * @param size {width, height}
 * @param dt seconds
 * @param options {stepHeight}
 * @returns {{onGround:boolean, hitCeiling:boolean, hitWall:boolean}}
 */
export function moveWithCollision(world, position, velocity, size, dt, options = {}) {
  const { width, height } = size;
  const stepHeight = options.stepHeight ?? 0;
  const result = { onGround: false, hitCeiling: false, hitWall: false };

  let dx = velocity.x * dt;
  let dy = velocity.y * dt;
  let dz = velocity.z * dt;

  // Sub-step so a single frame can never tunnel through a block. Anything
  // under one voxel per step is safe; 0.4 leaves comfortable margin.
  const longest = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const steps = Math.max(1, Math.ceil(longest / 0.4));
  dx /= steps;
  dy /= steps;
  dz /= steps;

  for (let s = 0; s < steps; s++) {
    // ---- Y ----------------------------------------------------------------
    if (dy !== 0) {
      const prevY = position.y;
      position.y += dy;
      if (collidesWithWorld(world, position, width, height)) {
        position.y = dy > 0
          ? Math.floor(position.y + height) - height - EPS // bonked head
          : Math.ceil(position.y) + EPS;                   // landed
        // If snapping somehow still overlaps (e.g. a block was placed inside
        // us), fall back to simply not moving.
        if (collidesWithWorld(world, position, width, height)) position.y = prevY;

        if (dy > 0) result.hitCeiling = true;
        else result.onGround = true;
        velocity.y = 0;
        dy = 0;
      }
    }

    // ---- X ----------------------------------------------------------------
    if (dx !== 0) {
      const prevX = position.x;
      position.x += dx;
      if (collidesWithWorld(world, position, width, height)) {
        if (!tryStepUp(world, position, width, height, stepHeight)) {
          const hw = width / 2;
          position.x = dx > 0
            ? Math.floor(position.x + hw) - hw - EPS
            : Math.ceil(position.x - hw) + hw + EPS;
          if (collidesWithWorld(world, position, width, height)) position.x = prevX;
          velocity.x = 0;
          dx = 0;
          result.hitWall = true;
        }
      }
    }

    // ---- Z ----------------------------------------------------------------
    if (dz !== 0) {
      const prevZ = position.z;
      position.z += dz;
      if (collidesWithWorld(world, position, width, height)) {
        if (!tryStepUp(world, position, width, height, stepHeight)) {
          const hw = width / 2;
          position.z = dz > 0
            ? Math.floor(position.z + hw) - hw - EPS
            : Math.ceil(position.z - hw) + hw + EPS;
          if (collidesWithWorld(world, position, width, height)) position.z = prevZ;
          velocity.z = 0;
          dz = 0;
          result.hitWall = true;
        }
      }
    }
  }

  // Standing still on the ground never triggers the downward branch above, so
  // probe just beneath the feet to keep `onGround` accurate.
  if (!result.onGround && velocity.y <= 0) {
    const probeY = position.y;
    position.y -= EPS * 2;
    if (collidesWithWorld(world, position, width, height)) result.onGround = true;
    position.y = probeY;
  }

  return result;
}
