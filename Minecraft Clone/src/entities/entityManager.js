/**
 * entityManager.js — Spawning, updating and culling every non-player entity.
 *
 * Handles mobs and dropped items together because they share a lifecycle:
 * spawn near the player, simulate while close, remove when far away or dead.
 */

import * as THREE from 'three';
import Settings from '../settings.js';
import { Mob } from './mob.js';
import { MOB_TYPES } from './mobTypes.js';
import { ItemEntity } from './itemEntity.js';
import { AIR } from '../world/blocks.js';

const M = Settings.mobs;

export class EntityManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/world.js').World} world
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;

    /** @type {Mob[]} */
    this.mobs = [];
    /** @type {ItemEntity[]} */
    this.items = [];

    this._spawnTimer = 0;
    this._tmpVec = new THREE.Vector3();
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {{player: object, isDay: boolean, isNight: boolean}} ctx
   */
  update(dt, ctx) {
    this._updateMobs(dt, ctx);
    this._updateItems(dt, ctx);

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = M.spawnInterval;
      this._trySpawnWave(ctx);
      this._despawnDistant(ctx.player);
    }
  }

  _updateMobs(dt, ctx) {
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      mob.update(dt, ctx);

      if (mob.removed) {
        this._dropLoot(mob);
        this.scene.remove(mob.object3D);
        mob.dispose();
        this.mobs.splice(i, 1);
      }
    }
  }

  _updateItems(dt, ctx) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.update(dt, ctx);

      if (item.removed) {
        this.scene.remove(item.mesh);
        item.dispose();
        this.items.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  _trySpawnWave(ctx) {
    const { player, isNight } = ctx;
    if (player.survival.dead) return;

    for (const type of MOB_TYPES) {
      const rules = type.spawn;
      // Time-of-day gate: hostiles at night, passives during the day.
      const allowedNow = isNight ? rules.atNight : rules.dayTimeAllowed;
      if (!allowedNow) continue;

      const current = this.mobs.reduce((n, m) => n + (m.type === type && !m.dead ? 1 : 0), 0);
      if (current >= rules.maxCount) continue;

      const spot = this._findSpawnSpot(player, type);
      if (!spot) continue;

      // Spawn a small group so the world does not feel evenly sprinkled.
      const [minGroup, maxGroup] = rules.groupSize;
      const groupSize = minGroup + Math.floor(Math.random() * (maxGroup - minGroup + 1));
      const room = rules.maxCount - current;

      for (let i = 0; i < Math.min(groupSize, room); i++) {
        // Scatter group members a few blocks apart around the anchor point.
        const offsetX = i === 0 ? 0 : (Math.random() - 0.5) * 5;
        const offsetZ = i === 0 ? 0 : (Math.random() - 0.5) * 5;
        const x = Math.floor(spot.x + offsetX);
        const z = Math.floor(spot.z + offsetZ);
        if (!this._canStandAt(x, z, type)) continue;

        const surfaceY = this.world.getSurfaceY(x, z);
        this.spawnMob(type, x + 0.5, surfaceY + 1, z + 0.5);
      }
    }
  }

  /** Look for a valid anchor point in the spawn ring around the player. */
  _findSpawnSpot(player, type) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = M.minSpawnDistance + Math.random() * (M.maxSpawnDistance - M.minSpawnDistance);
      const x = Math.floor(player.position.x + Math.cos(angle) * distance);
      const z = Math.floor(player.position.z + Math.sin(angle) * distance);
      if (this._canStandAt(x, z, type)) return { x, z };
    }
    return null;
  }

  /** Is there a suitable surface with enough headroom at this column? */
  _canStandAt(x, z, type) {
    if (!this.world.isChunkLoaded(x, z)) return false;

    const surfaceY = this.world.getSurfaceY(x, z);
    if (surfaceY < 1) return false;

    const groundBlock = this.world.getBlock(x, surfaceY, z);
    if (!type.spawn.canSpawnOn(groundBlock)) return false;

    // Enough clear space above for the mob to stand up.
    const needed = Math.ceil(type.height);
    for (let dy = 1; dy <= needed; dy++) {
      if (this.world.getBlock(x, surfaceY + dy, z) !== AIR) return false;
    }
    return true;
  }

  /** Create a mob directly (also handy for debugging / commands). */
  spawnMob(type, x, y, z) {
    const mob = new Mob(type, this.world, this._tmpVec.set(x, y, z));
    this.mobs.push(mob);
    this.scene.add(mob.object3D);
    return mob;
  }

  _despawnDistant(player) {
    const limitSq = M.despawnDistance * M.despawnDistance;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      const dx = mob.position.x - player.position.x;
      const dz = mob.position.z - player.position.z;
      if (dx * dx + dz * dz <= limitSq) continue;

      this.scene.remove(mob.object3D);
      mob.dispose();
      this.mobs.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Drops
  // -------------------------------------------------------------------------

  _dropLoot(mob) {
    if (!mob.type.drops) return;
    for (const drop of mob.type.drops) {
      const count = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
      if (count > 0) this.dropItem(mob.position.x, mob.position.y + 0.4, mob.position.z, drop.id, count);
    }
  }

  dropItem(x, y, z, id, count = 1) {
    const item = new ItemEntity(this.world, this._tmpVec.set(x, y, z), id, count);
    this.items.push(item);
    this.scene.add(item.mesh);
    return item;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Nearest mob along a ray, via the slab method.
   * @returns {{mob: Mob, distance: number}|null}
   */
  raycast(origin, direction, maxDistance) {
    let best = null;

    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const hw = mob.width / 2;
      const t = rayBoxIntersect(
        origin, direction,
        mob.position.x - hw, mob.position.y, mob.position.z - hw,
        mob.position.x + hw, mob.position.y + mob.height, mob.position.z + hw
      );
      if (t === null || t > maxDistance) continue;
      if (!best || t < best.distance) best = { mob, distance: t };
    }

    return best;
  }

  /** Used to stop the player sealing a mob inside a block. */
  anyMobIntersectsBlock(x, y, z) {
    return this.mobs.some((mob) => !mob.dead && mob.intersectsBlock(x, y, z));
  }

  get mobCount() {
    return this.mobs.length;
  }

  clear() {
    for (const mob of this.mobs) {
      this.scene.remove(mob.object3D);
      mob.dispose();
    }
    for (const item of this.items) this.scene.remove(item.mesh);
    this.mobs.length = 0;
    this.items.length = 0;
  }
}

/**
 * Ray vs. axis-aligned box (slab method).
 * @returns {number|null} distance along the ray to the entry point
 */
function rayBoxIntersect(origin, dir, minX, minY, minZ, maxX, maxY, maxZ) {
  let tMin = 0;
  let tMax = Infinity;

  const axes = [
    [origin.x, dir.x, minX, maxX],
    [origin.y, dir.y, minY, maxY],
    [origin.z, dir.z, minZ, maxZ],
  ];

  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      // Ray is parallel to this slab: miss unless the origin is already inside.
      if (o < lo || o > hi) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin;
}
