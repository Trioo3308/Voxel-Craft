/**
 * mob.js — Base mob entity.
 *
 * A Mob is deliberately thin: it owns physics, health and animation state, and
 * delegates *behaviour* to the `ai` function on its type definition (see
 * mobTypes.js). Adding a creature therefore means writing one type object, not
 * subclassing anything.
 *
 * Mobs reuse the player's collision code, so they interact with terrain exactly
 * the way the player does.
 */

import * as THREE from 'three';
import { moveWithCollision, isInLiquid } from '../player/physics.js';
import { CHUNK_SY } from '../world/chunk.js';

const GRAVITY = 28;
const TERMINAL_VELOCITY = 55;

export class Mob {
  /**
   * @param {object} type entry from mobTypes.js
   * @param {import('../world/world.js').World} world
   * @param {THREE.Vector3} position feet-centre spawn position
   */
  constructor(type, world, position) {
    this.type = type;
    this.world = world;

    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;

    this.health = type.maxHealth;
    this.dead = false;
    this.removed = false;

    this.onGround = false;
    this.hitWall = false;
    this.inLiquid = false;

    // --- AI scratch space (the type's `ai` writes these) -------------------
    /** Normalised horizontal move direction; zero means "stand still". */
    this.moveX = 0;
    this.moveZ = 0;
    this.moveSpeed = type.speed;
    this.wantsJump = false;
    /** Free-form per-type state so AI functions stay stateless themselves. */
    this.memory = {};

    this.attackCooldown = 0;
    this.hurtTimer = 0;
    this.burnTimer = 0;
    this.deathTimer = 0;
    this.walkPhase = 0;
    this.age = 0;

    // --- Render model ------------------------------------------------------
    const built = type.buildModel();
    this.object3D = built.group;
    this.parts = built.parts;
    this.object3D.position.copy(this.position);
  }

  get width() { return this.type.width; }
  get height() { return this.type.height; }

  /** Centre of the mob's bounding box (used for aiming and distance checks). */
  getCenter(target = new THREE.Vector3()) {
    return target.set(this.position.x, this.position.y + this.height / 2, this.position.z);
  }

  distanceTo(point) {
    const dx = this.position.x - point.x;
    const dy = this.position.y + this.height / 2 - point.y;
    const dz = this.position.z - point.z;
    return Math.hypot(dx, dy, dz);
  }

  /** Horizontal distance only — better for chase logic on uneven ground. */
  horizontalDistanceTo(point) {
    return Math.hypot(this.position.x - point.x, this.position.z - point.z);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt, ctx) {
    this.age += dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.hurtTimer > 0) this.hurtTimer -= dt;

    if (this.dead) {
      this._updateDeathAnimation(dt);
      return;
    }

    // Reset the AI's per-frame intent, then let the type fill it in.
    this.moveX = 0;
    this.moveZ = 0;
    this.moveSpeed = this.type.speed;
    this.wantsJump = false;
    this.type.ai(this, dt, ctx);

    this._applyPhysics(dt);
    this._animate(dt);
    this._syncObject();
  }

  _applyPhysics(dt) {
    this.inLiquid = isInLiquid(this.world, this.position, this.width, this.height);

    // Horizontal steering, smoothed for frame-rate independence.
    const targetVX = this.moveX * this.moveSpeed;
    const targetVZ = this.moveZ * this.moveSpeed;
    const blend = 1 - Math.exp(-(this.onGround ? 12 : 3) * dt);
    this.velocity.x += (targetVX - this.velocity.x) * blend;
    this.velocity.z += (targetVZ - this.velocity.z) * blend;

    if (this.wantsJump && this.onGround) this.velocity.y = 8.0;

    if (this.inLiquid) {
      // Float rather than sink, so mobs do not drown in shallow water.
      this.velocity.y += (this.wantsJump ? 5 : -2) * dt * 4;
      this.velocity.y = Math.max(-2.5, Math.min(3.5, this.velocity.y));
    } else {
      this.velocity.y -= GRAVITY * dt;
      if (this.velocity.y < -TERMINAL_VELOCITY) this.velocity.y = -TERMINAL_VELOCITY;
    }

    const previousY = this.position.y;
    const result = moveWithCollision(
      this.world,
      this.position,
      this.velocity,
      { width: this.width, height: this.height },
      dt,
      { stepHeight: 0.6 }
    );

    this.onGround = result.onGround;
    this.hitWall = result.hitWall;

    // Fall damage, at half the player's sensitivity.
    if (result.onGround && !this.inLiquid) {
      const fell = (this.memory._peakY ?? previousY) - this.position.y;
      if (fell > 4) this.takeDamage(Math.floor((fell - 4) * 0.5));
      this.memory._peakY = this.position.y;
    } else if (this.velocity.y > 0 || this.position.y > (this.memory._peakY ?? -Infinity)) {
      this.memory._peakY = this.position.y;
    }

    // Face the direction of travel.
    if (Math.abs(this.velocity.x) > 0.05 || Math.abs(this.velocity.z) > 0.05) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      // Shortest-arc interpolation so mobs never spin the long way round.
      let delta = targetYaw - this.yaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.yaw += delta * Math.min(1, dt * 10);
    }
  }

  _animate(dt) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * speed * 3.2;
    const swing = Math.sin(this.walkPhase) * Math.min(0.9, speed * 0.28);

    // Legs and arms counter-swing in pairs.
    if (this.parts.legFrontLeft) this.parts.legFrontLeft.rotation.x = swing;
    if (this.parts.legFrontRight) this.parts.legFrontRight.rotation.x = -swing;
    if (this.parts.legBackLeft) this.parts.legBackLeft.rotation.x = -swing;
    if (this.parts.legBackRight) this.parts.legBackRight.rotation.x = swing;
    if (this.parts.armLeft) this.parts.armLeft.rotation.x = this.type.armsForward ? -HALF_PI_ISH + swing * 0.4 : -swing;
    if (this.parts.armRight) this.parts.armRight.rotation.x = this.type.armsForward ? -HALF_PI_ISH - swing * 0.4 : swing;

    // Flash red briefly when hurt.
    const hurt = this.hurtTimer > 0;
    if (hurt !== this._wasHurt) {
      this._wasHurt = hurt;
      this.object3D.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        if (!child.userData.baseColor) child.userData.baseColor = child.material.color.clone();
        if (hurt) child.material.color.setRGB(1, 0.35, 0.35);
        else child.material.color.copy(child.userData.baseColor);
      });
    }
  }

  _syncObject() {
    this.object3D.position.copy(this.position);
    this.object3D.rotation.y = this.yaw;
  }

  _updateDeathAnimation(dt) {
    this.deathTimer += dt;
    // Topple over, then let the manager clean us up.
    this.object3D.rotation.z = Math.min(Math.PI / 2, this.deathTimer * 4);
    this.object3D.position.y = this.position.y + Math.min(0.3, this.deathTimer * 0.6);
    if (this.deathTimer > 0.6) this.removed = true;
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  /**
   * @param {number} amount hit points
   * @param {{x,y,z}} [knockback] impulse direction
   */
  takeDamage(amount, knockback) {
    if (this.dead || amount <= 0) return;
    if (this.hurtTimer > 0.25) return; // i-frames

    this.health -= amount;
    this.hurtTimer = 0.4;

    if (knockback) {
      const strength = 6;
      this.velocity.x += knockback.x * strength;
      this.velocity.z += knockback.z * strength;
      this.velocity.y = Math.max(this.velocity.y, (knockback.y ?? 0.4) * strength);
    }

    // Let the type react (pigs panic, etc.).
    if (this.type.onDamaged) this.type.onDamaged(this);

    if (this.health <= 0) this.die();
  }

  die() {
    this.dead = true;
    this.deathTimer = 0;
    this.velocity.set(0, 0, 0);
  }

  /** Is this mob's box overlapping the unit cube at (x, y, z)? */
  intersectsBlock(x, y, z) {
    const hw = this.width / 2;
    return (
      this.position.x - hw < x + 1 && this.position.x + hw > x &&
      this.position.y < y + 1 && this.position.y + this.height > y &&
      this.position.z - hw < z + 1 && this.position.z + hw > z
    );
  }

  /** True when nothing solid sits between this mob and the sky. */
  isExposedToSky() {
    const x = Math.floor(this.position.x);
    const z = Math.floor(this.position.z);
    const startY = Math.floor(this.position.y + this.height);
    for (let y = startY; y < CHUNK_SY; y++) {
      if (this.world.isSolid(x, y, z)) return false;
    }
    return true;
  }

  dispose() {
    this.object3D.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
        if (child.material.dispose) child.material.dispose();
      }
    });
  }
}

// Arms-out pose for zombies (~90 degrees).
const HALF_PI_ISH = Math.PI / 2;
