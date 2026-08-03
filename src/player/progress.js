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

/**
 * The list.
 *
 * `check` is optional: an achievement with one is tested against the stats
 * after every `record()`, so counting goals need no special-casing at the call
 * site. Everything else is unlocked explicitly by name.
 */
export const ACHIEVEMENTS = [
  { name: 'wood', title: 'Getting Wood', hint: 'Break a log.' },
  { name: 'bench', title: 'Benchmarking', hint: 'Craft a crafting table.' },
  { name: 'pickaxe', title: 'Time to Mine', hint: 'Craft a pickaxe.' },
  { name: 'furnace', title: 'Hot Topic', hint: 'Craft a furnace.' },
  { name: 'iron', title: 'Acquire Hardware', hint: 'Smelt an iron ingot.' },
  { name: 'diamonds', title: 'Diamonds!', hint: 'Mine a diamond.' },
  {
    name: 'deep', title: 'Into the Deep', hint: 'Reach bedrock depth.',
  },
  { name: 'farmer', title: 'Bake Bread', hint: 'Bake a loaf of bread.' },
  { name: 'shepherd', title: 'Shear Delight', hint: 'Shear a sheep.' },
  { name: 'angler', title: 'Catch of the Day', hint: 'Catch a fish.' },
  { name: 'tamer', title: 'Best Friend', hint: 'Tame a wolf.' },
  { name: 'sailor', title: 'Row Your Boat', hint: 'Ride a boat.' },
  { name: 'dj', title: 'Put a Record On', hint: 'Play a record in a jukebox.' },
  { name: 'combium', title: 'White Metal', hint: 'Smelt a combium ingot.' },
  // Retitled when fire and water became igniters too — the name key is what
  // saves are matched on, so the wording can change freely.
  { name: 'portal', title: 'Doorway', hint: 'Light a portal of any kind.' },
  { name: 'comb', title: 'The Comb', hint: 'Set foot in the Comb.' },
  { name: 'obsidian', title: 'Cooling Off', hint: 'Make obsidian by pouring water on lava.' },
  { name: 'nether', title: 'Downward', hint: 'Light an obsidian portal and step through.' },
  { name: 'glowstone', title: 'Bring a Light', hint: 'Mine glowstone in the Nether.' },
  { name: 'aether', title: 'Upward', hint: 'Open a glowstone portal with water.' },
  { name: 'warden', title: 'Kingslayer', hint: 'Defeat the Warden of the Comb.' },
  { name: 'throne', title: 'Crowned', hint: 'Awaken a Comb throne.' },
  { name: 'skater', title: 'Drop In', hint: 'Ride a skateboard.' },
  { name: 'grinder', title: 'Rail Rider', hint: 'Grind a rail.' },
  {
    name: 'sevenTwenty', title: 'Seven Twenty', hint: 'Land a 720 spin.',
  },
  {
    name: 'stylish', title: 'Certified Stylish', hint: 'Bank 10,000 style points.',
    check: (stats) => stats.get('style') >= 10000,
  },
  {
    name: 'miner', title: 'Well Excavated', hint: 'Break 1,000 blocks.',
    check: (stats) => stats.get('blocksMined') >= 1000,
  },
  {
    name: 'walker', title: 'The Long Way', hint: 'Travel 10,000 blocks on foot.',
    check: (stats) => stats.get('distance') >= 10000,
  },
  {
    name: 'survivor', title: 'Still Here', hint: 'Survive ten days.',
    check: (stats) => stats.get('days') >= 10,
  },
];

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
      if (!achievement.check || this.earned.has(achievement.name)) continue;
      if (achievement.check(this.stats)) this.unlock(achievement.name);
    }
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
