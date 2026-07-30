/**
 * player.js — First-person controller.
 *
 * Owns look, movement, block interaction and the player's inventory/health.
 * Reads input, writes to the camera, and asks the world to mutate blocks —
 * it never touches rendering or the HUD directly.
 */

import * as THREE from 'three';
import Settings from '../settings.js';
import { moveWithCollision, isInLiquid, collidesWithWorld, isSupported } from './physics.js';
import { raycastVoxels } from './raycast.js';
import { Inventory } from './inventory.js';
import { Survival, EXHAUSTION } from './survival.js';
import { AIR, getBlock, isLiquid, getSoundMaterial, getRanged, ITEM_ID } from '../world/blocks.js';
import { audio } from '../engine/audio.js';

const P = Settings.player;
const HALF_PI = Math.PI / 2;

export class Player {
  /**
   * @param {import('../world/world.js').World} world
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../engine/input.js').Input} input
   */
  constructor(world, camera, input, options = {}) {
    this.world = world;
    this.camera = camera;
    this.input = input;

    this.position = new THREE.Vector3(options.x ?? 0.5, options.y ?? 80, options.z ?? 0.5);
    this.velocity = new THREE.Vector3();
    this.spawnPoint = this.position.clone();

    this.yaw = 0;
    this.pitch = 0;
    this.mouseSensitivity = options.sensitivity ?? 0.0022;

    this.onGround = false;
    this.inLiquid = false;
    this.sprinting = false;
    /** Shift is held (intent). */
    this.sneaking = false;
    /** Actually crouched — may stay true after releasing Shift under a ceiling. */
    this.crouching = false;
    /** Set when sneak protection stopped you walking off an edge. */
    this.blockedByLedge = false;
    this.flying = false;
    this.creative = false;
    /** Eye height is lerped so crouching does not snap the camera. */
    this._smoothedEyeHeight = P.eyeHeight;

    this.fallDistance = 0;
    this.bobPhase = 0;

    this.inventory = new Inventory();
    this.survival = new Survival();
    // Taking a hit wears down every worn piece, as in Minecraft.
    this.survival.onArmorHit = () => this.inventory.damageArmor(1);
    this.survival.onDamage(() => audio.playerHurt());

    /** Distance walked since the last footstep sound. */
    this._stepDistance = 0;
    this._wasInLiquid = false;

    /** Current block under the crosshair: {x,y,z,block,normal} or null. */
    this.targetBlock = null;
    /** Mining progress on `targetBlock`, 0..1. */
    this.breakProgress = 0;
    this._breakKey = null;
    this._placeCooldown = 0;
    this._eatCooldown = 0;
    this._attackCooldown = 0;
    /** Set for one frame when the player swings — the HUD animates from this. */
    this.didSwing = false;
    /** Bow draw, 0..1. Drives arrow power and the viewmodel pose. */
    this.drawProgress = 0;

    this.camera.rotation.order = 'YXZ';

    // Callbacks the game layer can hook into.
    /** @type {((id:number)=>void)|null} */
    this.onBlockBroken = null;
    /** @type {((id:number)=>void)|null} */
    this.onBlockPlaced = null;
  }

  /** Collision height — shorter while crouching. */
  get height() {
    return this.crouching ? P.sneakHeight : P.height;
  }

  /** Target eye height for the current stance. */
  get eyeHeight() {
    return this.crouching ? P.sneakEyeHeight : P.eyeHeight;
  }

  get eyePosition() {
    return new THREE.Vector3(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z
    );
  }

  /** Camera-space forward direction (normalised). */
  getLookDirection(target = new THREE.Vector3()) {
    return this.camera.getWorldDirection(target);
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {{entities?: import('../entities/entityManager.js').EntityManager}} ctx
   */
  update(dt, ctx = {}) {
    this.didSwing = false;
    // Creative players are untouchable, so armour is irrelevant there.
    this.survival.invulnerable = this.creative;
    this.survival.armorPoints = this.creative ? 0 : this.inventory.armorPoints;
    this._placeCooldown = Math.max(0, this._placeCooldown - dt);
    this._eatCooldown = Math.max(0, this._eatCooldown - dt);
    this._attackCooldown = Math.max(0, this._attackCooldown - dt);

    this._updateLook();
    this._updateHotbarSelection();

    if (!this.survival.dead) {
      this._updateMovement(dt);
      this._updateEnvironment(dt);
      this._updateTarget();
      this._updateInteraction(dt, ctx);
    } else {
      // Dead players still fall, so the camera does not hang in mid-air.
      this._applyGravity(dt);
      this._integrate(dt);
      this.targetBlock = null;
    }

    this.survival.update(dt);
    this._syncCamera(dt);
  }

  // -------------------------------------------------------------------------
  // Look
  // -------------------------------------------------------------------------

  _updateLook() {
    if (!this.input.locked) return;
    this.yaw -= this.input.mouseDeltaX * this.mouseSensitivity;
    this.pitch -= this.input.mouseDeltaY * this.mouseSensitivity;
    // Clamp just shy of straight up/down to avoid gimbal weirdness.
    this.pitch = Math.max(-HALF_PI + 0.001, Math.min(HALF_PI - 0.001, this.pitch));
  }

  _syncCamera(dt) {
    let bobOffset = 0;
    // Subtle head bob while walking; purely cosmetic, safe to delete.
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && horizontalSpeed > 0.5) {
      this.bobPhase += dt * horizontalSpeed * 1.7;
      bobOffset = Math.sin(this.bobPhase * 2) * 0.035;
    }

    // Ease the eye toward the stance's height so crouching is smooth.
    const blend = 1 - Math.exp(-14 * dt);
    this._smoothedEyeHeight += (this.eyeHeight - this._smoothedEyeHeight) * blend;

    this.camera.position.set(
      this.position.x,
      this.position.y + this._smoothedEyeHeight + bobOffset,
      this.position.z
    );
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = this.yaw;
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  _updateMovement(dt) {
    const input = this.input;

    // Creative-only flight, so survival keeps its stakes.
    if (input.actionWasPressed('fly') && this.creative) {
      this.flying = !this.flying;
      this.velocity.y = 0;
    }
    if (!this.creative) this.flying = false;

    this.sneaking = input.isActionDown('crouch');
    this._updateStance();
    this.inLiquid = isInLiquid(this.world, this.position, P.width, this.height);

    // Desired horizontal direction in world space, from yaw.
    let wishX = 0;
    let wishZ = 0;
    if (input.isActionDown('forward')) wishZ -= 1;
    if (input.isActionDown('back')) wishZ += 1;
    if (input.isActionDown('left')) wishX -= 1;
    if (input.isActionDown('right')) wishX += 1;

    const moving = wishX !== 0 || wishZ !== 0;

    // Double-tapping forward also sprints, as in Minecraft. Worth having as
    // well as the modifier, since a browser makes Ctrl combinations awkward.
    this._updateDoubleTapSprint(dt, input);

    this.sprinting =
      moving && !this.sneaking &&
      (input.isActionDown('sprint') || this._doubleTapSprint) &&
      this.survival.hunger > 6;

    // Releasing forward ends a double-tap sprint.
    if (!input.isActionDown('forward')) this._doubleTapSprint = false;

    let dirX = 0;
    let dirZ = 0;
    if (moving) {
      const len = Math.hypot(wishX, wishZ);
      wishX /= len;
      wishZ /= len;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // Rotate the local wish vector into world space around Y.
      // At yaw 0 the camera looks down -Z, so W (wishZ = -1) must give dirZ = -1.
      dirX = wishX * cos + wishZ * sin;
      dirZ = -wishX * sin + wishZ * cos;
    }

    const speed = this._currentSpeed();
    const targetVX = dirX * speed;
    const targetVZ = dirZ * speed;

    // Exponential smoothing gives frame-rate independent acceleration.
    const responsiveness = this.flying ? 14 : this.onGround ? 16 : 3.5;
    const blend = 1 - Math.exp(-responsiveness * dt);
    this.velocity.x += (targetVX - this.velocity.x) * blend;
    this.velocity.z += (targetVZ - this.velocity.z) * blend;

    if (this.flying) {
      this._updateFlight(dt);
    } else {
      this._updateJumpAndGravity(dt);
    }

    const before = this.position.clone();
    this._integrate(dt);

    this._trackExhaustion(before);
  }

  /**
   * Resolve the crouch stance.
   *
   * Standing up is not always allowed: if there is a block just overhead, the
   * taller hitbox would intersect it, so we stay crouched until there is room.
   * That is what lets you crawl through a 2-block-high tunnel without being
   * shoved into the ceiling the moment you release Shift.
   *
   * While flying, Shift means "descend", so it must not also crouch.
   */
  _updateStance() {
    if (this.flying) {
      this.crouching = false;
      return;
    }

    if (this.sneaking) {
      this.crouching = true;
      return;
    }

    if (this.crouching) {
      const fits = !collidesWithWorld(this.world, this.position, P.width, P.height);
      if (fits) this.crouching = false;
    }
  }

  /**
   * Double-tap forward to sprint. Two presses inside the window latch sprinting
   * until forward is released.
   */
  _updateDoubleTapSprint(dt, input) {
    this._tapWindow = Math.max(0, (this._tapWindow ?? 0) - dt);

    if (!input.actionWasPressed('forward')) return;
    if (this._tapWindow > 0) {
      this._doubleTapSprint = true;
      this._tapWindow = 0;
    } else {
      this._tapWindow = 0.3;
    }
  }

  _currentSpeed() {
    if (this.flying) return this.input.isActionDown('sprint') ? P.flySpeed * 2 : P.flySpeed;
    if (this.inLiquid) return P.walkSpeed * 0.55;
    if (this.sneaking) return P.sneakSpeed;
    if (this.sprinting) return P.sprintSpeed;
    return P.walkSpeed;
  }

  _updateFlight(dt) {
    let vy = 0;
    if (this.input.isActionDown('jump')) vy += 1;
    if (this.sneaking) vy -= 1;
    const target = vy * this._currentSpeed();
    this.velocity.y += (target - this.velocity.y) * (1 - Math.exp(-14 * dt));
    this.fallDistance = 0;
  }

  _updateJumpAndGravity(dt) {
    const wantsUp = this.input.isActionDown('jump');

    if (this.inLiquid) {
      // Swimming: gentle buoyancy, and Space paddles upward.
      this.velocity.y += (wantsUp ? 6 : -3.5) * dt * 4;
      this.velocity.y = Math.max(-3, Math.min(4, this.velocity.y));
      this.fallDistance = 0;
    } else {
      if (wantsUp && this.onGround) {
        this.velocity.y = P.jumpVelocity;
        this.survival.addExhaustion(this.sprinting ? EXHAUSTION.sprintJump : EXHAUSTION.jump);
        audio.jump();
      }
      this._applyGravity(dt);
    }
  }

  _applyGravity(dt) {
    this.velocity.y -= P.gravity * dt;
    if (this.velocity.y < -P.terminalVelocity) this.velocity.y = -P.terminalVelocity;
  }

  _integrate(dt) {
    const wasAirborne = !this.onGround;

    const result = moveWithCollision(
      this.world,
      this.position,
      this.velocity,
      { width: P.width, height: this.height },
      dt,
      {
        stepHeight: P.stepHeight,
        // Crouching stops you shuffling off a ledge, as in Minecraft.
        preventFalling: this.crouching && !this.flying && !this.inLiquid,
      }
    );
    this.blockedByLedge = result.blockedByLedge;

    // --- Fall damage -------------------------------------------------------
    if (!result.onGround) {
      if (this.velocity.y < 0) this.fallDistance += -this.velocity.y * dt;
      else this.fallDistance = 0; // rising resets the counter
    } else if (wasAirborne || this.fallDistance > 0) {
      if (!this.flying && !this.inLiquid) {
        if (this.fallDistance > 0.8) audio.fall(this.fallDistance);
        if (this.fallDistance > Settings.survival.fallDamageThreshold) {
          const damage = Math.floor(this.fallDistance - Settings.survival.fallDamageThreshold);
          if (damage > 0) this.survival.damage(damage, 'fall');
        }
      }
      this.fallDistance = 0;
    }

    // Entering or leaving water splashes.
    if (this.inLiquid !== this._wasInLiquid) {
      this._wasInLiquid = this.inLiquid;
      if (this.inLiquid) audio.splash();
    }

    this.onGround = result.onGround;

    // Safety net: if the player ends up under the world, put them back.
    if (this.position.y < -10) {
      this.survival.damage(4, 'void');
      this.respawn();
    }
  }

  /** Environmental hazards. Currently just lava; extend here for drowning etc. */
  _updateEnvironment(dt) {
    this.inLava =
      this.world.isLava(this.position.x, this.position.y + 0.1, this.position.z) ||
      this.world.isLava(this.position.x, this.position.y + 0.9, this.position.z);

    if (!this.inLava || this.creative) {
      this._lavaTimer = 0;
      return;
    }

    // Lava ignores the usual invulnerability window, so standing in it is fatal.
    this._lavaTimer = (this._lavaTimer ?? 0) + dt;
    if (this._lavaTimer >= 0.5) {
      this._lavaTimer = 0;
      this.survival.invulnerableFor = 0;
      this.survival.damage(4, 'lava');
    }
  }

  /** Convert distance travelled into hunger exhaustion, and step sounds. */
  _trackExhaustion(previousPosition) {
    const dx = this.position.x - previousPosition.x;
    const dz = this.position.z - previousPosition.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= 0) return;

    // Footsteps are distance-based, so they stay in step at any speed.
    if (this.onGround && !this.flying) {
      this._stepDistance += distance;
      const stride = this.crouching ? 1.4 : this.sprinting ? 1.9 : 2.2;
      if (this._stepDistance >= stride) {
        this._stepDistance = 0;
        audio.footstep(this._groundMaterial());
      }
    }

    if (this.creative) return;
    this.survival.addExhaustion(
      distance * (this.sprinting ? EXHAUSTION.perBlockSprinted : EXHAUSTION.perBlockWalked)
    );
  }

  /** Sound material of whatever we are standing on. */
  _groundMaterial() {
    const below = this.world.getBlock(this.position.x, this.position.y - 0.1, this.position.z);
    return getSoundMaterial(below);
  }

  // -------------------------------------------------------------------------
  // Hotbar
  // -------------------------------------------------------------------------

  _updateHotbarSelection() {
    const input = this.input;
    for (let i = 0; i < 9; i++) {
      if (input.wasPressed('Digit' + (i + 1))) this.inventory.selectSlot(i);
    }
    if (input.wheelDelta !== 0) {
      this.inventory.scrollSelection(input.wheelDelta > 0 ? 1 : -1);
    }
  }

  // -------------------------------------------------------------------------
  // Block targeting & interaction
  // -------------------------------------------------------------------------

  _updateTarget() {
    const origin = this.eyePosition;
    const direction = this.getLookDirection();
    this.targetBlock = raycastVoxels(this.world, origin, direction, P.reach);

    // Restarting on a different block cancels mining progress.
    const key = this.targetBlock
      ? `${this.targetBlock.x},${this.targetBlock.y},${this.targetBlock.z}`
      : null;
    if (key !== this._breakKey) {
      this._breakKey = key;
      this.breakProgress = 0;
    }
  }

  _updateInteraction(dt, ctx) {
    const input = this.input;
    if (!input.locked) return;

    // --- Left click: attack a mob, otherwise mine ---------------------------
    if (input.mouseWasPressed(0)) {
      if (this._tryAttack(ctx)) {
        this.breakProgress = 0;
        return;
      }
    }

    if (input.isMouseDown(0) && this.targetBlock) {
      this._updateMining(dt);
    } else {
      this.breakProgress = 0;
    }

    // --- Bow: hold right click to draw, release to fire --------------------
    const bow = getRanged(this.inventory.getSelected()?.id);
    if (bow) {
      if (input.isMouseDown(2)) {
        this.drawProgress = Math.min(1, this.drawProgress + dt / bow.drawTime);
        audio.bowDraw(this.drawProgress);
      } else if (this.drawProgress > 0) {
        this._fireBow(bow, ctx);
        this.drawProgress = 0;
      }
      // A drawn bow does nothing else on right click.
      return;
    }
    this.drawProgress = 0;

    // --- Right click: use a station, else eat, else place ------------------
    // MouseEvent.button: 0 = left, 1 = middle, 2 = right.
    if (input.isMouseDown(2) && this._placeCooldown === 0) {
      // Sneaking suppresses station UIs so you can still build against them.
      if (!this.sneaking && this._tryUseBlock()) {
        this._placeCooldown = 0.4;
      } else if (this._tryEat()) {
        this._eatCooldown = 0.8;
        this._placeCooldown = 0.8;
      } else if (this._tryPlace(ctx)) {
        this._placeCooldown = 0.18;
      }
    }
  }

  /**
   * Throw items out of the held stack into the world.
   * Q drops one; Ctrl+Q drops the whole stack.
   * @returns {boolean} whether anything was dropped
   */
  dropHeld(whole = false, ctx = {}) {
    const slot = this.inventory.getSelected();
    if (!slot || !ctx.entities) return false;

    const count = whole ? slot.count : 1;
    const id = slot.id;
    const durability = slot.durability;

    this.inventory.consumeSelected(count);
    this.throwItem(id, count, ctx.entities, durability);
    return true;
  }

  /** Spawn an item entity in front of the player's face, moving away. */
  throwItem(id, count, entities, durability) {
    const eye = this.eyePosition;
    const dir = this.getLookDirection();

    const item = entities.dropItem(
      eye.x + dir.x * 0.4,
      eye.y - 0.2 + dir.y * 0.4,
      eye.z + dir.z * 0.4,
      id,
      count,
      durability
    );

    // Toss it along the view direction rather than letting it drop straight down.
    item.velocity.set(dir.x * 5, dir.y * 5 + 1.4, dir.z * 5);
    // Brief pickup delay so it does not fly straight back into the inventory.
    item.age = -0.6;
    return item;
  }

  /**
   * Release the bowstring.
   *
   * Damage and speed scale with how far it was drawn, so a snap shot is weak
   * and a full draw hurts. Creative mode does not consume arrows.
   */
  _fireBow(bow, ctx) {
    // A barely-touched string should not fire at all.
    if (this.drawProgress < 0.15) return;
    if (!ctx.entities) return;

    const hasArrow = this.creative || this.inventory.countOf(ITEM_ID.ARROW) > 0;
    if (!hasArrow) return;
    if (!this.creative) this.inventory.removeFirst(ITEM_ID.ARROW, 1);

    const charge = this.drawProgress;
    const speed = bow.speed * (0.4 + charge * 0.6);
    const damage = bow.minDamage + (bow.maxDamage - bow.minDamage) * charge * charge;

    const eye = this.eyePosition;
    const dir = this.getLookDirection();
    const velocity = {
      x: dir.x * speed + (Math.random() - 0.5) * speed * bow.spread,
      y: dir.y * speed + (Math.random() - 0.5) * speed * bow.spread,
      z: dir.z * speed + (Math.random() - 0.5) * speed * bow.spread,
    };

    ctx.entities.spawnArrow(
      { x: eye.x + dir.x * 0.5, y: eye.y + dir.y * 0.5, z: eye.z + dir.z * 0.5 },
      velocity,
      this,
      damage
    );

    audio.bow();
    this.didSwing = true;
    if (!this.creative) this.inventory.damageHeldTool(1);
  }

  /** Right-clicking a crafting table or furnace opens its interface. */
  _tryUseBlock() {
    const target = this.targetBlock;
    if (!target || !this.onUseStation) return false;
    return this.onUseStation(target.block, target.x, target.y, target.z) === true;
  }

  _updateMining(dt) {
    const target = this.targetBlock;
    const def = getBlock(target.block);
    if (!def || def.hardness === Infinity) {
      this.breakProgress = 0;
      return;
    }

    this.didSwing = true;

    if (this.creative) {
      this._breakBlock(target);
      return;
    }

    // The right tool class multiplies mining speed; the wrong one is no better
    // than bare hands.
    const tool = this.inventory.getHeldTool();
    const speed = tool && tool.kind === def.toolType ? tool.speed : 1;

    audio.dig(getSoundMaterial(target.block));

    this.breakProgress += (dt * speed) / def.hardness;
    if (this.breakProgress >= 1) this._breakBlock(target);
  }

  /** Can the held tool actually collect this block's drop? */
  canHarvest(def) {
    if (this.creative) return true;
    if (!def.requiresTool) return true;
    const tool = this.inventory.getHeldTool();
    const tier = tool ? tool.tier : -1;
    return tier >= def.harvestLevel;
  }

  _breakBlock(target) {
    const def = getBlock(target.block);
    this.world.setBlock(target.x, target.y, target.z, AIR);
    audio.blockBreak(getSoundMaterial(def.id));
    this.breakProgress = 0;
    this._breakKey = null;

    if (!this.creative) {
      // Mining a diamond with a stone pickaxe destroys the block and yields
      // nothing — this gate is what drives the tool progression.
      if (this.canHarvest(def) && def.drops) {
        const [min, max] = def.dropCount;
        const count = min + Math.floor(Math.random() * (max - min + 1));
        if (count > 0) this.inventory.add(def.drops, count);
      } else if (def.drops && !this.canHarvest(def)) {
        this.lastHarvestFailure = def;
      }

      if (this.inventory.getHeldTool() && this.inventory.damageHeldTool(1)) audio.toolBreak();
      this.survival.addExhaustion(EXHAUSTION.mineBlock);
    }

    if (this.onBlockBroken) this.onBlockBroken(def.id, target);
  }

  _tryPlace(ctx) {
    const target = this.targetBlock;
    if (!target) return false;

    const held = this.inventory.getHeldBlock();
    if (!held) return false;

    const x = target.x + target.normal.x;
    const y = target.y + target.normal.y;
    const z = target.z + target.normal.z;

    // Only replace air or liquid.
    const existing = this.world.getBlock(x, y, z);
    if (existing !== AIR && !isLiquid(existing)) return false;

    // Never entomb the player in a solid block. Non-solid blocks (water, lava)
    // are fine to place at your own feet, exactly as in Minecraft.
    if (getBlock(held).solid && this._intersectsBlock(x, y, z)) return false;
    // …or a mob.
    if (ctx.entities && ctx.entities.anyMobIntersectsBlock(x, y, z)) return false;

    // Doors are two blocks tall; refuse the placement unless both fit.
    const def = getBlock(held);
    if (def.name === 'door') {
      const above = this.world.getBlock(x, y + 1, z);
      if (above !== AIR && !isLiquid(above)) return false;
      if (!this.world.setBlock(x, y, z, held)) return false;
      this.world.setBlock(x, y + 1, z, held);
    } else if (!this.world.setBlock(x, y, z, held)) {
      return false;
    }

    if (!this.creative) this.inventory.consumeSelected(1);
    audio.blockPlace(getSoundMaterial(held));
    this.didSwing = true;
    if (this.onBlockPlaced) this.onBlockPlaced(held);
    return true;
  }

  _tryEat() {
    const food = this.inventory.getHeldFood();
    if (!food) return false;
    if (!this.survival.eat(food)) return false;
    if (!this.creative) this.inventory.consumeSelected(1);
    audio.eat();
    return true;
  }

  _tryAttack(ctx) {
    if (!ctx.entities || this._attackCooldown > 0) return false;

    const origin = this.eyePosition;
    const direction = this.getLookDirection();
    const hit = ctx.entities.raycast(origin, direction, P.reach);
    if (!hit) return false;

    // A block in front of the mob blocks the swing.
    if (this.targetBlock && this.targetBlock.distance < hit.distance) return false;

    this._attackCooldown = 0.45;
    this.didSwing = true;

    // Swords hit hardest; other tools are middling weapons; fists are weakest.
    const tool = this.inventory.getHeldTool();
    const damage = tool ? tool.damage : 2;
    hit.mob.takeDamage(damage, { x: direction.x, y: 0.45, z: direction.z });

    if (!this.creative) {
      if (tool) this.inventory.damageHeldTool(1);
      this.survival.addExhaustion(EXHAUSTION.attack);
    }
    return true;
  }

  /** Would a block at these coordinates overlap the player's box? */
  _intersectsBlock(x, y, z) {
    const hw = P.width / 2;
    return (
      this.position.x - hw < x + 1 && this.position.x + hw > x &&
      this.position.y < y + 1 && this.position.y + this.height > y &&
      this.position.z - hw < z + 1 && this.position.z + hw > z
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Move to a safe spot above the given column. */
  teleportToSurface(x, z) {
    const surfaceY = this.world.getSurfaceY(x, z);
    const y = surfaceY >= 0 ? surfaceY + 1 : 80;
    this.position.set(x + 0.5, y + 0.1, z + 0.5);
    this.velocity.set(0, 0, 0);
    this.fallDistance = 0;
    this.onGround = false;

    // Nudge upward if we landed inside geometry (e.g. under a tree).
    let guard = 0;
    while (collidesWithWorld(this.world, this.position, P.width, P.height) && guard++ < 32) {
      this.position.y += 1;
    }
  }

  respawn() {
    this.survival.respawn();
    this.teleportToSurface(Math.floor(this.spawnPoint.x), Math.floor(this.spawnPoint.z));
    this.fallDistance = 0;
    if (!this.creative) {
      // Classic survival penalty: you lose what you were carrying.
      this.inventory.clear();
      this.inventory.giveStarterItems();
    }
  }

  /**
   * Switch game mode.
   *
   * `allowCreative` is a property of the *world*, decided when it was created,
   * so the caller gates this. The guard here is a second line of defence: it
   * means no future call site can accidentally promote a survival world.
   */
  toggleCreative(allowCreative = true) {
    if (!allowCreative) {
      this.creative = false;
      this.flying = false;
      return false;
    }
    this.creative = !this.creative;
    if (!this.creative) this.flying = false;
    return this.creative;
  }
}
