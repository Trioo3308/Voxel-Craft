/**
 * loot.js — Weighted loot tables.
 *
 * A table is a list of entries with a weight, a stack range and an optional
 * `always` flag. Rolling picks `rolls` entries by weight, so rarity is expressed
 * once per entry rather than being buried in nested random checks.
 */

import { idByName, getDurability } from '../world/blocks.js';
import { packLootTables } from '../content/packs.js';
import { enchantForLoot } from '../player/enchanting.js';

/**
 * The tables themselves are data: `loot` in content/core.json, by item name
 * (a pack loaded later can replace a table by giving one the same name).
 * An entry naming something that does not exist is dropped with a warning.
 */
function resolveTable(name, spec) {
  const entries = [];
  for (const e of Array.isArray(spec?.entries) ? spec.entries : []) {
    const id = idByName(e.item);
    if (id === null) {
      console.warn(`[packs] loot table "${name}": nothing is called "${e.item}"`);
      continue;
    }
    const min = Math.max(0, e.min | 0);
    entries.push({
      id,
      min,
      max: Math.max(min, e.max ?? min),
      weight: e.always ? 0 : Math.max(0, Number(e.weight) || 0),
      always: e.always === true,
      // [low, high] table power to enchant the find at; `treasure` allows the
      // enchantments the table never offers (Mending).
      enchant: Array.isArray(e.enchant) ? [e.enchant[0] | 0, e.enchant[1] | 0] : null,
      treasure: e.treasure === true,
    });
  }
  return { entries, rolls: Math.max(0, spec?.rolls | 0) };
}

const TABLES = new Map(
  Object.entries(packLootTables()).map(([name, spec]) => [name, resolveTable(name, spec)])
);
const EMPTY = { entries: [], rolls: 0 };

/** A loot table by name, or an empty one. */
export function lootTable(name) {
  return TABLES.get(name) ?? EMPTY;
}

/** The chest tucked behind the Comb throne. The dimension's headline reward. */
export const THRONE_LOOT = lootTable('throne');
/** Overworld dungeon chests: mid-game, never enough to skip a tier. */
export const DUNGEON_LOOT = lootTable('dungeon');
/** Hive caches: the compass ingredients, so raiding hives leads to a shrine. */
export const HIVE_LOOT = lootTable('hive');
/** Dropped by the Comb Warden. */
export const BOSS_LOOT = lootTable('boss');

/**
 * Roll a table into a list of stacks: `{id, count}`, plus durability and
 * enchantments for gear and books that come enchanted.
 * `always` entries are included every time; the rest are picked by weight.
 */
export function rollLoot(lootTable, random = Math.random) {
  const results = [];
  const pick = (entry) => {
    const count = entry.min + Math.floor(random() * (entry.max - entry.min + 1));
    if (count <= 0) return;
    if (entry.enchant) {
      const [lo, hi] = entry.enchant;
      const power = lo + Math.floor(random() * (Math.max(lo, hi) - lo + 1));
      results.push(enchantForLoot(entry.id, power, entry.treasure, random));
      return;
    }
    const max = getDurability(entry.id);
    results.push(max > 0 ? { id: entry.id, count, durability: max } : { id: entry.id, count });
  };

  for (const entry of lootTable.entries) if (entry.always) pick(entry);

  const weighted = lootTable.entries.filter((e) => e.weight > 0);
  const total = weighted.reduce((n, e) => n + e.weight, 0);
  if (total <= 0) return results;

  for (let roll = 0; roll < lootTable.rolls; roll++) {
    let ticket = random() * total;
    for (const entry of weighted) {
      ticket -= entry.weight;
      if (ticket > 0) continue;
      pick(entry);
      break;
    }
  }

  return results;
}

/** Fill a chest's slot array from a table, merging duplicate stacks. */
export function fillChest(slots, lootTable, random = Math.random) {
  const rolled = rollLoot(lootTable, random);

  // Scatter across the chest rather than filling from slot 0, which looks
  // hand-placed rather than found.
  const free = [];
  for (let i = 0; i < slots.length; i++) if (!slots[i]) free.push(i);

  for (const stack of rolled) {
    if (free.length === 0) break;
    const pickIndex = Math.floor(random() * free.length);
    const slot = free.splice(pickIndex, 1)[0];
    // The whole stack, so a find keeps its wear and enchantments.
    slots[slot] = stack;
  }
  return slots;
}
