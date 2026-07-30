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

  // Entity box in world space, reused for the shape tests below.
  const eMinX = position.x - hw, eMaxX = position.x + hw;
  const eMinY = position.y, eMaxY = position.y + height;
  const eMinZ = position.z - hw, eMaxZ = position.z + hw;

  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!world.isSolid(x, y, z)) continue;

        // Fast path: a full cube fills its cell, so overlapping the cell is
        // enough. Only partial blocks need the per-box test.
        const shape = world.getShape ? world.getShape(x, y, z) : null;
        if (!shape) return true;

        for (const box of shape) {
          if (
            eMinX < x + box[3] && eMaxX > x + box[0] &&
            eMinY < y + box[4] && eMaxY > y + box[1] &&
            eMinZ < z + box[5] && eMaxZ > z + box[2]
          ) return true;
        }
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
 * Is there solid ground directly beneath the box's footprint?
 * Used for sneak edge protection — not the same as `onGround`, which only says
 * whether we are currently *resting* on something.
 */
export function isSupported(world, position, width) {
  const hw = width / 2;
  const probeY = position.y - 0.02;
  const y = Math.floor(probeY);

  const minX = Math.floor(position.x - hw);
  const maxX = Math.ceil(position.x + hw) - 1;
  const minZ = Math.floor(position.z - hw);
  const maxZ = Math.ceil(position.z + hw) - 1;

  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      if (!world.isSolid(x, y, z)) continue;

      const shape = world.getShape ? world.getShape(x, y, z) : null;
      if (!shape) return true;
      // A partial block only supports us if one of its boxes actually reaches
      // the height we are standing at — standing on the air above a slab does
      // not count.
      for (const box of shape) {
        if (y + box[4] >= probeY && y + box[1] <= probeY + 0.04) return true;
      }
    }
  }
  return false;
}

/**
 * Highest solid surface at or below `fromY` under the box's footprint.
 *
 * Landing used to snap with `Math.ceil(y)`, which silently assumes every block
 * top sits on an integer height. That is true for full cubes and wrong for every
 * partial block: landing on a slab would snap to the top of its *cell* instead
 * of the top of the slab, leaving the entity hovering and then falling again in
 * a permanent jitter.
 *
 * @returns {number} surface height, or -Infinity if there is nothing to land on
 */
function landingSurface(world, position, width, height, fromY) {
  const hw = width / 2;
  const minX = Math.floor(position.x - hw);
  const maxX = Math.ceil(position.x + hw) - 1;
  const minZ = Math.floor(position.z - hw);
  const maxZ = Math.ceil(position.z + hw) - 1;
  const minY = Math.floor(position.y);
  const maxY = Math.floor(fromY);

  let best = -Infinity;
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!world.isSolid(x, y, z)) continue;

        const shape = world.getShape ? world.getShape(x, y, z) : null;
        if (!shape) {
          if (y + 1 <= fromY + 1e-6 && y + 1 > best) best = y + 1;
          continue;
        }
        for (const box of shape) {
          const top = y + box[4];
          if (top <= fromY + 1e-6 && top > best) best = top;
        }
      }
    }
  }
  return best;
}

/**
 * Lowest solid surface at or above the box's head, for resolving a bonk.
 * Same reasoning as `landingSurface` — a shape's underside is not necessarily on
 * an integer boundary.
 */
function ceilingSurface(world, position, width, height, fromTop) {
  const hw = width / 2;
  const minX = Math.floor(position.x - hw);
  const maxX = Math.ceil(position.x + hw) - 1;
  const minZ = Math.floor(position.z - hw);
  const maxZ = Math.ceil(position.z + hw) - 1;
  const minY = Math.floor(fromTop);
  const maxY = Math.ceil(position.y + height);

  let best = Infinity;
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!world.isSolid(x, y, z)) continue;

        const shape = world.getShape ? world.getShape(x, y, z) : null;
        if (!shape) {
          if (y >= fromTop - 1e-6 && y < best) best = y;
          continue;
        }
        for (const box of shape) {
          const bottom = y + box[1];
          if (bottom >= fromTop - 1e-6 && bottom < best) best = bottom;
        }
      }
    }
  }
  return best;
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
  const result = { onGround: false, hitCeiling: false, hitWall: false, blockedByLedge: false };

  // Sneak edge protection: refuse horizontal motion that would leave the box
  // hanging over nothing. Only meaningful if we start out standing on ground —
  // it must never freeze someone who is already falling.
  const preventFalling = options.preventFalling === true && isSupported(world, position, width);

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
        if (dy > 0) {
          // Bonked head: sit just under whatever we hit.
          const ceiling = ceilingSurface(world, position, width, height, prevY + height);
          position.y = ceiling < Infinity ? ceiling - height - EPS
                                          : Math.floor(position.y + height) - height - EPS;
        } else {
          // Landed: rest on the actual surface, which may be a slab or stair.
          const surface = landingSurface(world, position, width, height, prevY);
          position.y = surface > -Infinity ? surface + EPS : Math.ceil(position.y) + EPS;
        }
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
      } else if (preventFalling && !isSupported(world, position, width)) {
        position.x = prevX;
        velocity.x = 0;
        dx = 0;
        result.blockedByLedge = true;
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
      } else if (preventFalling && !isSupported(world, position, width)) {
        position.z = prevZ;
        velocity.z = 0;
        dz = 0;
        result.blockedByLedge = true;
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
