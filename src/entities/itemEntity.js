/**
 * itemEntity.js — Dropped items lying in the world.
 *
 * Closes the survival loop: mobs and broken blocks drop these, and walking over
 * one puts it in your inventory.
 */

import * as THREE from 'three';
import { moveWithCollision } from '../player/physics.js';
import { getIconTile, ATLAS_COLS, ATLAS_ROWS } from '../world/blocks.js';
import { getAtlasTexture } from '../world/textures.js';

const SIZE = 0.28;
const PICKUP_RADIUS = 1.4;
/** Within this range a drop you have room for flies to you. */
const MAGNET_RADIUS = 3.2;
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
  const spanU = 1 / ATLAS_COLS;
  const spanV = 1 / ATLAS_ROWS;
  const u0 = col * spanU;
  const v0 = 1 - (row + 1) * spanV;

  // BoxGeometry UVs are all 0 or 1; remap them into this tile's rect, inset a
  // little so neighbouring tiles cannot bleed in.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      u0 + (0.03 + uv.getX(i) * 0.94) * spanU,
      v0 + (0.03 + uv.getY(i) * 0.94) * spanV
    );
  }
  uv.needsUpdate = true;

  geometryCache.set(id, geometry);
  return geometry;
}

export class ItemEntity {
  /**
   * @param durability carried through so dropped tools keep their wear
   * @param extra `{ ench, work }` carried through so enchantments survive a drop
   */
  constructor(world, position, id, count = 1, durability, extra = null) {
    this.world = world;
    this.id = id;
    this.count = count;
    this.durability = durability;
    this.ench = extra?.ench ?? null;
    this.work = extra?.work ?? 0;

    this.position = position.clone();
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 1.6,
      2.2,
      (Math.random() - 0.5) * 1.6
    );

    this.age = 0;
    this.removed = false;

    // Its own copy of the shared material, so it can be shaded by the light
    // where it lies (see setLight). Items are few; the copies are cheap.
    this.mesh = new THREE.Mesh(getGeometry(id), getMaterial().clone());
    this._shade = -1;
    this.mesh.position.copy(this.position);
  }

  update(dt, ctx) {
    this.age += dt;
    // Expired, or fell out of the world through the Aether's void.
    if (this.age > LIFETIME || this.position.y < -32) {
      this.removed = true;
      return;
    }

    // Close enough, and with room in your pack: glide in instead of waiting
    // to be walked over, faster the nearer it gets.
    if (this._magnet(dt, ctx.player)) return;

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

  _magnet(dt, player) {
    if (this.age < PICKUP_DELAY || player.survival.dead) return false;
    const tx = player.position.x;
    const ty = player.position.y + 0.9;
    const tz = player.position.z;
    const dx = tx - this.position.x, dy = ty - this.position.y, dz = tz - this.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > MAGNET_RADIUS) return false;
    if (player.inventory.roomFor(this.id) <= 0) return false;

    const speed = 3 + (MAGNET_RADIUS - distance) * 5;
    const move = Math.min(distance, speed * dt);
    this.position.x += (dx / distance) * move;
    this.position.y += (dy / distance) * move;
    this.position.z += (dz / distance) * move;
    this.velocity.set(0, 0, 0);
    const shrink = Math.max(0.35, Math.min(1, distance / 1.2));
    this.mesh.scale.setScalar(shrink);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.age * 4;
    if (distance < 0.45) this._tryPickup(player);
    return true;
  }

  _tryPickup(player) {
    if (this.age < PICKUP_DELAY || player.survival.dead) return;

    const dx = player.position.x - this.position.x;
    const dy = player.position.y + 0.9 - this.position.y;
    const dz = player.position.z - this.position.z;
    if (Math.hypot(dx, dy, dz) > PICKUP_RADIUS) return;

    const stack = { id: this.id, count: this.count };
    if (this.durability !== undefined) stack.durability = this.durability;
    if (this.ench) stack.ench = this.ench;
    if (this.work) stack.work = this.work;

    const leftover = player.inventory.addExisting(stack);
    if (leftover === 0) {
      this.removed = true;
      if (this.onPickup) this.onPickup(this);
    } else if (leftover < this.count) {
      this.count = leftover; // inventory filled up part-way
    }
  }

  /** Light where it lies, from EntityManager.applyLighting. */
  setLight(k) {
    const shade = Math.round(k * 40) / 40;
    if (shade === this._shade) return;
    this._shade = shade;
    this.mesh.material.color.setScalar(shade);
  }

  dispose() {
    // Geometry is shared and cached; the material is this item's own copy.
    this.mesh.material.dispose();
  }
}
