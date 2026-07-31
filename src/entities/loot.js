/**
 * loot.js — Weighted loot tables.
 *
 * A table is a list of entries with a weight, a stack range and an optional
 * `always` flag. Rolling picks `rolls` entries by weight, so rarity is expressed
 * once per entry rather than being buried in nested random checks.
 */

import { ITEM_ID, COMBIUM_BLOCK, COMB_BRICK, COMB_CRYSTAL, toolItemId, armorItemId } from '../world/blocks.js';

/**
 * @param entries {Array<{id, min, max, weight, always?}>}
 * @param rolls how many weighted picks to make
 */
function table(entries, rolls) {
  return { entries, rolls };
}

/** The chest tucked behind the Comb throne. The dimension's headline reward. */
export const THRONE_LOOT = table([
  // Guaranteed, so the trip is never wasted.
  { id: ITEM_ID.COMBIUM_INGOT, min: 3, max: 6, weight: 0, always: true },
  { id: ITEM_ID.COMB_SHARD, min: 4, max: 10, weight: 0, always: true },

  { id: ITEM_ID.COMBIUM_INGOT, min: 2, max: 5, weight: 30 },
  { id: ITEM_ID.COMB_SHARD, min: 3, max: 8, weight: 26 },
  { id: COMB_BRICK.id, min: 6, max: 16, weight: 20 },
  { id: COMB_CRYSTAL.id, min: 2, max: 5, weight: 14 },
  { id: ITEM_ID.DIAMOND, min: 1, max: 3, weight: 12 },
  { id: ITEM_ID.GOLD_INGOT, min: 2, max: 6, weight: 12 },
  { id: COMBIUM_BLOCK.id, min: 1, max: 2, weight: 6 },
  // Ready-made gear, so a lucky chest can jump you a tier.
  { id: toolItemId('pickaxe', 'diamond'), min: 1, max: 1, weight: 5 },
  { id: armorItemId('chestplate', 'diamond'), min: 1, max: 1, weight: 4 },
  { id: toolItemId('sword', 'combium'), min: 1, max: 1, weight: 2 },
], 5);

/** Dropped by the Comb Warden. */
export const BOSS_LOOT = table([
  { id: ITEM_ID.COMB_HEART, min: 1, max: 1, weight: 0, always: true },
  { id: ITEM_ID.COMBIUM_INGOT, min: 6, max: 12, weight: 0, always: true },

  { id: ITEM_ID.COMB_SHARD, min: 8, max: 16, weight: 30 },
  { id: COMBIUM_BLOCK.id, min: 1, max: 3, weight: 20 },
  { id: ITEM_ID.DIAMOND, min: 2, max: 5, weight: 18 },
  { id: toolItemId('sword', 'combium'), min: 1, max: 1, weight: 12 },
  { id: toolItemId('pickaxe', 'combium'), min: 1, max: 1, weight: 12 },
  { id: armorItemId('helmet', 'combium'), min: 1, max: 1, weight: 8 },
], 4);

/**
 * Roll a table into a list of `{id, count}` stacks.
 * `always` entries are included every time; the rest are picked by weight.
 */
export function rollLoot(lootTable, random = Math.random) {
  const results = [];
  const pick = (entry) => {
    const count = entry.min + Math.floor(random() * (entry.max - entry.min + 1));
    if (count > 0) results.push({ id: entry.id, count });
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
    slots[slot] = { id: stack.id, count: stack.count };
  }
  return slots;
}
