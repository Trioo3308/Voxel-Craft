/**
 * discovery.js — Which recipes the player has found out about.
 *
 * Jev's pick for Phase 3 (JEV_DECISIONS.md): recipes appear in the recipe book
 * when you first hold something that goes into them, as in Minecraft. Picking
 * up your first log teaches planks; your first paper teaches books. The book
 * only ever shows what you know, plus a count of what is left to find.
 *
 * Known recipes are remembered by *result name*, like everything else saved,
 * and knowing a result means knowing every recipe for it.
 */

import { RECIPES } from './crafting.js';
import { getThing, idByName } from '../world/blocks.js';

const ingredientsOf = (recipe) =>
  new Set(recipe.type === 'shaped' ? Object.values(recipe.key) : recipe.ingredients);

/** How many different things each ingredient goes into. */
const USES = new Map();
for (const recipe of RECIPES) {
  for (const id of ingredientsOf(recipe)) {
    const results = USES.get(id) ?? new Set();
    results.add(recipe.result.id);
    USES.set(id, results);
  }
}

/**
 * ingredient id -> the result ids it teaches. A recipe is taught by its
 * *distinctive* ingredient — the one that goes into the fewest things — as
 * Minecraft keys most recipes to one telling item: books teach the bookshelf
 * and a diamond the jukebox, rather than planks teaching all three before you
 * have seen either. Built once; recipes never change.
 */
const TEACHES = new Map();
for (const recipe of RECIPES) {
  const ingredients = [...ingredientsOf(recipe)];
  const fewest = Math.min(...ingredients.map((id) => USES.get(id).size));
  for (const id of ingredients) {
    if (USES.get(id).size !== fewest) continue;
    const set = TEACHES.get(id) ?? new Set();
    set.add(recipe.result.id);
    TEACHES.set(id, set);
  }
}

/** Every craftable result, for the "left to discover" count. */
const ALL_RESULTS = new Set(RECIPES.map((r) => r.result.id));

export class RecipeDiscovery {
  constructor() {
    /** Result ids the player knows how to make. */
    this.known = new Set();
    /** Called with the result ids newly learned, in one batch. */
    this.onDiscover = null;
    /** Creative worlds know everything. */
    this.everything = false;
  }

  knows(resultId) {
    return this.everything || this.known.has(resultId);
  }

  /** How many craftable things are still unknown. */
  get remaining() {
    if (this.everything) return 0;
    let n = 0;
    for (const id of ALL_RESULTS) if (!this.known.has(id)) n++;
    return n;
  }

  /** Learn what these ids teach (and the ids themselves, if they are made). */
  learnFrom(ids, quiet = false) {
    const fresh = [];
    const learn = (id) => {
      if (!ALL_RESULTS.has(id) || this.known.has(id)) return;
      this.known.add(id);
      fresh.push(id);
    };
    for (const id of ids) {
      learn(id);
      for (const result of TEACHES.get(id) ?? []) learn(result);
    }
    if (fresh.length > 0 && !quiet && this.onDiscover) this.onDiscover(fresh);
    return fresh;
  }

  reset() {
    this.known.clear();
  }

  serialize() {
    return [...this.known].map((id) => getThing(id)?.name).filter(Boolean);
  }

  /** @returns false if the save had no list (an older world); see seedFrom */
  load(names) {
    this.known.clear();
    if (!Array.isArray(names)) return false;
    for (const name of names) {
      const id = idByName(name);
      if (id !== null) this.known.add(id);
    }
    return true;
  }
}
