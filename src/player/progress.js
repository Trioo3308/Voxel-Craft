/**
 * progress.js — Achievements and lifetime statistics.
 *
 * Both are pure bookkeeping with no dependencies on the rest of the game: the
 * world calls `record()` and `unlock()`, and this file decides what that means.
 * Keeping it standalone is what lets the achievement list grow without touching
 * anything that generates the events.
 *
 * Achievements are stored by *name*, never by index, for the same reason block
 * ids are remapped by name on load — reordering or inserting one must not
 * silently re-grant or revoke somebody's progress.
 */

import { packEntries, PACKS } from '../content/packs.js';

/**
 * The advancement tree, from the packs' `advancements` lists (content/core.json):
 * each has a `tab`, a `parent` (none for a tab's root), a `frame` ('task',
 * 'goal' or 'challenge') and an `icon` by name. Phase 3 turned the flat list
 * into this tree (Jev's pick; JEV_DECISIONS.md).
 *
 * `when` is optional: an advancement with one unlocks itself when the game
 * reports a matching event (see `notify`) or, for `stat`, when a counter
 * passes a threshold. Everything else is unlocked explicitly by name from the
 * game code, so advancements from older builds keep their triggers.
 */
export const ACHIEVEMENTS = packEntries('advancements').filter(
  (a) => typeof a.name === 'string' && typeof a.title === 'string'
);

/** Tabs, in order, from the packs' `advancementTabs` lists. */
export const ADVANCEMENT_TABS = [];
for (const pack of PACKS) {
  for (const tab of pack.advancementTabs ?? []) {
    if (!ADVANCEMENT_TABS.some((t) => t.id === tab.id)) ADVANCEMENT_TABS.push(tab);
  }
}

const BY_NAME = new Map(ACHIEVEMENTS.map((a) => [a.name, a]));

/**
 * Counters.
 *
 * Every stat is a plain number so the whole thing serialises as one object and
 * an unknown key from a future build survives a round trip untouched.
 */
export const STAT_LABELS = {
  blocksMined: 'Blocks mined',
  blocksPlaced: 'Blocks placed',
  distance: 'Distance travelled',
  mobsDefeated: 'Mobs defeated',
  deaths: 'Deaths',
  days: 'Days survived',
  itemsCrafted: 'Items crafted',
  fishCaught: 'Fish caught',
  style: 'Lifetime style',
  bestCombo: 'Best single run',
  discsPlayed: 'Records played',
};

/** Stats shown as a distance rather than a bare count. */
const DISTANCE_STATS = new Set(['distance']);

export class Statistics {
  constructor() {
    this.values = {};
    for (const key of Object.keys(STAT_LABELS)) this.values[key] = 0;
  }

  get(key) {
    return this.values[key] ?? 0;
  }

  /** Add to a counter. */
  record(key, amount = 1) {
    this.values[key] = (this.values[key] ?? 0) + amount;
  }

  /** Set a counter only if the new value is higher — for records, not totals. */
  recordBest(key, value) {
    if (value > (this.values[key] ?? 0)) this.values[key] = value;
  }

  /** `[label, formatted]` pairs, in declaration order, for the stats screen. */
  rows() {
    return Object.entries(STAT_LABELS).map(([key, label]) => {
      const value = this.get(key);
      const text = DISTANCE_STATS.has(key)
        ? `${Math.round(value).toLocaleString()} blocks`
        : Math.round(value).toLocaleString();
      return [label, text];
    });
  }

  serialize() {
    return { ...this.values };
  }

  load(data) {
    if (!data) return;
    // Merge rather than replace, so a stat added in a later build starts at 0
    // instead of undefined.
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number' && Number.isFinite(value)) this.values[key] = value;
    }
  }
}

export class Achievements {
  /** @param stats the Statistics instance the counting goals are tested against */
  constructor(stats) {
    this.stats = stats;
    /** @type {Set<string>} */
    this.earned = new Set();
    /** Called with the achievement when one is first earned. */
    this.onUnlock = null;
  }

  has(name) {
    return this.earned.has(name);
  }

  /**
   * Grant an achievement.
   * @returns true only the first time, so callers can fire a toast without
   *          having to check first.
   */
  unlock(name) {
    const achievement = BY_NAME.get(name);
    // An unknown name is a caller bug, not a save problem — but silently doing
    // nothing is better than throwing in the middle of a frame.
    if (!achievement || this.earned.has(name)) return false;
    this.earned.add(name);
    if (this.onUnlock) this.onUnlock(achievement);
    return true;
  }

  /** Re-test every counting achievement. Cheap: the list is short. */
  checkAll() {
    for (const achievement of ACHIEVEMENTS) {
      const stat = achievement.when?.stat;
      if (!Array.isArray(stat) || this.earned.has(achievement.name)) continue;
      if (this.stats.get(stat[0]) >= stat[1]) this.unlock(achievement.name);
    }
  }

  /**
   * Something happened that an advancement might be waiting for.
   *   notify('crafted', 'book')           a name, or any of a list of names
   *   notify('enchanted', shelves)         at least this many bookshelves
   *   notify('level', 30)                  at least this level
   *   notify('discovered', 'fortress')
   *   notify('event', 'map')               a named one-off
   */
  notify(kind, value) {
    for (const achievement of ACHIEVEMENTS) {
      if (this.earned.has(achievement.name)) continue;
      const want = achievement.when?.[kind];
      if (want === undefined) continue;
      const hit = typeof want === 'number' ? value >= want
        : Array.isArray(want) ? want.includes(value)
        : want === value;
      if (hit) this.unlock(achievement.name);
    }
  }

  /**
   * Whether the tree shows an advancement yet: earned ones, tab roots, and
   * anything whose parent is earned. Deeper ones stay hidden, as in Minecraft.
   */
  visible(achievement) {
    return !achievement.parent || this.earned.has(achievement.name) || this.earned.has(achievement.parent);
  }

  get progress() {
    return { earned: this.earned.size, total: ACHIEVEMENTS.length };
  }

  /** Every achievement with its earned flag, for the list screen. */
  rows() {
    return ACHIEVEMENTS.map((a) => ({ ...a, earned: this.earned.has(a.name) }));
  }

  serialize() {
    return [...this.earned];
  }

  load(names) {
    if (!Array.isArray(names)) return;
    this.earned = new Set(names.filter((n) => BY_NAME.has(n)));
  }
}
