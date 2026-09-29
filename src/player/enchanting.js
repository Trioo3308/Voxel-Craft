/**
 * enchanting.js — What enchantments exist, what they go on, what the enchanting
 * table offers, and what the anvil makes of two items.
 *
 * Jev's pick was Minecraft's classic model (JEV_DECISIONS.md), so the rules are
 * Minecraft's: three offers whose power grows with nearby bookshelves, paid in
 * levels and lapis; offers fixed by a per-player seed until you enchant, so
 * reopening the table cannot re-roll them; an anvil that merges books into gear
 * and repairs with the gear's own material, getting dearer with each use.
 *
 * A stack's enchantments live on it as `ench: { name: level }`, keyed by these
 * names — never by index, for the same reason blocks are saved by name.
 * Enchanted gear and books never stack, so an enchanted stack is always its own
 * object and moves through the inventory, chests and drops intact.
 *
 * Pure rules: no DOM, no Three.js. The HUD draws the screens, the player
 * applies the effects.
 */

import { ITEM_ID, getTool, getArmor, getDurability, getThing } from '../world/blocks.js';
import { mulberry32 } from '../world/noise.js';

const DIGGERS = ['pickaxe', 'axe', 'shovel', 'hoe'];
const ARMOUR = ['helmet', 'chestplate', 'leggings', 'boots'];
const WEARABLE = [...DIGGERS, ...ARMOUR, 'sword', 'bow', 'rod', 'shears', 'igniter'];

/**
 * The list. `min(n)` is the lowest table power level n can appear at, `span`
 * how far above that it still can: Minecraft's ranges. `on` lists what it goes
 * on; enchantments sharing a `group` exclude each other. `treasure` ones are
 * never offered by the table — they only turn up as loot.
 */
export const ENCHANTMENTS = {
  protection: { label: 'Protection', max: 4, weight: 10, on: ARMOUR, min: (n) => 1 + (n - 1) * 11, span: 11 },
  feather_falling: { label: 'Feather Falling', max: 4, weight: 5, on: ['boots'], min: (n) => 5 + (n - 1) * 6, span: 6 },
  respiration: { label: 'Respiration', max: 3, weight: 2, on: ['helmet'], min: (n) => 10 * n, span: 30 },
  sharpness: { label: 'Sharpness', max: 5, weight: 10, on: ['sword', 'axe'], min: (n) => 1 + (n - 1) * 11, span: 20 },
  knockback: { label: 'Knockback', max: 2, weight: 5, on: ['sword'], min: (n) => 5 + (n - 1) * 20, span: 50 },
  looting: { label: 'Looting', max: 3, weight: 2, on: ['sword'], min: (n) => 15 + (n - 1) * 9, span: 50 },
  efficiency: { label: 'Efficiency', max: 5, weight: 10, on: [...DIGGERS, 'shears'], min: (n) => 1 + (n - 1) * 10, span: 50 },
  silk_touch: { label: 'Silk Touch', max: 1, weight: 1, on: DIGGERS, min: () => 15, span: 50, group: 'drops' },
  fortune: { label: 'Fortune', max: 3, weight: 2, on: DIGGERS, min: (n) => 15 + (n - 1) * 9, span: 50, group: 'drops' },
  unbreaking: { label: 'Unbreaking', max: 3, weight: 5, on: WEARABLE, min: (n) => 5 + (n - 1) * 8, span: 50 },
  power: { label: 'Power', max: 5, weight: 10, on: ['bow'], min: (n) => 1 + (n - 1) * 10, span: 15 },
  punch: { label: 'Punch', max: 2, weight: 2, on: ['bow'], min: (n) => 12 + (n - 1) * 20, span: 25 },
  infinity: { label: 'Infinity', max: 1, weight: 1, on: ['bow'], min: () => 20, span: 30, group: 'upkeep' },
  lure: { label: 'Lure', max: 3, weight: 2, on: ['rod'], min: (n) => 15 + (n - 1) * 9, span: 50 },
  mending: { label: 'Mending', max: 1, weight: 2, on: WEARABLE, min: () => 25, span: 50, group: 'upkeep', treasure: true },
};

const NAMES = Object.keys(ENCHANTMENTS);

// ---------------------------------------------------------------------------
// What an item is
// ---------------------------------------------------------------------------

/** 'book', a tool kind ('pickaxe', 'sword', 'bow'...), an armour piece, or null. */
export function enchantCategory(id) {
  if (id === ITEM_ID.BOOK || id === ITEM_ID.ENCHANTED_BOOK) return 'book';
  const tool = getTool(id);
  if (tool) return tool.kind;
  const armor = getArmor(id);
  if (armor) return armor.piece;
  return null;
}

/** Can this enchantment go on this item at all (books take anything)? */
export function appliesTo(name, id) {
  const def = ENCHANTMENTS[name];
  const category = enchantCategory(id);
  return !!def && !!category && (category === 'book' || def.on.includes(category));
}

/**
 * How readily an item takes enchantments at the table: Minecraft's values, with
 * combium placed between iron and gold. Shears and flint and steel only take
 * books at the anvil, as in Minecraft.
 */
const TOOL_ENCHANTABILITY = { wood: 15, stone: 5, iron: 14, gold: 22, diamond: 10, combium: 18 };
const ARMOUR_ENCHANTABILITY = { iron: 9, gold: 25, diamond: 10, combium: 15 };

export function enchantability(id) {
  if (id === ITEM_ID.BOOK) return 1;
  const tool = getTool(id);
  if (tool) {
    if (tool.kind === 'bow' || tool.kind === 'rod') return 1;
    if (tool.kind === 'shears' || tool.kind === 'igniter') return 0;
    return TOOL_ENCHANTABILITY[tool.material] ?? 10;
  }
  const armor = getArmor(id);
  if (armor) return ARMOUR_ENCHANTABILITY[armor.material] ?? 10;
  return 0;
}

// ---------------------------------------------------------------------------
// Reading a stack
// ---------------------------------------------------------------------------

export function enchantLevel(stack, name) {
  return (stack && stack.ench && stack.ench[name]) | 0;
}

export function isEnchanted(stack) {
  return !!stack && !!stack.ench && Object.keys(stack.ench).length > 0;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export function roman(n) {
  return ROMAN[n] ?? String(n);
}

/** "Efficiency III" lines, in the list's own order. */
export function describeEnchantments(stack) {
  if (!isEnchanted(stack)) return [];
  return NAMES.filter((name) => stack.ench[name]).map((name) => {
    const def = ENCHANTMENTS[name];
    return def.max === 1 ? def.label : `${def.label} ${roman(stack.ench[name])}`;
  });
}

/** A name for anything, enchanted book included. */
export function stackName(stack) {
  return getThing(stack.id)?.displayName ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// Rolling enchantments
// ---------------------------------------------------------------------------

const randInt = (rng, n) => Math.floor(rng() * n);

/** Every enchantment that could appear on `id` at this power, at its best level. */
function candidates(id, power, treasure) {
  const out = [];
  for (const name of NAMES) {
    const def = ENCHANTMENTS[name];
    if ((def.treasure && !treasure) || !appliesTo(name, id)) continue;
    for (let n = def.max; n >= 1; n--) {
      if (power >= def.min(n) && power <= def.min(n) + def.span) {
        out.push({ name, level: n, weight: def.weight });
        break;
      }
    }
  }
  return out;
}

function pickWeighted(list, rng) {
  const total = list.reduce((sum, e) => sum + e.weight, 0);
  let ticket = rng() * total;
  for (const entry of list) {
    ticket -= entry.weight;
    if (ticket < 0) return entry;
  }
  return list[list.length - 1];
}

const excludes = (a, b) => a === b || (!!ENCHANTMENTS[a].group && ENCHANTMENTS[a].group === ENCHANTMENTS[b].group);

/**
 * Minecraft's selection: the item's enchantability and a ±15% wobble push the
 * power around, one enchantment is drawn by weight, and further ones follow
 * with a chance that halves each time.
 * @returns {{name, level}[]}
 */
export function rollEnchantments(id, power, rng, treasure = false) {
  const ench = Math.max(1, enchantability(id));
  let level = power + 1 + randInt(rng, Math.floor(ench / 4) + 1) + randInt(rng, Math.floor(ench / 4) + 1);
  level = Math.max(1, Math.round(level * (1 + (rng() + rng() - 1) * 0.15)));

  let pool = candidates(id, level, treasure);
  const chosen = [];
  if (pool.length === 0) return chosen;
  chosen.push(pickWeighted(pool, rng));
  while (rng() < (level + 1) / 50) {
    const last = chosen[chosen.length - 1].name;
    pool = pool.filter((e) => !excludes(e.name, last));
    if (pool.length === 0) break;
    chosen.push(pickWeighted(pool, rng));
    level = Math.floor(level / 2);
  }
  return chosen.map(({ name, level: n }) => ({ name, level: n }));
}

// ---------------------------------------------------------------------------
// The enchanting table
// ---------------------------------------------------------------------------

/** Only unenchanted gear and plain books go on the table. */
export function tableAccepts(stack) {
  return !!stack && stack.count === 1 && enchantability(stack.id) > 0 && !isEnchanted(stack);
}

/**
 * Bookshelves feeding a table at (x, y, z), counted as Minecraft does: shelves
 * two blocks out at the table's height or one above, with air in between.
 * Capped at 15, which makes the top offer 30.
 */
export function countBookshelves(getBlock, x, y, z, shelfId) {
  let n = 0;
  const shelf = (bx, by, bz) => (getBlock(bx, by, bz) === shelfId ? 1 : 0);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      if (getBlock(x + dx, y, z + dz) !== 0 || getBlock(x + dx, y + 1, z + dz) !== 0) continue;
      n += shelf(x + dx * 2, y, z + dz * 2) + shelf(x + dx * 2, y + 1, z + dz * 2);
      if (dx !== 0 && dz !== 0) {
        n += shelf(x + dx * 2, y, z + dz) + shelf(x + dx * 2, y + 1, z + dz);
        n += shelf(x + dx, y, z + dz * 2) + shelf(x + dx, y + 1, z + dz * 2);
      }
    }
  }
  return Math.min(15, n);
}

/**
 * The three offers for an item, from the player's enchanting seed: a level
 * requirement, the levels and lapis it costs (one, two, three), and the full
 * list of what it gives. `hint` is the one enchantment the table shows.
 */
export function tableOffers(stack, shelves, seed) {
  if (!tableAccepts(stack)) return [null, null, null];
  const rng = mulberry32(seed >>> 0);
  const books = Math.min(15, shelves);
  const base = 1 + randInt(rng, 8) + Math.floor(books / 2) + randInt(rng, books + 1);
  const costs = [Math.max(Math.floor(base / 3), 1), Math.floor((base * 2) / 3) + 1, Math.max(base, books * 2)];
  return costs.map((cost, i) => {
    if (cost < i + 1) return null;
    const enchantments = rollEnchantments(stack.id, cost, mulberry32((seed + i * 7919 + 1) >>> 0));
    if (enchantments.length === 0) return null;
    return { cost, levels: i + 1, lapis: i + 1, enchantments, hint: enchantments[0] };
  });
}

/** Put a roll on a stack; a book becomes an enchanted book. Returns the new stack. */
export function applyEnchantments(stack, enchantments) {
  const id = stack.id === ITEM_ID.BOOK ? ITEM_ID.ENCHANTED_BOOK : stack.id;
  const ench = { ...(stack.ench ?? {}) };
  for (const { name, level } of enchantments) ench[name] = Math.max(ench[name] ?? 0, level);
  return { ...stack, id, count: 1, ench };
}

/**
 * A random enchanted stack for loot. Gear is enchanted as the table would at
 * `power`; a book gets one enchantment picked evenly from everything (Mending
 * too when `treasure` allows it) at a random level, as Minecraft's found books
 * are — the table's power curve would never reach Mending on a book.
 */
export function enchantForLoot(id, power, treasure = false, random = Math.random) {
  if (id === ITEM_ID.ENCHANTED_BOOK) {
    const pool = NAMES.filter((name) => treasure || !ENCHANTMENTS[name].treasure);
    const name = pool[Math.floor(random() * pool.length)];
    const level = 1 + Math.floor(random() * ENCHANTMENTS[name].max);
    return applyEnchantments({ id: ITEM_ID.BOOK, count: 1 }, [{ name, level }]);
  }
  const list = rollEnchantments(id, power, mulberry32(Math.floor(random() * 0x7fffffff)), treasure);
  const base = { id, count: 1 };
  const max = getDurability(id);
  if (max > 0) base.durability = max;
  return list.length ? applyEnchantments(base, list) : base;
}

// ---------------------------------------------------------------------------
// The anvil
// ---------------------------------------------------------------------------

/** What each material of gear is repaired with, by name. */
const REPAIR_MATERIAL = {
  wood: 'planks', stone: 'cobblestone', iron: 'iron_ingot', gold: 'gold_ingot',
  diamond: 'diamond', combium: 'combium_ingot',
};

/** The anvil gives up past this many levels in survival: "Too expensive!". */
export const ANVIL_LIMIT = 40;

/** How much each level of an enchantment costs at the anvil, by rarity. */
const multiplier = (name, fromBook) => {
  const w = ENCHANTMENTS[name].weight;
  const m = w >= 10 ? 1 : w >= 5 ? 2 : w >= 2 ? 4 : 8;
  return fromBook ? Math.max(1, m / 2) : m;
};

/**
 * Combine what is in the anvil's two slots.
 * @param idByName resolves repair material names
 * @returns {{result, cost, uses}|null} the output, its price in levels, and
 *   how many of the right-hand stack it consumes; null if nothing happens
 */
export function anvilCombine(left, right, idByName) {
  if (!left || !right) return null;
  const leftCat = enchantCategory(left.id);
  // A plain book is enchanted at the table, not by pressing another book on it.
  if (!leftCat || left.id === ITEM_ID.BOOK) return null;
  const maxDurability = getDurability(left.id);
  const priorWork = (left.work | 0) + (right.work | 0);
  const result = { ...left, count: 1, ench: { ...(left.ench ?? {}) } };
  let cost = 0;
  let uses = 1;

  // Repair with the gear's own material: a quarter of full durability each.
  const tool = getTool(left.id);
  const armor = getArmor(left.id);
  const material = REPAIR_MATERIAL[(tool ?? armor)?.material];
  const materialId = material ? idByName(material) : null;
  if (materialId !== null && right.id === materialId && maxDurability > 0) {
    const missing = maxDurability - (left.durability ?? maxDurability);
    if (missing <= 0) return null;
    const perUnit = Math.ceil(maxDurability / 4);
    uses = Math.min(right.count, Math.ceil(missing / perUnit));
    result.durability = Math.min(maxDurability, (left.durability ?? maxDurability) + uses * perUnit);
    cost = uses;
  } else {
    // Merge an item or a book into this one.
    const fromBook = right.id === ITEM_ID.ENCHANTED_BOOK;
    if (!fromBook && right.id !== left.id) return null;
    if (!fromBook && maxDurability > 0 && left.durability !== undefined) {
      // Two worn tools make one with both lots of wear back, plus 12%.
      const combined = (left.durability ?? maxDurability) + (right.durability ?? maxDurability) + Math.floor(maxDurability * 0.12);
      if (combined > (left.durability ?? maxDurability)) {
        result.durability = Math.min(maxDurability, combined);
        cost += 2;
      }
    }
    let applied = false;
    for (const [name, level] of Object.entries(right.ench ?? {})) {
      if (!ENCHANTMENTS[name] || !appliesTo(name, left.id)) continue;
      if (Object.keys(result.ench).some((other) => other !== name && excludes(other, name))) continue;
      const current = result.ench[name] ?? 0;
      const next = Math.min(ENCHANTMENTS[name].max, current === level ? level + 1 : Math.max(current, level));
      if (next <= current) continue;
      result.ench[name] = next;
      cost += next * multiplier(name, fromBook);
      applied = true;
    }
    if (!applied && result.durability === left.durability) return null;
  }

  // Every trip to the anvil makes the next one dearer: 0, 1, 3, 7, 15...
  cost += (2 ** priorWork) - 1;
  result.work = Math.max(left.work | 0, right.work | 0) + 1;
  if (Object.keys(result.ench).length === 0) delete result.ench;
  return { result, cost: Math.max(1, cost), uses };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Does this use actually wear the item, given Unbreaking? Tools skip wear with
 * chance 1 - 1/(n+1); armour mostly wears regardless, as in Minecraft.
 */
export function wearsOut(stack, random = Math.random) {
  const n = enchantLevel(stack, 'unbreaking');
  if (!n) return true;
  if (getArmor(stack.id)) return random() < 0.6 + 0.4 / (n + 1);
  return random() < 1 / (n + 1);
}

/**
 * The fraction of damage the armour's enchantments remove on top of the armour
 * itself: 4% per point of Protection, and 12% per level of Feather Falling
 * against falls, capped at 80% as Minecraft caps it.
 */
export function enchantProtection(armor, cause) {
  let points = 0;
  for (const stack of armor) {
    if (!stack) continue;
    points += enchantLevel(stack, 'protection');
    if (cause === 'fall') points += 3 * enchantLevel(stack, 'feather_falling');
  }
  return Math.min(20, points) * 0.04;
}
