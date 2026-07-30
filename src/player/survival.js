/**
 * survival.js — Health, hunger and death.
 *
 * Models the classic loop: activity burns exhaustion, exhaustion burns
 * saturation then hunger, a full hunger bar regenerates health, and an empty
 * one starves you. Keeping it in its own module means the renderer, HUD and
 * mobs all talk to one small, testable state machine.
 */

import Settings from '../settings.js';

/** Exhaustion needed to consume one saturation/hunger point. */
const EXHAUSTION_PER_POINT = 4.0;

/** Damage sources armour cannot protect against. */
const ARMOR_IGNORES = new Set(['starve', 'void', 'drown']);

/** Exhaustion costs for various actions (roughly Minecraft's values). */
export const EXHAUSTION = {
  perBlockWalked: 0.01,
  perBlockSprinted: 0.10,
  jump: 0.05,
  sprintJump: 0.20,
  attack: 0.10,
  mineBlock: 0.005,
  regen: 1.5,
  damageTaken: 0.10,
};

export class Survival {
  constructor(options = {}) {
    this.maxHealth = options.maxHealth ?? Settings.survival.maxHealth;
    this.maxHunger = options.maxHunger ?? Settings.survival.maxHunger;

    this.health = this.maxHealth;
    this.hunger = this.maxHunger;
    this.saturation = 5;
    this.exhaustion = 0;

    this.dead = false;
    this.invulnerableFor = 0; // brief i-frames after taking a hit
    this.lastDamageCause = null;

    /**
     * Total worn armour points, refreshed by the player each frame.
     * Each point removes 4% of incoming damage, capped at 80% — Minecraft's
     * formula, so full diamond (20 points) blocks 80%.
     */
    this.armorPoints = 0;

    /**
     * Creative players take no damage at all, as in Minecraft. Set by the
     * player each frame from its game mode.
     */
    this.invulnerable = false;

    this._regenTimer = 0;
    this._starveTimer = 0;

    /** @type {((cause:string)=>void)|null} */
    this.onDeath = null;
    /**
     * Damage listeners. A list rather than a single callback because several
     * systems care independently — the HUD flashes the screen, audio plays a
     * hurt sound, and armour takes wear.
     * @type {Array<(amount:number, cause:string)=>void>}
     */
    this.damageListeners = [];
  }

  /** Subscribe to damage events. */
  onDamage(listener) {
    this.damageListeners.push(listener);
    return () => {
      const i = this.damageListeners.indexOf(listener);
      if (i >= 0) this.damageListeners.splice(i, 1);
    };
  }

  get healthFraction() {
    return this.health / this.maxHealth;
  }

  addExhaustion(amount) {
    if (this.dead) return;
    this.exhaustion += amount;

    while (this.exhaustion >= EXHAUSTION_PER_POINT) {
      this.exhaustion -= EXHAUSTION_PER_POINT;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  /**
   * @param {number} amount hit points
   * @param {string} cause 'fall' | 'mob' | 'starve' | 'void' | ...
   * @returns {boolean} whether the damage was actually applied
   */
  damage(amount, cause = 'generic') {
    if (this.dead || amount <= 0 || this.invulnerable) return false;
    // Ignore repeat hits during i-frames, except for continuous sources.
    if (this.invulnerableFor > 0 && cause !== 'starve' && cause !== 'drown') return false;

    // Armour protects against physical damage but not starvation or the void.
    let applied = amount;
    if (this.armorPoints > 0 && !ARMOR_IGNORES.has(cause)) {
      applied = amount * (1 - Math.min(0.8, this.armorPoints * 0.04));
      // Never fully negate a hit, and never round a real hit down to nothing.
      applied = Math.max(0.5, applied);
      if (this.onArmorHit) this.onArmorHit(amount, cause);
    }

    this.health = Math.max(0, this.health - applied);
    this.lastDamageCause = cause;
    this.invulnerableFor = 0.5;
    this.addExhaustion(EXHAUSTION.damageTaken);

    for (const listener of this.damageListeners) listener(applied, cause);

    if (this.health <= 0) {
      this.dead = true;
      if (this.onDeath) this.onDeath(cause);
    }
    return true;
  }

  heal(amount) {
    if (this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * Consume a food item.
   * @returns {boolean} false if already full (so the item is not wasted)
   */
  eat(food) {
    if (this.dead || this.hunger >= this.maxHunger) return false;
    this.hunger = Math.min(this.maxHunger, this.hunger + food.food);
    // Saturation is capped by the current hunger level, as in Minecraft.
    this.saturation = Math.min(this.hunger, this.saturation + food.saturation);
    return true;
  }

  update(dt) {
    if (this.dead) return;

    if (this.invulnerableFor > 0) this.invulnerableFor -= dt;

    // Passive drain so standing still still costs you eventually.
    this.addExhaustion(0.01 * dt);

    // --- Regeneration: a well-fed player slowly heals ---------------------
    if (this.hunger >= 18 && this.health < this.maxHealth) {
      this._regenTimer += dt;
      const interval = this.saturation > 0 ? 2.0 : 4.0;
      if (this._regenTimer >= interval) {
        this._regenTimer = 0;
        this.heal(1);
        this.addExhaustion(EXHAUSTION.regen);
      }
    } else {
      this._regenTimer = 0;
    }

    // --- Starvation --------------------------------------------------------
    if (this.hunger <= 0) {
      this._starveTimer += dt;
      if (this._starveTimer >= 4.0) {
        this._starveTimer = 0;
        this.damage(1, 'starve');
      }
    } else {
      this._starveTimer = 0;
    }
  }

  /** Reset to a fresh spawn state. */
  respawn() {
    this.health = this.maxHealth;
    this.hunger = this.maxHunger;
    this.saturation = 5;
    this.exhaustion = 0;
    this.dead = false;
    this.invulnerableFor = 0;
    this._regenTimer = 0;
    this._starveTimer = 0;
  }
}
