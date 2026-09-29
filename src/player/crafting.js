/**
 * crafting.js — Recipes, grid matching and furnace smelting.
 *
 * Two recipe kinds, as in Minecraft:
 *   shaped     — the arrangement matters; the pattern is matched against the
 *                grid's trimmed bounding box, so it works anywhere in the grid
 *   shapeless  — only the multiset of ingredients matters
 *
 * Tool and armour recipes are generated from templates rather than written out
 * 35 times, so adding a material is one line in `GEAR_TIERS`. Everything else —
 * the hand-written recipes, smelting and fuels — is data, in content/core.json
 * and any other content pack (see src/content/packs.js).
 */

import {
  PLANKS, COBBLE, BUILDING_FAMILIES, ITEM_ID, TOOL_KINDS, ARMOR_PIECES,
  ARMOR_MATERIAL_NAMES, toolItemId, armorItemId, getDisplayName, getThing,
  idByName,
} from '../world/blocks.js';
import { packEntries } from '../content/packs.js';

// ---------------------------------------------------------------------------
// Recipe construction
// ---------------------------------------------------------------------------

export const RECIPES = [];

// Function declarations (not const arrows) — these run during the recipe
// registrations further down, which happen at module evaluation time.
function isEmptyCell(c) {
  return c === '.' || c === ' ' || c === undefined;
}

/**
 * Strip empty rows and columns from a pattern.
 *
 * Matching compares the pattern against the *trimmed* bounding box of the
 * player's grid, so the pattern has to be trimmed too. Without this, a shovel
 * written as ['.M.', '.S.', '.S.'] claims to be 3 wide while the grid it
 * matches is only 1 wide, and the recipe can never fire.
 */
function trimPattern(pattern) {
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;

  for (let y = 0; y < pattern.length; y++) {
    for (let x = 0; x < pattern[y].length; x++) {
      if (isEmptyCell(pattern[y][x])) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return pattern; // empty pattern; leave it alone

  const trimmed = [];
  for (let y = minY; y <= maxY; y++) {
    let row = '';
    for (let x = minX; x <= maxX; x++) row += pattern[y][x] ?? '.';
    trimmed.push(row);
  }
  return trimmed;
}

/**
 * @param pattern rows of single characters; '.' or ' ' is an empty cell
 * @param key     character -> ingredient id
 * @param result  {id, count}
 */
function shaped(pattern, key, result) {
  RECIPES.push({ type: 'shaped', pattern: trimPattern(pattern), key, result });
}

function shapeless(ingredients, result) {
  RECIPES.push({ type: 'shapeless', ingredients, result });
}

// --- Recipes from content packs -----------------------------------------------
// Written by name in content/core.json (and any other pack). A recipe naming
// something that does not exist is skipped with a warning, so a pack for a
// newer build cannot break an older one.

function resolveName(name, where) {
  const id = idByName(name);
  if (id === null) console.warn(`[packs] ${where}: nothing is called "${name}"`);
  return id;
}

function addPackRecipe(entry) {
  const where = `${entry.pack} recipe for ${entry.result}`;
  const result = resolveName(entry.result, where);
  if (result === null) return;
  const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1;

  if (Array.isArray(entry.shaped)) {
    const rows = entry.shaped.map(String);
    if (rows.length === 0 || rows.length > 3 || rows.some((row) => row.length > 3)) {
      console.warn(`[packs] ${where}: a shaped pattern is 1-3 rows of 1-3 cells`);
      return;
    }
    const key = {};
    for (const [symbol, name] of Object.entries(entry.key ?? {})) {
      const id = resolveName(name, where);
      if (id === null) return;
      key[symbol] = id;
    }
    const unknown = rows.join('').split('').find((c) => !isEmptyCell(c) && !(c in key));
    if (unknown) {
      console.warn(`[packs] ${where}: "${unknown}" in the pattern has no key`);
      return;
    }
    shaped(rows, key, { id: result, count });
  } else if (Array.isArray(entry.shapeless)) {
    const ids = entry.shapeless.map((name) => resolveName(name, where));
    if (ids.includes(null) || ids.length === 0 || ids.length > 9) return;
    shapeless(ids, { id: result, count });
  } else {
    console.warn(`[packs] ${where}: needs a "shaped" pattern or a "shapeless" list`);
  }
}

for (const entry of packEntries('recipes')) addPackRecipe(entry);

// --- Building blocks --------------------------------------------------------
// Slabs, stairs and fences for every family, generated from the same table the
// blocks themselves came from.
for (const set of BUILDING_FAMILIES) {
  shaped(['BBB'], { B: set.base }, { id: set.slab, count: 6 });
  shaped(['B..', 'BB.', 'BBB'], { B: set.base }, { id: set.stair, count: 4 });
  if (set.fence) {
    shaped(['BSB', 'BSB'], { B: set.base, S: ITEM_ID.STICK }, { id: set.fence, count: 3 });
  }
}

// --- Tools & armour ---------------------------------------------------------

/** Crafting material for each gear tier. */
const GEAR_TIERS = {
  wood: PLANKS.id,
  stone: COBBLE.id,
  iron: ITEM_ID.IRON_INGOT,
  gold: ITEM_ID.GOLD_INGOT,
  diamond: ITEM_ID.DIAMOND,
  combium: ITEM_ID.COMBIUM_INGOT,
};

/** M = material, S = stick. Axes get a mirrored variant, as in Minecraft. */
const TOOL_PATTERNS = {
  pickaxe: [['MMM', '.S.', '.S.']],
  axe: [['MM.', 'MS.', '.S.'], ['.MM', '.SM', '.S.']],
  shovel: [['.M.', '.S.', '.S.']],
  sword: [['.M.', '.M.', '.S.']],
  hoe: [['MM.', '.S.', '.S.'], ['.MM', '.S.', '.S.']],
};

const ARMOR_PATTERNS = {
  helmet: ['MMM', 'M.M'],
  chestplate: ['M.M', 'MMM', 'MMM'],
  leggings: ['MMM', 'M.M', 'M.M'],
  boots: ['M.M', 'M.M'],
};

for (const kind of TOOL_KINDS) {
  for (const [material, ingredient] of Object.entries(GEAR_TIERS)) {
    for (const pattern of TOOL_PATTERNS[kind]) {
      shaped(pattern, { M: ingredient, S: ITEM_ID.STICK }, { id: toolItemId(kind, material), count: 1 });
    }
  }
}

for (const piece of ARMOR_PIECES) {
  for (const material of ARMOR_MATERIAL_NAMES) {
    shaped(ARMOR_PATTERNS[piece], { M: GEAR_TIERS[material] }, { id: armorItemId(piece, material), count: 1 });
  }
}

// ---------------------------------------------------------------------------
// Grid matching
// ---------------------------------------------------------------------------

/** Bounding box of the non-empty cells in a square grid of stacks. */
function boundingBox(grid, size) {
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!grid[y * size + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function matchShaped(recipe, grid, size, box) {
  const height = recipe.pattern.length;
  const width = Math.max(...recipe.pattern.map((r) => r.length));
  if (box.maxX - box.minX + 1 !== width) return false;
  if (box.maxY - box.minY + 1 !== height) return false;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const ch = recipe.pattern[py][px] ?? '.';
      const stack = grid[(box.minY + py) * size + (box.minX + px)];
      if (isEmptyCell(ch)) {
        if (stack) return false;
      } else {
        if (!stack || stack.id !== recipe.key[ch]) return false;
      }
    }
  }
  return true;
}

function matchShapeless(recipe, grid) {
  const present = grid.filter(Boolean).map((s) => s.id).sort((a, b) => a - b);
  const wanted = [...recipe.ingredients].sort((a, b) => a - b);
  if (present.length !== wanted.length) return false;
  return present.every((id, i) => id === wanted[i]);
}

/**
 * Find the recipe a crafting grid produces.
 * @param grid flat array of `size * size` stacks (null for empty)
 * @param size 2 for the inventory grid, 3 for a crafting table
 * @returns {{id, count}|null}
 */
export function findRecipe(grid, size) {
  const box = boundingBox(grid, size);
  if (!box) return null;

  // Repair is checked first and shapeless: two worn copies of the same tool
  // anywhere in the grid combine. It cannot be a normal recipe because the
  // result depends on the *durability* of the inputs, which the pattern
  // matcher has no concept of.
  const repair = findRepair(grid);
  if (repair) return repair;

  for (const recipe of RECIPES) {
    if (recipe.type === 'shaped') {
      const h = recipe.pattern.length;
      const w = Math.max(...recipe.pattern.map((r) => r.length));
      if (h > size || w > size) continue; // needs a bigger grid than we have
      if (matchShaped(recipe, grid, size, box)) return { ...recipe.result };
    } else if (matchShapeless(recipe, grid)) {
      return { ...recipe.result };
    }
  }
  return null;
}

/**
 * Two of the same damaged tool combine into one.
 *
 * Durability is summed with a bonus, as in Minecraft, so repairing always beats
 * carrying two half-dead tools — and capped at the maximum, so it can never
 * produce something better than new.
 *
 * This cannot be an ordinary recipe: the result depends on the *durability* of
 * the inputs, which the pattern matcher has no concept of.
 *
 * @returns {{id, count, durability}|null}
 */
export function findRepair(grid) {
  const tools = [];
  for (const stack of grid) {
    if (!stack) continue;
    // Anything in the grid that is not one of the two tools disqualifies it,
    // otherwise "two picks and a stick" would silently repair.
    if (stack.durability === undefined || stack.durability === null) return null;
    tools.push(stack);
  }
  if (tools.length !== 2) return null;
  if (tools[0].id !== tools[1].id) return null;

  const item = getThing(tools[0].id);
  const max = item?.tool?.durability ?? item?.armor?.durability;
  if (!max) return null;

  // Neither may be pristine — combining two full tools would just destroy one.
  if (tools[0].durability >= max && tools[1].durability >= max) return null;

  const bonus = Math.floor(max * 0.05);
  const repaired = Math.min(max, tools[0].durability + tools[1].durability + bonus);
  return { id: tools[0].id, count: 1, durability: repaired };
}

/**
 * Consume one of every ingredient after a successful craft.
 * Mutates the grid in place, emptying spent slots.
 */
export function consumeGrid(grid) {
  for (let i = 0; i < grid.length; i++) {
    const stack = grid[i];
    if (!stack) continue;
    stack.count--;
    if (stack.count <= 0) grid[i] = null;
  }
}

/** Every recipe producing a given id — used by the recipe book UI. */
export function recipesFor(id) {
  return RECIPES.filter((r) => r.result.id === id);
}

// ---------------------------------------------------------------------------
// Smelting
// ---------------------------------------------------------------------------

/**
 * input id -> {id, count, xp} produced, from the packs' `smelting` lists.
 * `xp` is the experience one smelt is worth.
 */
export const SMELTING = new Map();
for (const entry of packEntries('smelting')) {
  const where = `${entry.pack} smelting of ${entry.input}`;
  const input = resolveName(entry.input, where);
  const output = resolveName(entry.output, where);
  if (input === null || output === null) continue;
  SMELTING.set(input, {
    id: output,
    count: Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1,
    xp: Math.max(0, Number(entry.xp) || 0),
  });
}

/** Seconds of burn time each fuel provides, from the packs' `fuels` lists. */
export const FUELS = new Map();
for (const entry of packEntries('fuels')) {
  const id = resolveName(entry.item, `${entry.pack} fuel`);
  if (id !== null && Number(entry.seconds) > 0) FUELS.set(id, Number(entry.seconds));
}

export const SMELT_SECONDS = 10;

export function smeltResultFor(id) {
  return SMELTING.get(id) ?? null;
}

export function fuelValueFor(id) {
  return FUELS.get(id) ?? 0;
}

/** A fresh, empty furnace. */
export function makeFurnaceState() {
  return {
    input: null,
    fuel: null,
    output: null,
    /** Seconds of fuel left, and what a full unit of it was worth. */
    burnRemaining: 0,
    burnMax: 0,
    /** Seconds of progress on the current smelt. */
    cookProgress: 0,
  };
}

/**
 * Advance a furnace. Runs whether or not its UI is open, so ores keep smelting
 * while you wander off.
 * @param onSmelted called with the item id each time one finishes cooking
 * @returns {boolean} true if anything changed (so the UI can redraw)
 */
export function tickFurnace(state, dt, onSmelted = null) {
  const before = state.burnRemaining > 0;
  let changed = false;

  if (state.burnRemaining > 0) {
    state.burnRemaining = Math.max(0, state.burnRemaining - dt);
    changed = true;
  }

  const recipe = state.input ? smeltResultFor(state.input.id) : null;
  // Output must be empty or already holding the same item with room to spare.
  const outputHasRoom =
    recipe &&
    (!state.output || (state.output.id === recipe.id && state.output.count + recipe.count <= 64));
  const canSmelt = !!recipe && outputHasRoom;

  // Light the furnace only when there is something worth burning fuel for.
  if (state.burnRemaining <= 0 && canSmelt && state.fuel) {
    const value = fuelValueFor(state.fuel.id);
    if (value > 0) {
      state.burnRemaining = value;
      state.burnMax = value;
      state.fuel.count--;
      if (state.fuel.count <= 0) state.fuel = null;
      changed = true;
    }
  }

  if (state.burnRemaining > 0 && canSmelt) {
    state.cookProgress += dt;
    changed = true;
    if (state.cookProgress >= SMELT_SECONDS) {
      state.cookProgress = 0;
      state.input.count--;
      if (state.input.count <= 0) state.input = null;
      if (state.output) state.output.count += recipe.count;
      else state.output = { id: recipe.id, count: recipe.count };
      // Experience banks in the furnace until the output is taken, as in
      // Minecraft; the HUD pays it out, and breaking the furnace spills it.
      state.xp = (state.xp ?? 0) + (recipe.xp ?? 0) * recipe.count;
      // Reported rather than acted on: this module has no idea what an
      // achievement is, and should not learn.
      if (onSmelted) onSmelted(recipe.id);
    }
  } else if (state.cookProgress > 0) {
    // Progress decays when the fire goes out, rather than freezing forever.
    state.cookProgress = Math.max(0, state.cookProgress - dt * 2);
    changed = true;
  }

  return changed || before !== state.burnRemaining > 0;
}

/** Is this furnace currently burning? Drives the lit texture. */
export function isFurnaceLit(state) {
  return !!state && state.burnRemaining > 0;
}

/** Human-readable recipe list, handy for debugging and the README. */
export function describeRecipes() {
  return RECIPES.map((r) => {
    const out = `${getDisplayName(r.result.id)} x${r.result.count}`;
    return r.type === 'shaped'
      ? `${out}  <=  [${r.pattern.join(' | ')}]`
      : `${out}  <=  ${r.ingredients.map(getDisplayName).join(' + ')}`;
  });
}
