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
import { moveWithCollision, isInLiquid, isSupported } from '../player/physics.js';
import { raycastVoxels } from '../player/raycast.js';
import { CHUNK_SY } from '../world/chunk.js';
import { BLOCKS, AIR } from '../world/blocks.js';
import { audio } from '../engine/audio.js';

/** Babies render at this fraction of adult size. */
const BABY_SCALE = 0.55;

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

    // --- Husbandry ----------------------------------------------------------
    /** Seconds left in the "willing to breed" state after being fed. */
    this.loveTimer = 0;
    /** Seconds before this animal can breed again. */
    this.breedCooldown = 0;
    /** Babies are smaller, faster and cannot breed until grown. */
    this.isBaby = false;
    /** Seconds until a baby becomes an adult. */
    this.growTimer = 0;
    /** Sheep only: sheared until the wool grows back. */
    this.sheared = false;
    this.woolRegrow = 0;
    /** Sustingus only: fed, and now sustaining whoever fed it. */
    this.attuned = false;
    /** Wolf only: tamed with a bone, and told to stay put. */
    this.tamed = false;
    this.sitting = false;

    this.attackCooldown = 0;
    /** Per-instance melee overrides; null falls back to `type.brain`. */
    this.attackDamage = null;
    this.attackInterval = null;
    this.hurtTimer = 0;
    this.burnTimer = 0;
    this.deathTimer = 0;
    this.walkPhase = 0;
    this.age = 0;

    // --- Brain state ------------------------------------------------------
    /** 'idle' | 'wander' | 'chase' | 'attack' | 'flee' */
    this.state = 'wander';
    /** Whatever we are reacting to (currently always the player). */
    this.target = null;
    /** Refreshed on a timer rather than every frame — raycasts are not free. */
    this.canSeeTarget = false;
    this._losTimer = 0;
    /** Seconds since we last actually saw the target. */
    this.lostSightFor = 0;
    this.fleeTimer = 0;
    /** Countdown to the next idle vocalisation. Staggered so a freshly spawned
     *  group does not all call at once. */
    this._voiceTimer = 8 + Math.random() * 30;
    /** Distance to the listener, refreshed each think for audio falloff. */
    this._listenerDist = 0;
    /** Ranged attack cooldown, separate from melee. */
    this.rangedCooldown = 0;
    /** Sideways bias while circling a target, flipped occasionally. */
    this._strafeDir = Math.random() < 0.5 ? -1 : 1;
    this._strafeTimer = 0;
    this._leapCooldown = 0;
    /** Set by ranged AI so facing is not overridden by travel direction. */
    this._faceLocked = false;
    /** Set for one frame when a melee swing lands, for animation. */
    this.didAttack = false;

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
    this._updateHusbandry(dt);

    if (this.dead) {
      this._updateDeathAnimation(dt);
      return;
    }

    // Reset the AI's per-frame intent, then let the brain fill it in.
    this.moveX = 0;
    this.moveZ = 0;
    this.moveSpeed = this.type.speed;
    this.wantsJump = false;

    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.rangedCooldown > 0) this.rangedCooldown -= dt;
    if (this._leapCooldown > 0) this._leapCooldown -= dt;
    this.didAttack = false;
    this._faceLocked = false;

    this._think(dt, ctx);
    // Types may still add bespoke behaviour on top of the generic brain.
    if (this.type.ai) this.type.ai(this, dt, ctx);

    this._applyPhysics(dt);
    this._animate(dt);
    this._syncObject();
  }

  // -------------------------------------------------------------------------
  // Brain
  // -------------------------------------------------------------------------

  /**
   * Generic state machine, configured per species by `type.brain`.
   *
   * States: wander -> chase -> attack, plus flee when hurt. Hostiles need
   * *line of sight* to acquire you, and then keep hunting for a few seconds
   * after losing it — so breaking eye contact matters but hiding behind one
   * block does not instantly erase you.
   */
  _think(dt, ctx) {
    const brain = this.type.brain;
    if (!brain) return;

    const player = ctx.player;
    this.target = player;
    // Cached so takeDamage/die can attenuate without needing the context.
    this._listenerDist = this.distanceTo(player.eyePosition);

    this._updateSunlightBurn(dt, ctx, brain);
    this._updateVoice(dt, ctx);

    // Fleeing overrides everything else while it lasts.
    if (this.fleeTimer > 0) {
      this.fleeTimer -= dt;
      this.state = 'flee';
      this._steerAway(player.position, brain.fleeSpeed ?? 1.9);
      this._jumpIfBlocked();
      return;
    }

    const hunting = brain.hostile && !player.survival.dead && !(brain.dayTimid && ctx.isDay);
    if (!hunting) {
      this.state = 'wander';
      this._wander(dt);
      if (brain.avoidCliffs) this._avoidCliffs();
      return;
    }

    const distance = this.horizontalDistanceTo(player.position);
    const verticalGap = player.position.y - this.position.y;

    // Refresh line of sight on a timer; raycasts are the expensive part.
    this._losTimer -= dt;
    if (this._losTimer <= 0) {
      this._losTimer = 0.25;
      this.canSeeTarget = distance <= brain.sightRange && this._hasLineOfSight(player);
    }

    if (this.canSeeTarget) {
      this.lostSightFor = 0;
      // Shout so nearby friends join in.
      if (brain.packCall && this.state === 'wander' && ctx.entities) {
        ctx.entities.alertNearby(this, brain.packRadius ?? 12);
      }
    } else if (this.state === 'chase' || this.state === 'attack') {
      this.lostSightFor += dt;
    }

    const engaged =
      (this.canSeeTarget || this.lostSightFor < (brain.loseSightAfter ?? 5)) &&
      distance <= brain.sightRange * 1.4 &&
      Math.abs(verticalGap) < (brain.maxVerticalChase ?? 12);

    if (!engaged) {
      this.state = 'wander';
      this.lostSightFor = 0;
      this._wander(dt);
      if (brain.avoidCliffs) this._avoidCliffs();
      return;
    }

    // Ranged attackers hold their distance and circle instead of closing in.
    if (brain.ranged) {
      this._rangedBehaviour(dt, ctx, brain, distance, verticalGap);
      return;
    }

    if (distance <= brain.attackRange && Math.abs(verticalGap) < 2) {
      this.state = 'attack';
      // Ease off at contact range so mobs do not jitter against you.
      this._steerToward(player.position, 0.35);
      this._tryMelee(player, brain);
    } else {
      this.state = 'chase';
      this._steerToward(player.position, brain.chaseSpeed ?? 1);
    }

    // Jump obstacles, and jump when the player is standing above.
    if (this.onGround && (this.hitWall || (verticalGap > 0.9 && distance < 2.5))) {
      this.wantsJump = true;
    }
    if (brain.leaps && this.onGround && distance < brain.leaps.range && this.canSeeTarget) {
      this._tryLeap(player, brain.leaps);
    }
  }

  /** Skeletons: keep range, strafe, and shoot when they have a clear line. */
  _rangedBehaviour(dt, ctx, brain, distance, verticalGap) {
    const r = brain.ranged;
    const player = this.target;

    this._strafeTimer -= dt;
    if (this._strafeTimer <= 0) {
      this._strafeTimer = 1.5 + Math.random() * 2;
      this._strafeDir *= -1;
    }

    if (distance > r.range) {
      this.state = 'chase';
      this._steerToward(player.position, 1);
    } else if (distance < r.minRange) {
      this.state = 'chase';
      this._steerAway(player.position, 1);
    } else {
      this.state = 'attack';
      // Circle the player: perpendicular to the line between us.
      const dx = player.position.x - this.position.x;
      const dz = player.position.z - this.position.z;
      const len = Math.hypot(dx, dz) || 1;
      this.moveX = (-dz / len) * this._strafeDir;
      this.moveZ = (dx / len) * this._strafeDir;
      this.moveSpeed = this.type.speed * 0.6;
      // Face the player even while strafing.
      this.yaw = Math.atan2(dx, dz);
      this._faceLocked = true;
    }

    if (this.canSeeTarget && this.rangedCooldown <= 0 && distance <= r.range && Math.abs(verticalGap) < 6) {
      this.rangedCooldown = r.cooldown;
      if (ctx.entities) {
        ctx.entities.fireProjectile(this, player, r);
        audio.bow();
      }
    }

    if (this.onGround && this.hitWall) this.wantsJump = true;
  }

  _tryMelee(player, brain) {
    if (this.attackCooldown > 0) return;
    // `brain` is shared by every mob of a species, so per-instance tuning (the
    // Warden's phases) goes through these overrides rather than mutating it.
    this.attackCooldown = this.attackInterval ?? brain.attackCooldown ?? 1;
    this.didAttack = true;

    // Pass who is hitting, not just "a mob" — the death screen names the killer.
    if (!player.survival.damage(this.attackDamage ?? brain.attackDamage, 'mob', this.type)) return;

    // Knock the player back and up a little.
    const dx = player.position.x - this.position.x;
    const dz = player.position.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    player.velocity.x += (dx / len) * 5.5;
    player.velocity.z += (dz / len) * 5.5;
    if (player.onGround) player.velocity.y = 4.2;
  }

  /** Spiders pounce rather than plodding all the way in. */
  _tryLeap(player, leaps) {
    if (this._leapCooldown > 0) return;
    this._leapCooldown = leaps.cooldown;
    const dx = player.position.x - this.position.x;
    const dz = player.position.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    this.velocity.x = (dx / len) * leaps.power;
    this.velocity.z = (dz / len) * leaps.power;
    this.velocity.y = leaps.lift;
  }

  /** Clear line from this mob's eyes to the player's. */
  _hasLineOfSight(player) {
    const from = {
      x: this.position.x,
      y: this.position.y + this.height * 0.85,
      z: this.position.z,
    };
    const to = player.eyePosition;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.001) return true;

    const dir = { x: dx / distance, y: dy / distance, z: dz / distance };
    // Only opaque blocks break line of sight — glass and leaves do not, so you
    // cannot hide behind a window.
    const hit = raycastVoxels(this.world, from, dir, distance, (id) => {
      if (id === AIR) return false;
      const block = BLOCKS[id];
      return !!block && block.opaque;
    });
    return hit === null;
  }

  _updateSunlightBurn(dt, ctx, brain) {
    if (!brain.burnsInSunlight || !ctx.isDay || this.inLiquid || !this.isExposedToSky()) {
      this.burnTimer = 0;
      return;
    }
    this.burnTimer += dt;
    if (this.burnTimer >= 1) {
      this.burnTimer = 0;
      this.takeDamage(1);
    }
  }

  /**
   * Occasional idle noises so the world feels inhabited.
   *
   * The interval is deliberately long. Each mob calling every 6-18s sounds
   * reasonable in isolation, but with a herd of eight it produced a noise every
   * second or two, which was maddening. Distance is passed through so animals
   * across the valley are attenuated or dropped entirely.
   */
  _updateVoice(dt, ctx) {
    if (!this.type.voice) return;

    this._voiceTimer -= dt;
    if (this._voiceTimer > 0) return;
    this._voiceTimer = 22 + Math.random() * 28;

    // Do not even bother if the player could not hear it.
    const distance = ctx.player ? this.distanceTo(ctx.player.eyePosition) : 0;
    if (distance > 24) return;

    audio.mobSound(this.type.voice, 'idle', distance);
  }

  /** Distance from this mob to the listener, for audio falloff. */
  _listenerDistance(ctx) {
    return ctx && ctx.player ? this.distanceTo(ctx.player.eyePosition) : 0;
  }

  // --- Steering helpers -----------------------------------------------------

  _steerToward(point, speedScale = 1) {
    const dx = point.x - this.position.x;
    const dz = point.z - this.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    this.moveX = dx / len;
    this.moveZ = dz / len;
    this.moveSpeed = this.type.speed * speedScale;
  }

  _steerAway(point, speedScale = 1) {
    this._steerToward(point, speedScale);
    this.moveX = -this.moveX;
    this.moveZ = -this.moveZ;
  }

  _wander(dt) {
    const m = this.memory;
    m.wanderTimer = (m.wanderTimer ?? 0) - dt;

    if (m.wanderTimer <= 0) {
      m.wanderTimer = 3 + Math.random() * 5;
      if (Math.random() < 0.35) {
        m.wanderX = 0;
        m.wanderZ = 0; // stand and graze
      } else {
        const angle = Math.random() * Math.PI * 2;
        m.wanderX = Math.sin(angle);
        m.wanderZ = Math.cos(angle);
      }
    }

    this.moveX = m.wanderX ?? 0;
    this.moveZ = m.wanderZ ?? 0;
    this._jumpIfBlocked();
  }

  _jumpIfBlocked() {
    if (this.hitWall && this.onGround) this.wantsJump = true;
  }

  /** Stop passive mobs strolling off cliffs. */
  _avoidCliffs() {
    if (!this.onGround || (this.moveX === 0 && this.moveZ === 0)) return;

    const lookAhead = 0.9;
    const probe = {
      x: this.position.x + this.moveX * lookAhead,
      y: this.position.y,
      z: this.position.z + this.moveZ * lookAhead,
    };

    for (let drop = 1; drop <= 3; drop++) {
      if (this.world.isSolid(probe.x, this.position.y - drop, probe.z)) return;
    }

    this.moveX = 0;
    this.moveZ = 0;
    this.memory.wanderTimer = 0; // pick a new heading next frame
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
      // Chickens flap, so they drift down instead of plummeting.
      if (this.type.slowFall && this.velocity.y < -3) this.velocity.y = -3;
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

    // Face the direction of travel — unless the AI is aiming somewhere else,
    // as a strafing archer does.
    if (!this._faceLocked && (Math.abs(this.velocity.x) > 0.05 || Math.abs(this.velocity.z) > 0.05)) {
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
    // `die()` plays the death cry, so only sound hurt if we survived it.
    if (this.health > 0) audio.mobSound(this.type.voice, 'hurt', this._listenerDist ?? 0);

    // Anything that gets hit panics for a moment; hostiles then re-engage.
    const brain = this.type.brain;
    if (brain && brain.fleeWhenHurt) this.fleeTimer = brain.fleeWhenHurt;

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
    audio.mobSound(this.type.voice, 'death', this._listenerDist ?? 0);
  }

  /** Breeding timers, growing up, and wool growing back. */
  _updateHusbandry(dt) {
    if (this.loveTimer > 0) this.loveTimer -= dt;
    if (this.breedCooldown > 0) this.breedCooldown -= dt;

    if (this.isBaby) {
      this.growTimer -= dt;
      if (this.growTimer <= 0) this.growUp();
    }

    if (this.sheared) {
      this.woolRegrow -= dt;
      if (this.woolRegrow <= 0) {
        this.sheared = false;
        this.refreshModel();
      }
    }
  }

  /** Turn a baby into an adult: full size, and able to breed. */
  growUp() {
    if (!this.isBaby) return;
    this.isBaby = false;
    this.growTimer = 0;
    this.health = this.type.maxHealth;
    this.object3D.scale.setScalar(1);
  }

  /** Make this a newborn — half size, and a while before it can breed. */
  makeBaby(growSeconds) {
    this.isBaby = true;
    this.growTimer = growSeconds;
    this.health = Math.max(1, Math.round(this.type.maxHealth / 2));
    this.object3D.scale.setScalar(BABY_SCALE);
  }

  /**
   * Rebuild the visual after a state change that alters it — currently only
   * shearing. Cheaper than tracking every wool part individually, and it happens
   * a handful of times a session.
   */
  refreshModel() {
    if (!this.type.buildModel) return;
    const scale = this.object3D.scale.x;
    const parent = this.object3D.parent;
    const built = this.type.buildModel(this);
    built.group.position.copy(this.object3D.position);
    built.group.rotation.copy(this.object3D.rotation);
    built.group.scale.setScalar(scale);

    if (parent) {
      parent.remove(this.object3D);
      parent.add(built.group);
    }
    this.dispose();
    this.object3D = built.group;
    this.parts = built.parts;
  }

  /** Called by a pack-mate that spotted the player. */
  alert(target) {
    if (this.dead || this.state === 'chase' || this.state === 'attack') return;
    this.target = target;
    this.state = 'chase';
    // Believe the shout briefly even without seeing anything ourselves.
    this.lostSightFor = 0;
    this.canSeeTarget = false;
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
