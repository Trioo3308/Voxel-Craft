/**
 * experience.js — Experience points and levels.
 *
 * Jev's pick for the late game was Minecraft's classic model (see
 * JEV_DECISIONS.md): orbs from mobs, ores, smelting, fishing and breeding fill
 * a bar; levels are spent at the enchanting table and the anvil. The numbers
 * are Minecraft's, so the curve feels familiar: the first levels come in a few
 * orbs, level 30 takes a long evening.
 *
 * Only the running total of points is stored. The level and the bar are
 * derived from it, so there is no way for them to disagree after a load.
 */

import { idByName } from '../world/blocks.js';
import { packEntries } from '../content/packs.js';

/**
 * Experience for mining a block, [min, max] by block id: the packs' `miningXp`
 * lists (content/core.json). Ores that are smelted pay at the furnace instead.
 */
export const MINING_XP = new Map();
for (const entry of packEntries('miningXp')) {
  const id = idByName(entry.block);
  if (id === null) {
    console.warn(`[packs] ${entry.pack} miningXp: nothing is called "${entry.block}"`);
    continue;
  }
  const min = Math.max(0, entry.min | 0);
  MINING_XP.set(id, [min, Math.max(min, entry.max | 0)]);
}

/** Points needed to go from `level` to `level + 1`. */
export function pointsForLevel(level) {
  if (level >= 30) return 9 * level - 158;
  if (level >= 15) return 5 * level - 38;
  return 2 * level + 7;
}

/** Total points it takes to reach `level` from nothing. */
export function totalForLevel(level) {
  let total = 0;
  for (let l = 0; l < level; l++) total += pointsForLevel(l);
  return total;
}

/**
 * Orb sizes a reward is split into, largest first — Minecraft's own, so a big
 * reward is a few big orbs rather than a cloud of tiny ones.
 */
const ORB_SIZES = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1];

export function splitIntoOrbs(points) {
  const orbs = [];
  let left = Math.floor(points);
  while (left > 0) {
    const size = ORB_SIZES.find((s) => s <= left);
    orbs.push(size);
    left -= size;
  }
  return orbs;
}

/**
 * A fractional reward (a smelted ingot is worth 0.7): the whole part, plus one
 * more with the remainder as the chance, so it averages out exactly.
 */
export function roundXp(amount, random = Math.random) {
  const whole = Math.floor(amount);
  return whole + (random() < amount - whole ? 1 : 0);
}

/** A whole number in [min, max], for "this ore is worth 3-7". */
export function xpBetween(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

export class Experience {
  constructor() {
    this.total = 0;
    this.level = 0;
    /** How far through the current level, 0..1. */
    this.progress = 0;
    /** Called with the new level whenever it goes up. */
    this.onLevelUp = null;
  }

  /** Set the total outright, as a load does. */
  setTotal(total) {
    this.total = Math.max(0, Math.floor(Number(total) || 0));
    this._derive();
  }

  add(points) {
    if (!(points > 0)) return;
    const before = this.level;
    this.total += Math.floor(points);
    this._derive();
    if (this.level > before && this.onLevelUp) this.onLevelUp(this.level, before);
  }

  /**
   * Spend whole levels, keeping how far through the level you were, as
   * Minecraft does: enchanting at 31 for 3 levels leaves you at 28 with the
   * same bar.
   */
  spendLevels(levels) {
    const target = Math.max(0, this.level - levels);
    this.total = totalForLevel(target) + Math.floor(this.progress * pointsForLevel(target));
    this._derive();
  }

  /** Take raw points, for Mending. */
  takePoints(points) {
    this.total = Math.max(0, this.total - points);
    this._derive();
  }

  _derive() {
    let level = 0;
    let left = this.total;
    while (left >= pointsForLevel(level)) {
      left -= pointsForLevel(level);
      level++;
    }
    this.level = level;
    this.progress = left / pointsForLevel(level);
  }
}
