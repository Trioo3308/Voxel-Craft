/**
 * projectile.js — Arrows.
 *
 * Deliberately simple: a small mesh with gravity that sweeps forward each
 * frame, checking the swept segment against blocks so a fast arrow cannot
 * tunnel through a wall between frames.
 */

import * as THREE from 'three';
import { raycastVoxels } from '../player/raycast.js';
import { audio } from '../engine/audio.js';

const GRAVITY = 12;
const LIFETIME = 12;

let sharedGeometry = null;
let sharedMaterial = null;

function getMesh() {
  if (!sharedGeometry) {
    // Long thin shaft; oriented along +Z then rotated to face travel.
    sharedGeometry = new THREE.BoxGeometry(0.06, 0.06, 0.5);
    sharedMaterial = new THREE.MeshLambertMaterial({ color: 0x8a6a3a });
  }
  return new THREE.Mesh(sharedGeometry, sharedMaterial);
}

export class Arrow {
  /**
   * @param owner the mob that fired it (never hit by its own arrow)
   * @param damage hit points on impact
   */
  constructor(world, position, velocity, owner, damage) {
    this.world = world;
    this.owner = owner;
    this.damage = damage;

    this.position = position.clone();
    this.velocity = velocity.clone();
    this.age = 0;
    this.removed = false;

    this.mesh = getMesh();
    this.mesh.position.copy(this.position);
  }

  update(dt, ctx) {
    this.age += dt;
    if (this.age > LIFETIME) {
      this.removed = true;
      return;
    }

    this.velocity.y -= GRAVITY * dt;

    const step = this.velocity.clone().multiplyScalar(dt);
    const distance = step.length();
    if (distance <= 0) return;

    const dir = step.clone().normalize();

    // --- Blocks: sweep the segment rather than sampling the endpoint --------
    const hit = raycastVoxels(this.world, this.position, dir, distance);
    if (hit) {
      this.removed = true;
      audio.arrowHit();
      return;
    }

    // --- Entities ----------------------------------------------------------
    if (this._checkEntityHit(ctx, dir, distance)) return;

    this.position.add(step);
    this.mesh.position.copy(this.position);
    // Point the shaft along its flight path.
    this.mesh.lookAt(this.position.clone().add(dir));
  }

  _checkEntityHit(ctx, dir, distance) {
    const player = ctx.player;

    // The player, unless the player fired it.
    if (this.owner !== player && !player.survival.dead) {
      const hw = 0.3;
      if (segmentHitsBox(
        this.position, dir, distance,
        player.position.x - hw, player.position.y, player.position.z - hw,
        player.position.x + hw, player.position.y + player.height, player.position.z + hw
      )) {
        // Credit the shooter, so the death screen names it.
        player.survival.damage(this.damage, 'mob', this.owner?.type ?? null);
        this.removed = true;
        audio.arrowHit();
        return true;
      }
    }

    // Other mobs — an arrow that misses you can still hit a bystander, which
    // is how skeleton crossfire starts fights in Minecraft.
    if (ctx.entities) {
      for (const mob of ctx.entities.mobs) {
        if (mob === this.owner || mob.dead) continue;
        const hw = mob.width / 2;
        if (!segmentHitsBox(
          this.position, dir, distance,
          mob.position.x - hw, mob.position.y, mob.position.z - hw,
          mob.position.x + hw, mob.position.y + mob.height, mob.position.z + hw
        )) continue;

        mob.takeDamage(this.damage, { x: dir.x, y: 0.3, z: dir.z });
        this.removed = true;
        audio.arrowHit();
        return true;
      }
    }

    return false;
  }

  dispose() {
    // Geometry and material are shared.
  }
}

/** Ray/AABB test limited to `maxDistance` (slab method). */
function segmentHitsBox(origin, dir, maxDistance, minX, minY, minZ, maxX, maxY, maxZ) {
  let tMin = 0;
  let tMax = maxDistance;

  const axes = [
    [origin.x, dir.x, minX, maxX],
    [origin.y, dir.y, minY, maxY],
    [origin.z, dir.z, minZ, maxZ],
  ];

  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return false;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}
