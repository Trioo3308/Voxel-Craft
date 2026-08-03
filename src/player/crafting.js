/**
 * crafting.js — Recipes, grid matching and furnace smelting.
 *
 * Two recipe kinds, as in Minecraft:
 *   shaped     — the arrangement matters; the pattern is matched against the
 *                grid's trimmed bounding box, so it works anywhere in the grid
 *   shapeless  — only the multiset of ingredients matters
 *
 * Tool and armour recipes are generated from templates rather than written out
 * 35 times, so adding a material is one line in `GEAR_TIERS`.
 */

import {
  PLANKS, LOG, ACACIA_LOG, SPRUCE_LOG, COBBLE, STONE, SAND, GLASS,
  CRAFTING_TABLE, FURNACE, IRON_ORE, GOLD_ORE,
  IRON_BLOCK, GOLD_BLOCK, DIAMOND_BLOCK, WOOL,
  BUILDING_FAMILIES, DOOR_CLOSED, BED, TORCH, CHEST,
  COMBIUM_ORE, COMBIUM_BLOCK, COMB_BRICK,
  COMB_WAX, COMB_TILE, COMB_PILLAR, COMB_LANTERN, COMB_GLASS, LADDER,
  RESIN_TORCH, HIVE_WALL,
  RAIL, SIGN, JUKEBOX, PRESSURE_PLATE, MUSHROOM_RED, MUSHROOM_BROWN,
  CAVE_LANTERN, DEEPSLATE, DEEPSLATE_COBBLE,
  NETHERRACK, NETHER_BRICK, GLOWSTONE,
  ITEM_ID, TOOL_KINDS, ARMOR_PIECES, ARMOR_MATERIAL_NAMES,
  toolItemId, armorItemId, getDisplayName, getThing,
} from '../world/blocks.js';

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

// --- Basics -----------------------------------------------------------------

// Every log type yields the same generic planks.
for (const log of [LOG, ACACIA_LOG, SPRUCE_LOG]) {
  shapeless([log.id], { id: PLANKS.id, count: 4 });
}

shaped(['P', 'P'], { P: PLANKS.id }, { id: ITEM_ID.STICK, count: 4 });
shaped(['PP', 'PP'], { P: PLANKS.id }, { id: CRAFTING_TABLE.id, count: 1 });
shaped(['CCC', 'C.C', 'CCC'], { C: COBBLE.id }, { id: FURNACE.id, count: 1 });

// --- Storage blocks (and back again) ----------------------------------------

const STORAGE = [
  [ITEM_ID.IRON_INGOT, IRON_BLOCK.id],
  [ITEM_ID.GOLD_INGOT, GOLD_BLOCK.id],
  [ITEM_ID.DIAMOND, DIAMOND_BLOCK.id],
];
for (const [ingot, block] of STORAGE) {
  shaped(['III', 'III', 'III'], { I: ingot }, { id: block, count: 1 });
  shapeless([block], { id: ingot, count: 9 });
}

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

// --- Doors, beds, torches, chests ------------------------------------------

shaped(['PP', 'PP', 'PP'], { P: PLANKS.id }, { id: DOOR_CLOSED.id, count: 1 });
shaped(['WWW', 'PPP'], { W: WOOL.id, P: PLANKS.id }, { id: BED.id, count: 1 });
shaped(['C', 'S'], { C: ITEM_ID.COAL, S: ITEM_ID.STICK }, { id: TORCH.id, count: 4 });
shaped(['PPP', 'P.P', 'PPP'], { P: PLANKS.id }, { id: CHEST.id, count: 1 });

// --- Combium & buckets ------------------------------------------------------

shaped(['I.I', '.I.'], { I: ITEM_ID.IRON_INGOT }, { id: ITEM_ID.BUCKET, count: 1 });
// Four ingots, not nine: this is portal masonry, not a storage block, and a
// ten-block frame at nine ingots each would cost 90 ingots.
shaped(['CC', 'CC'], { C: ITEM_ID.COMBIUM_INGOT }, { id: COMBIUM_BLOCK.id, count: 1 });
shapeless([COMBIUM_BLOCK.id], { id: ITEM_ID.COMBIUM_INGOT, count: 4 });
shaped(['SS', 'SS'], { S: ITEM_ID.COMB_SHARD }, { id: COMB_BRICK.id, count: 4 });

// Resin is the Comb's workable material: wax to build with, glass to see
// through, and a lantern that outshines a torch.
shaped(['RR', 'RR'], { R: ITEM_ID.COMB_RESIN }, { id: COMB_WAX.id, count: 4 });
shaped(['BB', 'BB'], { B: COMB_BRICK.id }, { id: COMB_TILE.id, count: 4 });
shaped(['B', 'B'], { B: COMB_BRICK.id }, { id: COMB_PILLAR.id, count: 2 });
shaped(['.R.', 'RSR', '.R.'], { R: ITEM_ID.COMB_RESIN, S: ITEM_ID.COMB_SHARD },
       { id: COMB_LANTERN.id, count: 2 });
shaped(['RRR', 'RSR', 'RRR'], { R: ITEM_ID.COMB_RESIN, S: ITEM_ID.COMBIUM_INGOT },
       { id: COMB_GLASS.id, count: 4 });

// Amber is the Comb's navigational material. The compass needs a shard for the
// needle and combium for the case, so it is a Comb craft made from Comb finds.
shaped(['.A.', 'ACA', '.S.'],
       { A: ITEM_ID.AMBER, C: ITEM_ID.COMBIUM_INGOT, S: ITEM_ID.COMB_SHARD },
       { id: ITEM_ID.SHRINE_COMPASS, count: 1 });

// Resin torches: light without needing coal, which the Comb has none of.
shaped(['R', 'S'], { R: ITEM_ID.COMB_RESIN, S: ITEM_ID.STICK },
       { id: RESIN_TORCH.id, count: 4 });
shaped(['RR', 'RR'], { R: ITEM_ID.AMBER }, { id: HIVE_WALL.id, count: 4 });

// --- Rockets and the board ---------------------------------------------------
// Sustingus jelly turns out to burn extremely well. Nobody is quite sure why.
shaped(['J', 'G', 'S'],
       { J: ITEM_ID.SUSTINGUS_JELLY, G: ITEM_ID.GUNPOWDER, S: ITEM_ID.STICK },
       { id: ITEM_ID.ROCKET, count: 3 });

// A deck, two trucks, four wheels.
shaped(['PPP', 'I.I'], { P: PLANKS.id, I: ITEM_ID.IRON_INGOT },
       { id: ITEM_ID.SKATEBOARD, count: 1 });

// Rails, so you can build somewhere to skate rather than only finding one.
shaped(['I.I', 'ISI', 'I.I'], { I: ITEM_ID.IRON_INGOT, S: ITEM_ID.STICK },
       { id: RAIL.id, count: 8 });

// --- Boats, signs, jukeboxes and plates --------------------------------------

shaped(['P.P', 'PPP'], { P: PLANKS.id }, { id: ITEM_ID.BOAT, count: 1 });
shaped(['PPP', 'PPP', '.S.'], { P: PLANKS.id, S: ITEM_ID.STICK },
       { id: SIGN.id, count: 3 });
shaped(['PP'], { P: PLANKS.id }, { id: PRESSURE_PLATE.id, count: 1 });

// A jukebox needs a diamond for the stylus, so it sits just past the point
// where you have spare diamonds — a treat, not a stepping stone.
shaped(['PPP', 'PDP', 'PPP'], { P: PLANKS.id, D: ITEM_ID.DIAMOND },
       { id: JUKEBOX.id, count: 1 });

// --- Fire, and the other dimensions ----------------------------------------------

// The Nether's key. Wears out rather than being consumed, so one lasts a while.
shapeless([ITEM_ID.FLINT, ITEM_ID.IRON_INGOT], { id: ITEM_ID.FLINT_AND_STEEL, count: 1 });

// Nether brick, from what the Nether is made of.
shaped(['NN', 'NN'], { N: NETHERRACK.id }, { id: NETHER_BRICK.id, count: 4 });

// Glowstone is Nether loot, but four quartz will also do it — so an Aether
// portal is reachable even if the ceilings near your portal were bare.
shaped(['QQ', 'QQ'], { Q: ITEM_ID.NETHER_QUARTZ }, { id: GLOWSTONE.id, count: 1 });

// --- The caves ------------------------------------------------------------------

// A caged crystal. Brighter than a torch and it needs no coal, which is the
// point: by the time you are deep enough to find a geode, coal is a trek away.
shaped(['III', 'ICI', 'III'], { I: ITEM_ID.IRON_INGOT, C: ITEM_ID.CAVE_CRYSTAL },
       { id: CAVE_LANTERN.id, count: 2 });

// Deepslate is a building material once you are down there.
shaped(['DD', 'DD'], { D: DEEPSLATE_COBBLE.id }, { id: DEEPSLATE.id, count: 4 });

// --- Food ---------------------------------------------------------------------

shaped(['P.P', '.P.'], { P: PLANKS.id }, { id: ITEM_ID.BOWL, count: 4 });
// Either mushroom will do, and so will one of each.
for (const [a, b] of [[MUSHROOM_RED.id, MUSHROOM_BROWN.id],
                      [MUSHROOM_RED.id, MUSHROOM_RED.id],
                      [MUSHROOM_BROWN.id, MUSHROOM_BROWN.id]]) {
  shapeless([a, b, ITEM_ID.BOWL], { id: ITEM_ID.MUSHROOM_STEW, count: 1 });
}

// Eight gold around an apple. Deliberately steep: this is the only food that
// heals, and cheap healing would flatten every fight in the game.
shaped(['GGG', 'GAG', 'GGG'], { G: ITEM_ID.GOLD_INGOT, A: ITEM_ID.APPLE },
       { id: ITEM_ID.GOLDEN_APPLE, count: 1 });

// --- Farming ----------------------------------------------------------------
// Three wheat in a row. The first food you can make instead of hunt.
shaped(['WWW'], { W: ITEM_ID.WHEAT }, { id: ITEM_ID.BREAD, count: 1 });

// --- Ladders, shears, rod ----------------------------------------------------
shaped(['S.S', 'SSS', 'S.S'], { S: ITEM_ID.STICK }, { id: LADDER.id, count: 3 });
shaped(['.I', 'I.'], { I: ITEM_ID.IRON_INGOT }, { id: ITEM_ID.SHEARS, count: 1 });
shaped(['..S', '.SR', 'S.R'], { S: ITEM_ID.STICK, R: ITEM_ID.STRING },
       { id: ITEM_ID.FISHING_ROD, count: 1 });

// --- Bow --------------------------------------------------------------------
shaped(['.SG', 'S.G', '.SG'], { S: ITEM_ID.STICK, G: ITEM_ID.STRING }, { id: ITEM_ID.BOW, count: 1 });

// --- Mob-drop recipes -------------------------------------------------------

// Arrows: flint would be more faithful, but cobblestone stands in for the head.
shaped(['C', 'S', 'F'], { C: COBBLE.id, S: ITEM_ID.STICK, F: ITEM_ID.FEATHER },
       { id: ITEM_ID.ARROW, count: 4 });

// Bone meal is not implemented, but bones make useful sticks.
shapeless([ITEM_ID.BONE], { id: ITEM_ID.STICK, count: 2 });

// String into wool, as in Minecraft.
shaped(['SS', 'SS'], { S: ITEM_ID.STRING }, { id: WOOL.id, count: 1 });

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

/** input id -> {id, count} produced. */
export const SMELTING = new Map([
  [IRON_ORE.id, { id: ITEM_ID.IRON_INGOT, count: 1 }],
  [GOLD_ORE.id, { id: ITEM_ID.GOLD_INGOT, count: 1 }],
  [SAND.id, { id: GLASS.id, count: 1 }],
  [COBBLE.id, { id: STONE.id, count: 1 }],
  [ITEM_ID.PORKCHOP, { id: ITEM_ID.COOKED_PORKCHOP, count: 1 }],
  [ITEM_ID.BEEF, { id: ITEM_ID.COOKED_BEEF, count: 1 }],
  [ITEM_ID.MUTTON, { id: ITEM_ID.COOKED_MUTTON, count: 1 }],
  [ITEM_ID.CHICKEN_RAW, { id: ITEM_ID.CHICKEN_COOKED, count: 1 }],
  [COMBIUM_ORE.id, { id: ITEM_ID.COMBIUM_INGOT, count: 1 }],
  [ITEM_ID.FISH, { id: ITEM_ID.COOKED_FISH, count: 1 }],
]);

/** Seconds of burn time each fuel provides. One smelt takes SMELT_SECONDS. */
export const FUELS = new Map([
  [ITEM_ID.COAL, 80],
  [LOG.id, 15],
  [ACACIA_LOG.id, 15],
  [SPRUCE_LOG.id, 15],
  [PLANKS.id, 15],
  [CRAFTING_TABLE.id, 15],
  [ITEM_ID.STICK, 5],
]);

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
