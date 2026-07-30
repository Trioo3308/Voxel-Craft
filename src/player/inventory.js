/**
 * inventory.js — Hotbar + backpack storage.
 *
 * Slot layout mirrors Minecraft: indices 0-8 are the hotbar, 9-35 the backpack.
 * A slot is either `null` or `{ id, count }`, where `id` indexes the shared
 * block/item registry in world/blocks.js.
 *
 * Extension point: a crafting grid is just another array of slots plus a recipe
 * lookup over `{id, count}` stacks — nothing here needs to change.
 */

import { getThing, isBlockId, getMaxStack, getArmor, getTool, getDurability, ARMOR_PIECES } from '../world/blocks.js';

export const HOTBAR_SIZE = 9;
export const STORAGE_SIZE = 27;
export const TOTAL_SLOTS = HOTBAR_SIZE + STORAGE_SIZE;
export const ARMOR_SLOTS = 4;
export const MAX_STACK = 64;

/** A stack is `{ id, count, durability? }`. Durability is only set on gear. */
export class Inventory {
  constructor() {
    /** @type {Array<{id:number,count:number,durability?:number}|null>} */
    this.slots = new Array(TOTAL_SLOTS).fill(null);
    /** Worn armour, indexed by ARMOR_PIECES order: helmet, chest, legs, boots. */
    this.armor = new Array(ARMOR_SLOTS).fill(null);
    this.selected = 0;
    /** Bumped whenever contents change, so the HUD can redraw lazily. */
    this.version = 0;
  }

  /** Build a fresh stack, seeding durability for tools and armour. */
  static makeStack(id, count = 1) {
    const max = getDurability(id);
    return max > 0 ? { id, count, durability: max } : { id, count };
  }

  /**
   * Mark the inventory as changed so the HUD redraws.
   * Public because UI code legitimately mutates stack counts in place while
   * splitting and merging.
   */
  touch() {
    this.version++;
  }

  /** Currently held stack, or null. */
  getSelected() {
    return this.slots[this.selected];
  }

  selectSlot(index) {
    this.selected = ((index % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.touch();
  }

  /** Cycle the hotbar selection (mouse wheel). */
  scrollSelection(direction) {
    this.selectSlot(this.selected + direction);
  }

  /**
   * Insert items, filling partial stacks first.
   * @returns {number} how many could not fit
   */
  add(id, count = 1) {
    if (!id || count <= 0) return count;
    const max = getMaxStack(id);
    let remaining = count;

    // Pass 1: top up existing stacks (hotbar first, so pickups stay to hand).
    // Skipped for gear, which never stacks.
    if (max > 1) {
      for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
        const slot = this.slots[i];
        if (slot && slot.id === id && slot.count < max) {
          const moved = Math.min(max - slot.count, remaining);
          slot.count += moved;
          remaining -= moved;
        }
      }
    }

    // Pass 2: open empty slots.
    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const moved = Math.min(max, remaining);
        this.slots[i] = Inventory.makeStack(id, moved);
        remaining -= moved;
      }
    }

    if (remaining !== count) this.touch();
    return remaining;
  }

  /**
   * Insert an existing stack object, preserving its durability.
   * Plain `add()` would mint a fresh full-durability tool, so a dropped and
   * re-collected pickaxe would repair itself.
   * @returns {number} how many could not fit
   */
  addExisting(stack) {
    if (!stack) return 0;
    if (stack.durability === undefined) return this.add(stack.id, stack.count);

    for (let i = 0; i < TOTAL_SLOTS; i++) {
      if (this.slots[i] === null) {
        this.slots[i] = stack;
        this.touch();
        return 0;
      }
    }
    return stack.count; // inventory full
  }

  /** Consume from a slot, clearing it when empty. */
  removeFrom(index, count = 1) {
    const slot = this.slots[index];
    if (!slot) return 0;
    const removed = Math.min(slot.count, count);
    slot.count -= removed;
    if (slot.count <= 0) this.slots[index] = null;
    this.touch();
    return removed;
  }

  /**
   * Remove items of a given id from wherever they are, hotbar first.
   * Used for ammunition, which is spent from the inventory rather than the hand.
   * @returns {number} how many were actually removed
   */
  removeFirst(id, count = 1) {
    let remaining = count;
    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      const slot = this.slots[i];
      if (!slot || slot.id !== id) continue;
      const taken = Math.min(slot.count, remaining);
      slot.count -= taken;
      remaining -= taken;
      if (slot.count <= 0) this.slots[i] = null;
    }
    if (remaining !== count) this.touch();
    return count - remaining;
  }

  /** Consume from the held stack. */
  consumeSelected(count = 1) {
    return this.removeFrom(this.selected, count);
  }

  setSlot(index, stack) {
    this.slots[index] = stack;
    this.touch();
  }

  countOf(id) {
    let total = 0;
    for (const slot of this.slots) if (slot && slot.id === id) total += slot.count;
    return total;
  }

  clear() {
    this.slots.fill(null);
    this.touch();
  }

  /** The held stack, if it is a placeable block. */
  getHeldBlock() {
    const slot = this.getSelected();
    if (!slot || !isBlockId(slot.id)) return null;
    return slot.id;
  }

  /** The held stack, if it is edible. */
  getHeldFood() {
    const slot = this.getSelected();
    if (!slot) return null;
    const thing = getThing(slot.id);
    return thing && thing.food > 0 ? thing : null;
  }

  /** Tool descriptor for the held item, or null if bare-handed. */
  getHeldTool() {
    const slot = this.getSelected();
    return slot ? getTool(slot.id) : null;
  }

  /**
   * Wear down the held tool by one point, breaking it when exhausted.
   * @returns {boolean} true if the tool broke
   */
  damageHeldTool(amount = 1) {
    const slot = this.getSelected();
    if (!slot || slot.durability === undefined) return false;

    slot.durability -= amount;
    if (slot.durability <= 0) {
      this.slots[this.selected] = null;
      this.touch();
      return true;
    }
    this.touch();
    return false;
  }

  /** Total armour points from worn pieces. */
  get armorPoints() {
    let total = 0;
    for (const slot of this.armor) {
      if (!slot) continue;
      const armor = getArmor(slot.id);
      if (armor) total += armor.defense;
    }
    return total;
  }

  /**
   * Spread durability loss across worn armour, as Minecraft does.
   * @returns {number} how many pieces broke
   */
  damageArmor(amount = 1) {
    let broken = 0;
    for (let i = 0; i < this.armor.length; i++) {
      const slot = this.armor[i];
      if (!slot || slot.durability === undefined) continue;
      slot.durability -= amount;
      if (slot.durability <= 0) {
        this.armor[i] = null;
        broken++;
      }
    }
    if (broken > 0 || amount > 0) this.touch();
    return broken;
  }

  /** Which armour slot an item belongs in, or -1 if it is not armour. */
  static armorSlotFor(id) {
    const armor = getArmor(id);
    return armor ? ARMOR_PIECES.indexOf(armor.piece) : -1;
  }

  /** Equip armour from a stack, returning whatever was displaced. */
  equipArmor(stack) {
    const index = Inventory.armorSlotFor(stack.id);
    if (index < 0) return stack;
    const previous = this.armor[index];
    this.armor[index] = stack;
    this.touch();
    return previous;
  }

  /** Seed a fresh survival player with a couple of useful stacks. */
  giveStarterItems() {
    this.add(9, 16);  // planks
    this.add(4, 16);  // cobblestone
    this.touch();
  }
}
