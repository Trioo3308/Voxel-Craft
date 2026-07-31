/**
 * blocks.js — Block & item registry.
 *
 * ADDING A NEW BLOCK
 * ------------------
 *  1. Add a tile index to `TILE` (and paint it in `src/world/textures.js`).
 *  2. Add an entry to the `defineBlock` list below with a fresh id.
 *  3. That's it — terrain, mesher, inventory, HUD and drops all read from here.
 *
 * This module is imported by the worker, so it must not touch Three.js or DOM.
 */

// ---------------------------------------------------------------------------
// Texture atlas tile indices (row-major in a 16x16 grid of 16px tiles).
// ---------------------------------------------------------------------------
export const TILE = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  COBBLE: 4,
  SAND: 5,
  GRAVEL: 6,
  LOG_SIDE: 7,
  LOG_TOP: 8,
  LEAVES: 9,
  PLANKS: 10,
  WATER: 11,
  BEDROCK: 12,
  COAL_ORE: 13,
  IRON_ORE: 14,
  GLASS: 15,
  SNOW_TOP: 16,
  SNOW_SIDE: 17,
  BRICK: 18,
  LAVA: 22,
  // Item-only icons (never appear on a cube face).
  PORKCHOP: 19,
  ROTTEN_FLESH: 20,
  STICK: 21,

  // --- Ores ---------------------------------------------------------------
  GOLD_ORE: 23,
  REDSTONE_ORE: 24,
  LAPIS_ORE: 25,
  DIAMOND_ORE: 26,
  EMERALD_ORE: 27,

  // --- Crafting stations & storage blocks ---------------------------------
  CRAFTING_TOP: 28,
  CRAFTING_SIDE: 29,
  CRAFTING_FRONT: 30,
  FURNACE_TOP: 31,
  FURNACE_SIDE: 32,
  FURNACE_FRONT: 33,
  FURNACE_LIT: 34,
  IRON_BLOCK: 35,
  GOLD_BLOCK: 36,
  DIAMOND_BLOCK: 37,

  // --- Biome blocks -------------------------------------------------------
  ACACIA_LOG_SIDE: 38,
  ACACIA_LOG_TOP: 39,
  ACACIA_LEAVES: 40,
  SPRUCE_LOG_SIDE: 41,
  SPRUCE_LOG_TOP: 42,
  SPRUCE_LEAVES: 43,
  DRY_GRASS_TOP: 44,
  DRY_GRASS_SIDE: 45,
  PODZOL_TOP: 46,
  PODZOL_SIDE: 47,
  SWAMP_GRASS_TOP: 48,
  SWAMP_GRASS_SIDE: 49,
  CLAY: 50,
  SANDSTONE_TOP: 51,
  SANDSTONE_SIDE: 52,

  // --- Material item icons ------------------------------------------------
  COAL_ITEM: 53,
  IRON_INGOT: 54,
  GOLD_INGOT: 55,
  DIAMOND_GEM: 56,
  REDSTONE_DUST: 57,
  LAPIS_GEM: 58,
  EMERALD_GEM: 59,
  COOKED_PORKCHOP: 60,
  WOOL: 61,
  DOOR: 62,
  BED_TOP: 63,
  BED_SIDE: 128,
  TORCH: 129,
  CHEST_TOP: 130,
  CHEST_SIDE: 131,
  BOW: 132,
  GUNPOWDER: 133,

  // --- Mob drop icons ------------------------------------------------------
  // These sit above the reserved gear runs. They used to start at 116, which
  // collided once a sixth gear material widened the armour run to 96..119.
  BEEF: 134,
  COOKED_BEEF: 135,
  MUTTON: 136,
  COOKED_MUTTON: 137,
  CHICKEN_RAW: 138,
  CHICKEN_COOKED: 139,
  LEATHER: 140,
  FEATHER: 141,
  BONE: 142,
  STRING: 143,
  ARROW: 144,
  SPIDER_EYE: 145,

  // --- Combium and the Comb dimension --------------------------------------
  COMBIUM_ORE: 146,
  COMBIUM_BLOCK: 147,
  COMBIUM_INGOT: 148,
  COMB_STONE: 149,
  COMB_SOIL: 150,
  COMB_CRYSTAL: 151,
  COMB_GROWTH: 152,
  COMB_BRICK: 153,
  PORTAL: 154,
  BUCKET: 155,
  BUCKET_WATER: 156,
  BUCKET_LAVA: 157,
  BUCKET_MILK: 158,
  COMB_HEART: 159,
  COMB_SHARD: 160,
  THRONE_TOP: 161,
  THRONE_SIDE: 162,

  /**
   * Tool and armour icons are generated parametrically (shape x material), so
   * they occupy reserved runs rather than individual named entries.
   * Tools:  TOOL_BASE + toolIndex * GEAR_STRIDE + materialIndex
   * Armour: ARMOR_BASE + pieceIndex * GEAR_STRIDE + materialIndex
   */
  TOOL_BASE: 64,
  ARMOR_BASE: 96,
};

/** Order used for the parametric tool/armour tile runs. */
export const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'sword'];
export const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
export const GEAR_MATERIALS = ['wood', 'stone', 'iron', 'gold', 'diamond', 'combium'];

/**
 * Width of one tool/armour row. Derived rather than hard-coded, because adding
 * a material silently shifted every icon and id when it was a literal 5.
 */
export const GEAR_STRIDE = GEAR_MATERIALS.length;

export function toolTile(kind, material) {
  return TILE.TOOL_BASE + TOOL_KINDS.indexOf(kind) * GEAR_STRIDE + GEAR_MATERIALS.indexOf(material);
}

export function armorTile(piece, material) {
  return TILE.ARMOR_BASE + ARMOR_PIECES.indexOf(piece) * GEAR_STRIDE + GEAR_MATERIALS.indexOf(material);
}

export const ATLAS_COLS = 16; // 16x16 tiles
export const ATLAS_TILE_PX = 16;

// ---------------------------------------------------------------------------
// Block ids. Keep AIR at 0 — a lot of code treats 0 as "nothing here".
// ---------------------------------------------------------------------------
export const AIR = 0;

/** Face order used everywhere: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_PX = 0, FACE_NX = 1, FACE_PY = 2, FACE_NY = 3, FACE_PZ = 4, FACE_NZ = 5;

// ---------------------------------------------------------------------------
// Block shapes
// ---------------------------------------------------------------------------
/**
 * A block's physical form, as a list of axis-aligned boxes in unit space
 * ([minX, minY, minZ, maxX, maxY, maxZ], each 0..1).
 *
 * `null` means the ordinary full cube, which is the overwhelming majority — the
 * fast path in both physics and the mesher checks for null and skips all of
 * this. Anything else (slab, stair, fence, door, bed) lists its boxes here and
 * gets collision and geometry generated from them automatically.
 */
export const SHAPES = {
  FULL: null,
  SLAB_BOTTOM: [[0, 0, 0, 1, 0.5, 1]],
  SLAB_TOP: [[0, 0.5, 0, 1, 1, 1]],
  // Lower step plus a raised back half.
  STAIR: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 1, 1, 0.5]],
  // Post plus two rails; 1.5 high so mobs cannot hop it.
  FENCE: [[0.375, 0, 0.375, 0.625, 1.5, 0.625]],
  // Thin panel against the -Z face, and the rotated open position.
  DOOR_CLOSED: [[0, 0, 0, 1, 1, 0.1875]],
  DOOR_OPEN: [[0, 0, 0, 0.1875, 1, 1]],
  BED: [[0, 0, 0, 1, 0.5625, 1]],
  TORCH: [[0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625]],
  CHEST: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]],
};

/** Height of a shape's tallest box, used for step-up and headroom checks. */
export function shapeHeight(shape) {
  if (!shape) return 1;
  let top = 0;
  for (const box of shape) if (box[4] > top) top = box[4];
  return top;
}

/** Expand a shorthand tile spec into the 6-face array. */
function faceTiles(spec) {
  if (typeof spec === 'number') return [spec, spec, spec, spec, spec, spec];
  const side = spec.side ?? spec.all ?? 0;
  const top = spec.top ?? spec.all ?? side;
  const bottom = spec.bottom ?? spec.all ?? side;
  return [side, side, top, bottom, side, side];
}

/** Registry array indexed by block id. Sparse entries are simply undefined. */
export const BLOCKS = [];

function defineBlock(id, name, options = {}) {
  const block = {
    id,
    name,
    tiles: faceTiles(options.tiles ?? 0),
    /** Blocks entity movement. */
    solid: options.solid !== false,
    /** Fully hides the faces behind it (used for face culling + skylight). */
    opaque: options.opaque !== false,
    /** Behaves as a fluid for physics (swimmable, not walkable). */
    liquid: options.liquid === true,
    /** Rendered in the alpha-blended pass rather than the opaque/cutout pass. */
    translucent: options.translucent === true,
    /**
     * When true, two adjacent blocks of this same type hide their shared face.
     * Water/glass want this; leaves do not (you'd see straight through a tree).
     */
    cullSameType: options.cullSameType !== false,
    /** Seconds of mining to break by hand. Infinity = unbreakable. */
    hardness: options.hardness ?? 0.5,
    /** Block/item id produced when broken; defaults to itself. */
    drops: options.drops ?? id,
    /** How many drop, as [min, max]. */
    dropCount: options.dropCount ?? [1, 1],
    /** Which tool class mines this quickly: 'pickaxe' | 'axe' | 'shovel' | null. */
    toolType: options.toolType ?? null,
    /**
     * Minimum tool tier needed to collect drops.
     * -1 = bare hands are fine, 0 = wood/gold, 1 = stone, 2 = iron, 3 = diamond.
     */
    harvestLevel: options.harvestLevel ?? -1,
    /** If true, breaking without a good enough tool yields nothing. */
    requiresTool: options.requiresTool === true,
    /** Shown in the creative palette / obtainable in survival. */
    obtainable: options.obtainable !== false,
    /** Renders at full brightness, ignoring sky light and AO (lava). */
    emissive: options.emissive === true,
    /** Set by defineFluidFamily for flowing blocks; null for everything else. */
    fluid: null,
    /**
     * Collision/render boxes, or null for a plain full cube. A block with a
     * shape is automatically non-opaque, since it cannot fill its cell and so
     * must not hide its neighbours' faces.
     */
    shape: options.shape ?? null,
    /** Light this block emits, 0..15. */
    lightEmission: options.lightEmission ?? 0,
    displayName: options.displayName ?? name,
  };

  // A partial block can never occlude, whatever was requested.
  if (block.shape) block.opaque = false;
  BLOCKS[id] = block;
  return block;
}

defineBlock(AIR, 'air', { solid: false, opaque: false, obtainable: false, hardness: Infinity });

export const GRASS      = defineBlock(1,  'grass',       { displayName: 'Grass Block', tiles: { top: TILE.GRASS_TOP, side: TILE.GRASS_SIDE, bottom: TILE.DIRT }, hardness: 0.6, drops: 2, toolType: 'shovel' });
export const DIRT       = defineBlock(2,  'dirt',        { displayName: 'Dirt',        tiles: TILE.DIRT,   hardness: 0.5, toolType: 'shovel' });
export const STONE      = defineBlock(3,  'stone',       { displayName: 'Stone',       tiles: TILE.STONE,  hardness: 1.5, drops: 4, toolType: 'pickaxe', harvestLevel: 0, requiresTool: true });
export const COBBLE     = defineBlock(4,  'cobblestone', { displayName: 'Cobblestone', tiles: TILE.COBBLE, hardness: 1.5, toolType: 'pickaxe', harvestLevel: 0, requiresTool: true });
export const SAND       = defineBlock(5,  'sand',        { displayName: 'Sand',        tiles: TILE.SAND,   hardness: 0.5, toolType: 'shovel' });
export const GRAVEL     = defineBlock(6,  'gravel',      { displayName: 'Gravel',      tiles: TILE.GRAVEL, hardness: 0.6, toolType: 'shovel' });
export const LOG        = defineBlock(7,  'log',         { displayName: 'Oak Log',     tiles: { top: TILE.LOG_TOP, bottom: TILE.LOG_TOP, side: TILE.LOG_SIDE }, hardness: 1.0, toolType: 'axe' });
export const LEAVES     = defineBlock(8,  'leaves',      { displayName: 'Oak Leaves',  tiles: TILE.LEAVES, hardness: 0.2, opaque: false, cullSameType: false });
export const PLANKS     = defineBlock(9,  'planks',      { displayName: 'Oak Planks',  tiles: TILE.PLANKS, hardness: 0.8, toolType: 'axe' });
export const BEDROCK    = defineBlock(11, 'bedrock',     { displayName: 'Bedrock',     tiles: TILE.BEDROCK, hardness: Infinity, obtainable: false });
export const GLASS      = defineBlock(14, 'glass',       { displayName: 'Glass',       tiles: TILE.GLASS,  hardness: 0.3, opaque: false, toolType: 'pickaxe' });
export const SNOW       = defineBlock(15, 'snow',        { displayName: 'Snow Block',  tiles: { top: TILE.SNOW_TOP, side: TILE.SNOW_SIDE, bottom: TILE.DIRT }, hardness: 0.4, toolType: 'shovel' });
export const BRICK      = defineBlock(16, 'brick',       { displayName: 'Bricks',      tiles: TILE.BRICK,  hardness: 1.8, toolType: 'pickaxe', harvestLevel: 0, requiresTool: true });

// ---------------------------------------------------------------------------
// Fluids
// ---------------------------------------------------------------------------
/**
 * A fluid family occupies a contiguous run of block ids:
 *   level 0        = the source block. Permanent; never dries up.
 *   level 1..max   = progressively thinner flowing states.
 *
 * Encoding the level in the block id keeps the world a single flat Uint8Array
 * (no parallel metadata layer), which the worker and mesher both depend on.
 * Each level also carries a render `height`, so flowing fluid visibly tapers.
 */
export const FLUIDS = {};

function defineFluidFamily(family, options) {
  const {
    sourceId, flowStartId, maxLevel, tile, tickInterval, displayName,
    emissive, translucent, lightEmission,
  } = options;
  const ids = new Array(maxLevel + 1);

  for (let level = 0; level <= maxLevel; level++) {
    const id = level === 0 ? sourceId : flowStartId + (level - 1);
    ids[level] = id;

    const block = defineBlock(id, level === 0 ? family : `${family}_flow_${level}`, {
      displayName: level === 0 ? displayName : `Flowing ${displayName}`,
      tiles: tile,
      solid: false,
      opaque: false,
      liquid: true,
      hardness: Infinity,
      // Only the source is placeable; flowing states are simulation-owned.
      obtainable: level === 0,
      emissive,
      translucent,
      // Thinner flows glow slightly less than a full source.
      lightEmission: lightEmission ? Math.max(0, lightEmission - level) : 0,
    });

    block.fluid = {
      family,
      level,
      maxLevel,
      // Source renders as a full cube so oceans stay flat; flows taper off.
      height: level === 0 ? 1 : Math.max(0.2, 1 - level * 0.11),
    };
  }

  FLUIDS[family] = { family, ids, sourceId, maxLevel, tickInterval };
  return FLUIDS[family];
}

// Water spreads 7 blocks from a source and updates every fluid tick.
export const WATER_FLUID = defineFluidFamily('water', {
  sourceId: 10, flowStartId: 17, maxLevel: 7,
  tile: TILE.WATER, tickInterval: 1, displayName: 'Water', translucent: true,
});

// Lava spreads only 3 blocks and is three times more viscous.
export const LAVA_FLUID = defineFluidFamily('lava', {
  sourceId: 24, flowStartId: 25, maxLevel: 3,
  tile: TILE.LAVA, tickInterval: 3, displayName: 'Lava', emissive: true,
  lightEmission: 15,
});

export const WATER = BLOCKS[WATER_FLUID.sourceId];
export const LAVA = BLOCKS[LAVA_FLUID.sourceId];

// ---------------------------------------------------------------------------
// Item ids
// ---------------------------------------------------------------------------
// Declared before the ore blocks so their `drops` can name the item they yield.
export const ITEM_ID_BASE = 128;

export const ITEM_ID = {
  PORKCHOP: 128,
  ROTTEN_FLESH: 129,
  STICK: 130,
  COAL: 131,
  IRON_INGOT: 132,
  GOLD_INGOT: 133,
  DIAMOND: 134,
  REDSTONE: 135,
  LAPIS: 136,
  EMERALD: 137,
  COOKED_PORKCHOP: 138,
  BEEF: 139,
  COOKED_BEEF: 140,
  MUTTON: 141,
  COOKED_MUTTON: 142,
  CHICKEN_RAW: 143,
  CHICKEN_COOKED: 144,
  LEATHER: 145,
  FEATHER: 146,
  BONE: 147,
  STRING: 148,
  ARROW: 149,
  SPIDER_EYE: 150,
  BOW: 151,
  GUNPOWDER: 152,

  // --- Combium & buckets ---------------------------------------------------
  COMBIUM_INGOT: 153,
  BUCKET: 154,
  BUCKET_WATER: 155,
  BUCKET_LAVA: 156,
  BUCKET_MILK: 157,
  COMB_HEART: 158,
  COMB_SHARD: 159,

  // Gear runs are 24 wide each now that there are six materials. Ids moved to
  // make room; saves remap by *name*, so renumbering is safe.
  TOOL_BASE: 160,   // 160..183
  ARMOR_BASE: 184,  // 184..207
};

// ---------------------------------------------------------------------------
// Ores
// ---------------------------------------------------------------------------
// `harvestLevel` gates the drop: mining diamond with a stone pickaxe destroys
// the block and gives nothing, which is what drives the tool progression.

export const COAL_ORE = defineBlock(12, 'coal_ore', {
  displayName: 'Coal Ore', tiles: TILE.COAL_ORE, hardness: 2.0,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
  drops: ITEM_ID.COAL, dropCount: [1, 1],
});

export const IRON_ORE = defineBlock(13, 'iron_ore', {
  displayName: 'Iron Ore', tiles: TILE.IRON_ORE, hardness: 2.5,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
  // Drops the ore itself — smelt it in a furnace for an ingot.
});

export const GOLD_ORE = defineBlock(28, 'gold_ore', {
  displayName: 'Gold Ore', tiles: TILE.GOLD_ORE, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
});

export const REDSTONE_ORE = defineBlock(29, 'redstone_ore', {
  displayName: 'Redstone Ore', tiles: TILE.REDSTONE_ORE, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
  drops: ITEM_ID.REDSTONE, dropCount: [4, 5],
});

export const LAPIS_ORE = defineBlock(30, 'lapis_ore', {
  displayName: 'Lapis Ore', tiles: TILE.LAPIS_ORE, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
  drops: ITEM_ID.LAPIS, dropCount: [4, 8],
});

export const DIAMOND_ORE = defineBlock(31, 'diamond_ore', {
  displayName: 'Diamond Ore', tiles: TILE.DIAMOND_ORE, hardness: 3.5,
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
  drops: ITEM_ID.DIAMOND, dropCount: [1, 1],
});

export const EMERALD_ORE = defineBlock(32, 'emerald_ore', {
  displayName: 'Emerald Ore', tiles: TILE.EMERALD_ORE, hardness: 3.5,
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
  drops: ITEM_ID.EMERALD, dropCount: [1, 1],
});

// ---------------------------------------------------------------------------
// Crafting stations & storage blocks
// ---------------------------------------------------------------------------

export const CRAFTING_TABLE = defineBlock(33, 'crafting_table', {
  displayName: 'Crafting Table', hardness: 1.2, toolType: 'axe',
  tiles: { top: TILE.CRAFTING_TOP, bottom: TILE.PLANKS, side: TILE.CRAFTING_SIDE },
});

export const FURNACE = defineBlock(34, 'furnace', {
  displayName: 'Furnace', hardness: 1.8,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
  tiles: { top: TILE.FURNACE_TOP, bottom: TILE.FURNACE_TOP, side: TILE.FURNACE_FRONT },
});

/**
 * A burning furnace is a separate block id so the glow can be baked into the
 * mesh like every other texture. The world swaps between the two while
 * smelting; `isFurnaceBlock` keeps that swap from being treated as "the block
 * was replaced", which would throw away the furnace's contents.
 */
export const FURNACE_LIT = defineBlock(47, 'furnace_lit', {
  displayName: 'Furnace', hardness: 1.8,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
  tiles: { top: TILE.FURNACE_TOP, bottom: TILE.FURNACE_TOP, side: TILE.FURNACE_LIT },
  emissive: true,
  // Mining a lit furnace still gives you a plain one.
  drops: 34,
  obtainable: false,
});

export function isFurnaceBlock(id) {
  return id === FURNACE.id || id === FURNACE_LIT.id;
}

export const IRON_BLOCK = defineBlock(35, 'iron_block', {
  displayName: 'Block of Iron', tiles: TILE.IRON_BLOCK, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
});

export const GOLD_BLOCK = defineBlock(36, 'gold_block', {
  displayName: 'Block of Gold', tiles: TILE.GOLD_BLOCK, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
});

export const DIAMOND_BLOCK = defineBlock(37, 'diamond_block', {
  displayName: 'Block of Diamond', tiles: TILE.DIAMOND_BLOCK, hardness: 4.0,
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
});

// ---------------------------------------------------------------------------
// Biome blocks
// ---------------------------------------------------------------------------

export const ACACIA_LOG = defineBlock(38, 'acacia_log', {
  displayName: 'Acacia Log', hardness: 1.0, toolType: 'axe',
  tiles: { top: TILE.ACACIA_LOG_TOP, bottom: TILE.ACACIA_LOG_TOP, side: TILE.ACACIA_LOG_SIDE },
});

export const ACACIA_LEAVES = defineBlock(39, 'acacia_leaves', {
  displayName: 'Acacia Leaves', tiles: TILE.ACACIA_LEAVES, hardness: 0.2,
  opaque: false, cullSameType: false,
});

export const SPRUCE_LOG = defineBlock(40, 'spruce_log', {
  displayName: 'Spruce Log', hardness: 1.0, toolType: 'axe',
  tiles: { top: TILE.SPRUCE_LOG_TOP, bottom: TILE.SPRUCE_LOG_TOP, side: TILE.SPRUCE_LOG_SIDE },
});

export const SPRUCE_LEAVES = defineBlock(41, 'spruce_leaves', {
  displayName: 'Spruce Leaves', tiles: TILE.SPRUCE_LEAVES, hardness: 0.2,
  opaque: false, cullSameType: false,
});

export const DRY_GRASS = defineBlock(42, 'dry_grass', {
  displayName: 'Savanna Grass', hardness: 0.6, drops: 2, toolType: 'shovel',
  tiles: { top: TILE.DRY_GRASS_TOP, side: TILE.DRY_GRASS_SIDE, bottom: TILE.DIRT },
});

export const PODZOL = defineBlock(43, 'podzol', {
  displayName: 'Podzol', hardness: 0.6, drops: 2, toolType: 'shovel',
  tiles: { top: TILE.PODZOL_TOP, side: TILE.PODZOL_SIDE, bottom: TILE.DIRT },
});

export const SWAMP_GRASS = defineBlock(44, 'swamp_grass', {
  displayName: 'Swamp Grass', hardness: 0.6, drops: 2, toolType: 'shovel',
  tiles: { top: TILE.SWAMP_GRASS_TOP, side: TILE.SWAMP_GRASS_SIDE, bottom: TILE.DIRT },
});

export const CLAY = defineBlock(45, 'clay', {
  displayName: 'Clay', tiles: TILE.CLAY, hardness: 0.7, toolType: 'shovel',
});

export const WOOL = defineBlock(48, 'wool', {
  displayName: 'Wool', tiles: TILE.WOOL, hardness: 0.5,
});

export const SANDSTONE = defineBlock(46, 'sandstone', {
  displayName: 'Sandstone', hardness: 1.2,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
  tiles: { top: TILE.SANDSTONE_TOP, bottom: TILE.SANDSTONE_TOP, side: TILE.SANDSTONE_SIDE },
});

// ---------------------------------------------------------------------------
// Building blocks: slabs, stairs, fences
// ---------------------------------------------------------------------------
/**
 * Generated from a base block so each family stays in step — a new stone type
 * only needs one entry here to gain a slab, a stair and a fence.
 */
export const BUILDING_FAMILIES = [];

function defineBuildingSet(baseId, startId, options = {}) {
  const base = BLOCKS[baseId];
  const set = { base: baseId };

  set.slab = defineBlock(startId, `${base.name}_slab`, {
    displayName: `${base.displayName} Slab`,
    tiles: { top: base.tiles[FACE_PY], bottom: base.tiles[FACE_NY], side: base.tiles[FACE_PX] },
    hardness: base.hardness * 0.8,
    toolType: base.toolType,
    harvestLevel: base.harvestLevel,
    requiresTool: base.requiresTool,
    shape: SHAPES.SLAB_BOTTOM,
  }).id;

  set.stair = defineBlock(startId + 1, `${base.name}_stairs`, {
    displayName: `${base.displayName} Stairs`,
    tiles: { top: base.tiles[FACE_PY], bottom: base.tiles[FACE_NY], side: base.tiles[FACE_PX] },
    hardness: base.hardness,
    toolType: base.toolType,
    harvestLevel: base.harvestLevel,
    requiresTool: base.requiresTool,
    shape: SHAPES.STAIR,
  }).id;

  if (options.fence !== false) {
    set.fence = defineBlock(startId + 2, `${base.name}_fence`, {
      displayName: `${base.displayName} Fence`,
      tiles: base.tiles[FACE_PX],
      hardness: base.hardness,
      toolType: base.toolType,
      harvestLevel: base.harvestLevel,
      requiresTool: base.requiresTool,
      shape: SHAPES.FENCE,
    }).id;
  }

  BUILDING_FAMILIES.push(set);
  return set;
}

export const STONE_BUILD = defineBuildingSet(3, 49);      // 49,50,51
export const COBBLE_BUILD = defineBuildingSet(4, 52);     // 52,53,54
export const PLANKS_BUILD = defineBuildingSet(9, 55);     // 55,56,57
export const SANDSTONE_BUILD = defineBuildingSet(46, 58); // 58,59,60

// ---------------------------------------------------------------------------
// Stateful blocks: doors, beds, torches, chests
// ---------------------------------------------------------------------------
// Open/closed is encoded as two block ids rather than metadata, the same trick
// used for the lit furnace — it keeps the world a flat Uint8Array.

export const DOOR_CLOSED = defineBlock(61, 'door', {
  displayName: 'Wooden Door', tiles: TILE.DOOR, hardness: 1.0, toolType: 'axe',
  shape: SHAPES.DOOR_CLOSED,
});

export const DOOR_OPEN = defineBlock(62, 'door_open', {
  displayName: 'Wooden Door', tiles: TILE.DOOR, hardness: 1.0, toolType: 'axe',
  shape: SHAPES.DOOR_OPEN, drops: 61, obtainable: false,
});

export function isDoor(id) {
  return id === DOOR_CLOSED.id || id === DOOR_OPEN.id;
}

export const BED = defineBlock(63, 'bed', {
  displayName: 'Bed', hardness: 0.4,
  tiles: { top: TILE.BED_TOP, bottom: TILE.PLANKS, side: TILE.BED_SIDE },
  shape: SHAPES.BED,
});

export const TORCH = defineBlock(64, 'torch', {
  displayName: 'Torch', tiles: TILE.TORCH, hardness: 0.1,
  shape: SHAPES.TORCH, emissive: true,
  // The whole point: a portable light source.
  lightEmission: 14,
});

export const CHEST = defineBlock(65, 'chest', {
  displayName: 'Chest', hardness: 1.2, toolType: 'axe',
  tiles: { top: TILE.CHEST_TOP, bottom: TILE.CHEST_TOP, side: TILE.CHEST_SIDE },
  shape: SHAPES.CHEST,
});

// ---------------------------------------------------------------------------
// Combium & the Comb dimension
// ---------------------------------------------------------------------------

export const COMBIUM_ORE = defineBlock(66, 'combium_ore', {
  displayName: 'Combium Ore', tiles: TILE.COMBIUM_ORE, hardness: 4.5,
  toolType: 'pickaxe', harvestLevel: 3, requiresTool: true,
  // Drops the ore block, which smelts 1:1 into an ingot. A portal frame needs
  // ten combium blocks, so one ore per block would make the gate a grind out of
  // all proportion to the rest of the game — hence 2-3 per vein block.
  dropCount: [2, 3],
});

export const COMBIUM_BLOCK = defineBlock(67, 'combium_block', {
  displayName: 'Block of Combium', tiles: TILE.COMBIUM_BLOCK, hardness: 5.0,
  toolType: 'pickaxe', harvestLevel: 3, requiresTool: true,
  // Faintly luminous, which is what makes a built portal frame read as special.
  lightEmission: 4,
});

/** Pale bedrock of the Comb dimension. */
export const COMB_STONE = defineBlock(68, 'comb_stone', {
  displayName: 'Comb Stone', tiles: TILE.COMB_STONE, hardness: 1.6,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
});

export const COMB_SOIL = defineBlock(69, 'comb_soil', {
  displayName: 'Comb Soil', tiles: TILE.COMB_SOIL, hardness: 0.6, toolType: 'shovel',
});

/** The red highlight running through the dimension. Glows softly. */
export const COMB_CRYSTAL = defineBlock(70, 'comb_crystal', {
  displayName: 'Comb Crystal', tiles: TILE.COMB_CRYSTAL, hardness: 2.4,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
  drops: ITEM_ID.COMB_SHARD, dropCount: [2, 4],
  lightEmission: 9,
});

export const COMB_GROWTH = defineBlock(71, 'comb_growth', {
  displayName: 'Comb Growth', tiles: TILE.COMB_GROWTH, hardness: 0.3,
  opaque: false, cullSameType: false,
});

export const COMB_BRICK = defineBlock(72, 'comb_brick', {
  displayName: 'Comb Brick', tiles: TILE.COMB_BRICK, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
});

export const THRONE = defineBlock(73, 'comb_throne', {
  displayName: 'Comb Throne', hardness: 6.0,
  tiles: { top: TILE.THRONE_TOP, bottom: TILE.COMB_BRICK, side: TILE.THRONE_SIDE },
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
  lightEmission: 7,
});

/**
 * The portal surface itself. Non-solid so you can walk in, translucent, and
 * bright enough to be unmistakable in a dark room.
 */
export const PORTAL = defineBlock(74, 'combium_portal', {
  displayName: 'Combium Portal', tiles: TILE.PORTAL,
  solid: false, opaque: false, translucent: true,
  hardness: Infinity, obtainable: false,
  lightEmission: 11,
});

/** Every log/leaf pair, so terrain can pick a tree style per biome. */
export const TREE_WOODS = {
  oak: { log: LOG.id, leaves: LEAVES.id },
  acacia: { log: ACACIA_LOG.id, leaves: ACACIA_LEAVES.id },
  spruce: { log: SPRUCE_LOG.id, leaves: SPRUCE_LEAVES.id },
};

// ---------------------------------------------------------------------------
// Items — ids >= 128 so `id < 128` cheaply means "placeable block".
// ---------------------------------------------------------------------------
export const ITEMS = [];

function defineItem(id, name, options = {}) {
  const item = {
    id,
    name,
    displayName: options.displayName ?? name,
    tile: options.tile ?? 0,
    /** Hunger points restored when eaten; 0 = not edible. */
    food: options.food ?? 0,
    /** Saturation granted alongside the hunger points. */
    saturation: options.saturation ?? 0,
    /** Tools and armour never stack. */
    maxStack: options.maxStack ?? 64,
    /** {kind, material, tier, speed, durability, damage} for tools. */
    tool: options.tool ?? null,
    /** {piece, material, defense, durability} for armour. */
    armor: options.armor ?? null,
    /** {drawTime, speed, maxDamage, ...} for ranged weapons. */
    ranged: options.ranged ?? null,
    /** {fluid, igniter?} for buckets. */
    bucket: options.bucket ?? null,
  };
  ITEMS[id - ITEM_ID_BASE] = item;
  return item;
}

export const PORKCHOP     = defineItem(ITEM_ID.PORKCHOP,     'porkchop',     { displayName: 'Raw Porkchop', tile: TILE.PORKCHOP, food: 6, saturation: 3 });
export const ROTTEN_FLESH = defineItem(ITEM_ID.ROTTEN_FLESH, 'rotten_flesh', { displayName: 'Rotten Flesh', tile: TILE.ROTTEN_FLESH, food: 3, saturation: 1 });
export const STICK        = defineItem(ITEM_ID.STICK,        'stick',        { displayName: 'Stick',        tile: TILE.STICK });
export const COAL         = defineItem(ITEM_ID.COAL,         'coal',         { displayName: 'Coal',         tile: TILE.COAL_ITEM });
export const IRON_INGOT   = defineItem(ITEM_ID.IRON_INGOT,   'iron_ingot',   { displayName: 'Iron Ingot',   tile: TILE.IRON_INGOT });
export const GOLD_INGOT   = defineItem(ITEM_ID.GOLD_INGOT,   'gold_ingot',   { displayName: 'Gold Ingot',   tile: TILE.GOLD_INGOT });
export const DIAMOND      = defineItem(ITEM_ID.DIAMOND,      'diamond',      { displayName: 'Diamond',      tile: TILE.DIAMOND_GEM });
export const REDSTONE     = defineItem(ITEM_ID.REDSTONE,     'redstone',     { displayName: 'Redstone Dust', tile: TILE.REDSTONE_DUST });
export const LAPIS        = defineItem(ITEM_ID.LAPIS,        'lapis',        { displayName: 'Lapis Lazuli', tile: TILE.LAPIS_GEM });
export const EMERALD      = defineItem(ITEM_ID.EMERALD,      'emerald',      { displayName: 'Emerald',      tile: TILE.EMERALD_GEM });
export const COOKED_PORKCHOP = defineItem(ITEM_ID.COOKED_PORKCHOP, 'cooked_porkchop', { displayName: 'Cooked Porkchop', tile: TILE.COOKED_PORKCHOP, food: 8, saturation: 5 });

// --- Mob drops --------------------------------------------------------------
export const BEEF           = defineItem(ITEM_ID.BEEF,           'beef',           { displayName: 'Raw Beef',        tile: TILE.BEEF, food: 3, saturation: 2 });
export const COOKED_BEEF    = defineItem(ITEM_ID.COOKED_BEEF,    'cooked_beef',    { displayName: 'Steak',           tile: TILE.COOKED_BEEF, food: 8, saturation: 6 });
export const MUTTON         = defineItem(ITEM_ID.MUTTON,         'mutton',         { displayName: 'Raw Mutton',      tile: TILE.MUTTON, food: 2, saturation: 1 });
export const COOKED_MUTTON  = defineItem(ITEM_ID.COOKED_MUTTON,  'cooked_mutton',  { displayName: 'Cooked Mutton',   tile: TILE.COOKED_MUTTON, food: 6, saturation: 5 });
export const CHICKEN_RAW    = defineItem(ITEM_ID.CHICKEN_RAW,    'chicken',        { displayName: 'Raw Chicken',     tile: TILE.CHICKEN_RAW, food: 2, saturation: 1 });
export const CHICKEN_COOKED = defineItem(ITEM_ID.CHICKEN_COOKED, 'cooked_chicken', { displayName: 'Cooked Chicken',  tile: TILE.CHICKEN_COOKED, food: 6, saturation: 4 });
export const LEATHER        = defineItem(ITEM_ID.LEATHER,        'leather',        { displayName: 'Leather',         tile: TILE.LEATHER });
export const FEATHER        = defineItem(ITEM_ID.FEATHER,        'feather',        { displayName: 'Feather',         tile: TILE.FEATHER });
export const BONE           = defineItem(ITEM_ID.BONE,           'bone',           { displayName: 'Bone',            tile: TILE.BONE });
export const STRING_ITEM    = defineItem(ITEM_ID.STRING,         'string',         { displayName: 'String',          tile: TILE.STRING });
export const ARROW          = defineItem(ITEM_ID.ARROW,          'arrow',          { displayName: 'Arrow',           tile: TILE.ARROW });
export const SPIDER_EYE     = defineItem(ITEM_ID.SPIDER_EYE,     'spider_eye',     { displayName: 'Spider Eye',      tile: TILE.SPIDER_EYE, food: 2, saturation: 1 });
export const GUNPOWDER      = defineItem(ITEM_ID.GUNPOWDER,      'gunpowder',      { displayName: 'Gunpowder',       tile: TILE.GUNPOWDER });

// --- Combium & the Comb dimension -------------------------------------------
export const COMBIUM_INGOT = defineItem(ITEM_ID.COMBIUM_INGOT, 'combium_ingot', { displayName: 'Combium Ingot', tile: TILE.COMBIUM_INGOT });
export const COMB_SHARD    = defineItem(ITEM_ID.COMB_SHARD,    'comb_shard',    { displayName: 'Comb Shard',    tile: TILE.COMB_SHARD });
export const COMB_HEART    = defineItem(ITEM_ID.COMB_HEART,    'comb_heart',    { displayName: 'Comb Heart',    tile: TILE.COMB_HEART, maxStack: 1 });

// --- Buckets ----------------------------------------------------------------
/**
 * Buckets carry one of three fluids. Each fill state is its own item rather
 * than metadata on a single one, matching how the rest of the game encodes
 * state — and it keeps stack rules honest, since a full bucket must not stack
 * with an empty one.
 */
export const BUCKET = defineItem(ITEM_ID.BUCKET, 'bucket', {
  displayName: 'Bucket', tile: TILE.BUCKET, maxStack: 16,
});

export const BUCKET_WATER = defineItem(ITEM_ID.BUCKET_WATER, 'water_bucket', {
  displayName: 'Water Bucket', tile: TILE.BUCKET_WATER, maxStack: 1,
  bucket: { fluid: 'water' },
});

export const BUCKET_LAVA = defineItem(ITEM_ID.BUCKET_LAVA, 'lava_bucket', {
  displayName: 'Lava Bucket', tile: TILE.BUCKET_LAVA, maxStack: 1,
  bucket: { fluid: 'lava' },
});

export const BUCKET_MILK = defineItem(ITEM_ID.BUCKET_MILK, 'milk_bucket', {
  displayName: 'Milk Bucket', tile: TILE.BUCKET_MILK, maxStack: 1,
  // Milk places no block — it is the portal igniter.
  bucket: { fluid: 'milk', igniter: true },
});

/** Bucket descriptor for an item id, or null. */
export function getBucket(id) {
  const item = getItem(id);
  return item && item.bucket ? item.bucket : null;
}

/**
 * The bow is a tool so it gets durability and a non-stacking slot, but it has
 * its own `ranged` block of stats rather than a mining `kind`.
 */
export const BOW = defineItem(ITEM_ID.BOW, 'bow', {
  displayName: 'Bow',
  tile: TILE.BOW,
  maxStack: 1,
  tool: { kind: 'bow', material: 'wood', tier: -1, speed: 1, durability: 384, damage: 1 },
  ranged: {
    /** Seconds to a full draw. */
    drawTime: 1.0,
    /** Arrow speed at full charge. */
    speed: 34,
    /** Damage at full charge; scaled down for partial draws. */
    maxDamage: 9,
    minDamage: 1,
    spread: 0.012,
  },
});

/** Ranged weapon stats for an item id, or null. */
export function getRanged(id) {
  const item = getItem(id);
  return item && item.ranged ? item.ranged : null;
}

// ---------------------------------------------------------------------------
// Tools & armour
// ---------------------------------------------------------------------------

/**
 * Per-material gear stats.
 *  tier      — gates which ores you can collect (see block.harvestLevel)
 *  speed     — mining-speed multiplier vs. bare hands
 *  swordDamage / durability — combat and wear
 *
 * Gold keeps its Minecraft quirk: very fast, very fragile, low tier.
 */
export const TOOL_MATERIALS = {
  wood:    { label: 'Wooden',  tier: 0, speed: 2,  durability: 59,   swordDamage: 4, color: 0x9c7a4a },
  stone:   { label: 'Stone',   tier: 1, speed: 4,  durability: 131,  swordDamage: 5, color: 0x8a8a8a },
  iron:    { label: 'Iron',    tier: 2, speed: 6,  durability: 250,  swordDamage: 6, color: 0xd8d8d8 },
  gold:    { label: 'Golden',  tier: 0, speed: 12, durability: 32,   swordDamage: 4, color: 0xf2d24b },
  diamond: { label: 'Diamond', tier: 3, speed: 8,  durability: 1561, swordDamage: 7, color: 0x4de0d6 },
  // Combium sits above diamond: the reward for reaching the Comb dimension.
  combium: { label: 'Combium', tier: 4, speed: 11, durability: 2400, swordDamage: 9, color: 0xf2f0ea },
};

const TOOL_LABELS = { pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel', sword: 'Sword' };

/** id = TOOL_BASE + kindIndex * GEAR_STRIDE + materialIndex, matching the tiles. */
export function toolItemId(kind, material) {
  return ITEM_ID.TOOL_BASE + TOOL_KINDS.indexOf(kind) * GEAR_STRIDE + GEAR_MATERIALS.indexOf(material);
}

for (const kind of TOOL_KINDS) {
  for (const material of GEAR_MATERIALS) {
    const stats = TOOL_MATERIALS[material];
    defineItem(toolItemId(kind, material), `${material}_${kind}`, {
      displayName: `${stats.label} ${TOOL_LABELS[kind]}`,
      tile: toolTile(kind, material),
      maxStack: 1,
      tool: {
        kind,
        material,
        tier: stats.tier,
        speed: stats.speed,
        durability: stats.durability,
        // Swords hit hardest; other tools are middling weapons.
        damage: kind === 'sword' ? stats.swordDamage : Math.max(2, stats.swordDamage - 2),
      },
    });
  }
}

/**
 * Armour exists in the three metal tiers, as in Minecraft — there is no wooden
 * or stone armour to craft. Defense points are the classic values; each point
 * removes 4% of incoming damage, capped at 80%.
 */
export const ARMOR_MATERIALS = {
  iron:    { label: 'Iron',    defense: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 }, durability: { helmet: 165, chestplate: 240, leggings: 225, boots: 195 } },
  gold:    { label: 'Golden',  defense: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 }, durability: { helmet: 77,  chestplate: 112, leggings: 105, boots: 91 } },
  diamond: { label: 'Diamond', defense: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 }, durability: { helmet: 363, chestplate: 528, leggings: 495, boots: 429 } },
  // Combium caps the armour bar (20 points) but with far more durability.
  combium: { label: 'Combium', defense: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 }, durability: { helmet: 600, chestplate: 880, leggings: 810, boots: 700 } },
};

export const ARMOR_MATERIAL_NAMES = ['iron', 'gold', 'diamond', 'combium'];

const ARMOR_LABELS = { helmet: 'Helmet', chestplate: 'Chestplate', leggings: 'Leggings', boots: 'Boots' };

export function armorItemId(piece, material) {
  return ITEM_ID.ARMOR_BASE + ARMOR_PIECES.indexOf(piece) * GEAR_STRIDE + GEAR_MATERIALS.indexOf(material);
}

for (const piece of ARMOR_PIECES) {
  for (const material of ARMOR_MATERIAL_NAMES) {
    const stats = ARMOR_MATERIALS[material];
    defineItem(armorItemId(piece, material), `${material}_${piece}`, {
      displayName: `${stats.label} ${ARMOR_LABELS[piece]}`,
      tile: armorTile(piece, material),
      maxStack: 1,
      armor: {
        piece,
        material,
        defense: stats.defense[piece],
        durability: stats.durability[piece],
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function isBlockId(id) {
  return id > 0 && id < ITEM_ID_BASE;
}

export function getBlock(id) {
  return BLOCKS[id] ?? BLOCKS[AIR];
}

export function getItem(id) {
  return ITEMS[id - ITEM_ID_BASE];
}

/** Unified lookup used by the inventory / HUD, which mixes blocks and items. */
export function getThing(id) {
  return isBlockId(id) ? BLOCKS[id] : getItem(id);
}

/** Icon tile for the hotbar: blocks use their top face, items their icon. */
export function getIconTile(id) {
  if (isBlockId(id)) return BLOCKS[id].tiles[FACE_PY];
  const item = getItem(id);
  return item ? item.tile : 0;
}

export function getDisplayName(id) {
  const thing = getThing(id);
  return thing ? thing.displayName : 'Unknown';
}

export function isSolid(id) {
  const b = BLOCKS[id];
  return b ? b.solid : false;
}

export function isOpaque(id) {
  const b = BLOCKS[id];
  return b ? b.opaque : false;
}

export function isLiquid(id) {
  const b = BLOCKS[id];
  return b ? b.liquid : false;
}

/** Fluid descriptor `{family, level, maxLevel, height}`, or null. */
export function getFluid(id) {
  const b = BLOCKS[id];
  return b && b.fluid ? b.fluid : null;
}

/** Block id for a given fluid family and level. */
export function fluidId(family, level) {
  const f = FLUIDS[family];
  return f ? f.ids[level] : AIR;
}

/** Do two block ids belong to the same fluid family? */
export function sameFluidFamily(idA, idB) {
  const a = getFluid(idA);
  const b = getFluid(idB);
  return !!a && !!b && a.family === b.family;
}

export function isFluidFamily(id, family) {
  const f = getFluid(id);
  return !!f && f.family === family;
}

// ---------------------------------------------------------------------------
// Sound materials
// ---------------------------------------------------------------------------
/**
 * Which audio voice a block uses for footsteps, digging and breaking.
 * Assigned in one pass by name rather than repeated on every definition, so
 * adding a block only needs an entry here if it is not stone-like.
 */
const SOUND_BY_NAME = {
  grass: 'grass', dry_grass: 'grass', swamp_grass: 'grass',
  leaves: 'grass', acacia_leaves: 'grass', spruce_leaves: 'grass',
  dirt: 'dirt', podzol: 'dirt', clay: 'dirt',
  sand: 'sand', gravel: 'gravel',
  log: 'wood', acacia_log: 'wood', spruce_log: 'wood',
  planks: 'wood', crafting_table: 'wood',
  glass: 'glass', snow: 'wool', wool: 'wool',
  iron_block: 'metal', gold_block: 'metal', diamond_block: 'metal',
  furnace: 'metal', furnace_lit: 'metal',
};

for (const block of BLOCKS) {
  if (!block) continue;
  block.sound = block.liquid ? 'liquid' : (SOUND_BY_NAME[block.name] ?? 'stone');
}

/** Sound material for a block id. */
export function getSoundMaterial(id) {
  const b = BLOCKS[id];
  return b && b.sound ? b.sound : 'stone';
}

/** Every block a player can hold — used to build the creative palette. */
export function obtainableBlocks() {
  return BLOCKS.filter((b) => b && b.id !== AIR && b.obtainable).map((b) => b.id);
}

/** Every craftable item id, for the creative palette's item row. */
export function obtainableItems() {
  return ITEMS.filter((i) => i).map((i) => i.id);
}

/** Tool descriptor for an item id, or null. */
export function getTool(id) {
  const item = getItem(id);
  return item && item.tool ? item.tool : null;
}

/** Armour descriptor for an item id, or null. */
export function getArmor(id) {
  const item = getItem(id);
  return item && item.armor ? item.armor : null;
}

/** Stack limit — blocks always 64, tools and armour 1. */
export function getMaxStack(id) {
  if (isBlockId(id)) return 64;
  const item = getItem(id);
  return item ? item.maxStack : 64;
}

/** Max durability for a tool or armour piece, or 0 if it does not wear. */
export function getDurability(id) {
  const item = getItem(id);
  if (!item) return 0;
  if (item.tool) return item.tool.durability;
  if (item.armor) return item.armor.durability;
  return 0;
}
