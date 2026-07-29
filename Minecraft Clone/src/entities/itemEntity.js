/**
 * itemEntity.js — Dropped items lying in the world.
 *
 * Closes the survival loop: mobs and broken blocks drop these, and walking over
 * one puts it in your inventory.
 */

import * as THREE from 'three';
import { moveWithCollision } from '../player/physics.js';
import { getIconTile, ATLAS_COLS } from '../world/blocks.js';
import { getAtlasTexture } from '../world/textures.js';

const SIZE = 0.28;
const PICKUP_RADIUS = 1.4;
/** Items cannot be picked up immediately, so drops do not vanish on death. */
const PICKUP_DELAY = 0.5;
/** Items give up and disappear after this long. */
const LIFETIME = 300;

/** Cache one geometry per item id — dropped stacks of the same thing are common. */
const geometryCache = new Map();
let sharedMaterial = null;

function getMaterial() {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshLambertMaterial({
      map: getAtlasTexture(),
      alphaTest: 0.5, // item icons have transparent backgrounds
    });
  }
  return sharedMaterial;
}

/** A little cube showing the item's atlas tile on every face. */
function getGeometry(id) {
  const cached = geometryCache.get(id);
  if (cached) return cached;

  const geometry = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
  const tile = getIconTile(id);
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  const span = 1 / ATLAS_COLS;
  const u0 = col * span;
  const v0 = 1 - (row + 1) * span;

  // BoxGeometry UVs are all 0 or 1; remap them into this tile's rect, inset a
  // little so neighbouring tiles cannot bleed in.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      u0 + (0.03 + uv.getX(i) * 0.94) * span,
      v0 + (0.03 + uv.getY(i) * 0.94) * span
    );
  }
  uv.needsUpdate = true;

  geometryCache.set(id, geometry);
  return geometry;
}

export class ItemEntity {
  constructor(world, position, id, count = 1) {
    this.world = world;
    this.id = id;
    this.count = count;

    this.position = position.clone();
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 1.6,
      2.2,
      (Math.random() - 0.5) * 1.6
    );

    this.age = 0;
    this.removed = false;

    this.mesh = new THREE.Mesh(getGeometry(id), getMaterial());
    this.mesh.position.copy(this.position);
  }

  update(dt, ctx) {
    this.age += dt;
    if (this.age > LIFETIME) {
      this.removed = true;
      return;
    }

    // Physics: gravity plus ground friction so items settle instead of sliding.
    this.velocity.y -= 22 * dt;
    const result = moveWithCollision(
      this.world,
      this.position,
      this.velocity,
      { width: SIZE, height: SIZE },
      dt
    );
    if (result.onGround) {
      this.velocity.x *= Math.exp(-8 * dt);
      this.velocity.z *= Math.exp(-8 * dt);
    }

    // Spin and bob so drops are easy to spot in the grass.
    this.mesh.position.set(
      this.position.x,
      this.position.y + SIZE / 2 + Math.sin(this.age * 2.5) * 0.06,
      this.position.z
    );
    this.mesh.rotation.y = this.age * 1.6;

    this._tryPickup(ctx.player);
  }

  _tryPickup(player) {
    if (this.age < PICKUP_DELAY || player.survival.dead) return;

    const dx = player.position.x - this.position.x;
    const dy = player.position.y + 0.9 - this.position.y;
    const dz = player.position.z - this.position.z;
    if (Math.hypot(dx, dy, dz) > PICKUP_RADIUS) return;

    const leftover = player.inventory.add(this.id, this.count);
    if (leftover === 0) {
      this.removed = true;
    } else if (leftover < this.count) {
      this.count = leftover; // inventory filled up part-way
    }
  }

  dispose() {
    // Geometry and material are shared/cached, so nothing to free here.
  }
}
