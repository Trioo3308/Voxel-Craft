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

  // --- Farming --------------------------------------------------------------
  FARMLAND: 163,
  FARMLAND_MOIST: 164,
  WHEAT_0: 165,
  WHEAT_1: 166,
  WHEAT_2: 167,
  WHEAT_3: 168,
  WHEAT_ITEM: 169,
  SEEDS: 170,
  BREAD: 171,
  MOSSY_COBBLE: 172,

  // --- Saplings, ladders, tools ---------------------------------------------
  SAPLING_OAK: 186,
  SAPLING_ACACIA: 187,
  SAPLING_SPRUCE: 188,
  LADDER: 189,
  SHEARS: 190,
  FISHING_ROD: 191,
  FISH: 192,
  COOKED_FISH: 193,

  // --- Comb expansion -------------------------------------------------------
  AMBER_ORE: 194,
  HIVE_WALL: 195,
  HIVE_CORE: 196,
  RESIN_TORCH: 197,
  COMB_MOSS: 198,
  COMB_ASH: 199,
  DEEP_COMB: 200,
  CRYSTAL_CLUSTER: 201,
  AMBER_ITEM: 202,
  ROYAL_JELLY: 203,
  SHRINE_COMPASS: 204,
  SUSTINGUS_JELLY: 205,
  ROCKET: 206,
  SKATEBOARD: 207,

  // --- Rails, records, plates and food --------------------------------------
  RAIL: 208,
  SIGN: 209,
  JUKEBOX_TOP: 210,
  JUKEBOX_SIDE: 211,
  PRESSURE_PLATE: 212,
  MUSHROOM_RED: 213,
  MUSHROOM_BROWN: 214,
  BOAT: 215,
  BOWL: 216,
  MUSHROOM_STEW: 217,
  APPLE: 218,
  GOLDEN_APPLE: 219,
  DISC_DRIFT: 220,
  DISC_HOLLOW: 221,
  DISC_GRIND: 222,

  // --- Beds, and the caves ---------------------------------------------------
  BED_HEAD_TOP: 223,
  DEEPSLATE: 224,
  DEEPSLATE_COBBLE: 225,
  DRIPSTONE: 226,
  GLOW_LICHEN: 227,
  GEODE_SHELL: 228,
  GEODE_CRYSTAL: 229,
  CAVE_CRYSTAL: 230,
  GLOW_BERRY: 231,
  CAVE_LANTERN: 232,

  // --- The Comb -------------------------------------------------------------
  COMB_RESIN: 173,
  COMB_RESIN_ITEM: 174,
  COMB_LANTERN: 175,
  COMB_GLASS: 176,
  COMB_TILE: 177,
  COMB_PILLAR_TOP: 178,
  COMB_PILLAR_SIDE: 179,
  COMB_SPINE: 180,
  PALE_FUNGUS: 181,
  THRONE_AWAKENED_TOP: 182,
  THRONE_AWAKENED_SIDE: 183,
  CROWN: 184,
  COMB_WAX: 185,

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
export const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'];
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
  /**
   * Door panels, one per side of the block.
   *
   * A door used to have exactly two shapes — a panel on -Z when closed and one
   * on -X when open — with no notion of which way it had been placed. Approach
   * such a door from the east and the panel is off to one side of the cell, so
   * you walk *into* the block, stop halfway, and appear to clip through it.
   * Four panels and a facing is what fixes that.
   */
  PANEL_NZ: [[0, 0, 0, 1, 1, 0.1875]],
  PANEL_PZ: [[0, 0, 0.8125, 1, 1, 1]],
  PANEL_NX: [[0, 0, 0, 0.1875, 1, 1]],
  PANEL_PX: [[0.8125, 0, 0, 1, 1, 1]],
  BED: [[0, 0, 0, 1, 0.5625, 1]],
  TORCH: [[0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625]],
  CHEST: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]],
  // Tilled soil sits a notch below full height, so a field reads as worked
  // ground and you step down into it.
  FARMLAND: [[0, 0, 0, 1, 0.9375, 1]],
  // Crops are decoration you walk through; the box only shapes the render.
  CROP: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]],
  // A ladder is a thin panel against the -Z face.
  LADDER: [[0, 0, 0, 1, 1, 0.125]],
  // A rail is a low bar you grind along. Solid, so you can stand on it, but
  // barely raised — you should be able to roll onto one, not have to hop it.
  RAIL: [[0, 0, 0, 1, 0.125, 1]],
  // A plate is thinner still, and reads as pressed when you are standing on it.
  PLATE: [[0.0625, 0, 0.0625, 0.9375, 0.0625, 0.9375]],
  PLATE_PRESSED: [[0.0625, 0, 0.0625, 0.9375, 0.03125, 0.9375]],
  // A sign is a panel on a post.
  SIGN: [[0.0625, 0.5, 0.4375, 0.9375, 1, 0.5625], [0.4375, 0, 0.4375, 0.5625, 0.5, 0.5625]],
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
    /**
     * Extra chance-based drops on top of `drops`, as
     * `[{ id, chance, min, max }]`. Grass yielding the occasional seed is what
     * this exists for — a second drop table rather than replacing the first.
     */
    bonusDrops: options.bonusDrops ?? null,
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
    /**
     * Render as two crossed quads instead of a box — plants. A box would print
     * the plant's texture on its lid, which is why a field of crops rendered as
     * cubes looks wrong from above.
     */
    cross: options.cross === true,
    /** How tall a cross-rendered plant stands, 0..1. */
    crossHeight: options.crossHeight ?? 1,
    /** Damage dealt every half second while standing in this block. */
    contactDamage: options.contactDamage ?? 0,
    /** Tree style this sapling becomes, or null if it is not a sapling. */
    grows: options.grows ?? null,
    /** Standing in this block lets you climb up and down freely. */
    climbable: options.climbable === true,
    /** Leaves: decays when cut off from a log. */
    decays: options.decays === true,
    /** Leaves: the sapling this canopy drops. */
    sapling: options.sapling ?? null,
    /** Light this block emits, 0..15. */
    lightEmission: options.lightEmission ?? 0,
    /**
     * Facing index into FACINGS, for the blocks that have one. Null rather than
     * undefined so `!== null` is a reliable "is this a door" test — facing 0 is
     * a real facing and would fail a truthiness check.
     */
    doorFacing: options.doorFacing ?? null,
    doorOpen: options.doorOpen ?? false,
    bedFacing: options.bedFacing ?? null,
    bedHead: options.bedHead ?? false,
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
//
// Raised from 128 to 256 when doors and beds gained facings: four rotations
// times two states each is sixteen block ids on its own, and only eighteen were
// left under the old split. Voxels are a Uint8Array, so a block id can be
// anything up to 255 — 128 was never a storage limit, only the line that told
// `isBlockId` which side of the fence an id was on. Saves remap by name, so
// moving the line costs existing worlds nothing.
export const ITEM_ID_BASE = 256;

/**
 * Named items, in allocation order. Appending to this list is the whole of
 * adding an item id.
 *
 * The numbers used to be written out by hand, and the gear runs that follow
 * them were written out by hand too. That went wrong four separate times: every
 * new item pushed the named block up until it collided with `TOOL_BASE`, and
 * each collision meant renumbering both runs and re-proving that saved worlds
 * still loaded. Generating all of it removes the failure mode rather than
 * documenting it — and because saves remap by *name*, the actual numbers have
 * never mattered to anything but this file.
 *
 * The one real rule: **never reorder or delete an entry**, because that is what
 * the palette's names are keyed to. Append only.
 */
const NAMED_ITEMS = [
  'PORKCHOP', 'ROTTEN_FLESH', 'STICK', 'COAL', 'IRON_INGOT', 'GOLD_INGOT',
  'DIAMOND', 'REDSTONE', 'LAPIS', 'EMERALD', 'COOKED_PORKCHOP',
  'BEEF', 'COOKED_BEEF', 'MUTTON', 'COOKED_MUTTON', 'CHICKEN_RAW',
  'CHICKEN_COOKED', 'LEATHER', 'FEATHER', 'BONE', 'STRING', 'ARROW',
  'SPIDER_EYE', 'BOW', 'GUNPOWDER',

  // --- Combium & buckets ---------------------------------------------------
  'COMBIUM_INGOT', 'BUCKET', 'BUCKET_WATER', 'BUCKET_LAVA', 'BUCKET_MILK',
  'COMB_HEART', 'COMB_SHARD',

  // --- Farming --------------------------------------------------------------
  'WHEAT', 'SEEDS', 'BREAD',

  // --- The Comb -------------------------------------------------------------
  'COMB_RESIN', 'CROWN',

  // --- Husbandry, fishing and climbing --------------------------------------
  'SHEARS', 'FISHING_ROD', 'FISH', 'COOKED_FISH',

  // --- Comb expansion -------------------------------------------------------
  'AMBER', 'ROYAL_JELLY', 'SHRINE_COMPASS',

  // --- Sustingus, rockets, skateboard ---------------------------------------
  'SUSTINGUS_JELLY', 'ROCKET', 'SKATEBOARD',

  // --- Boats, food and records ----------------------------------------------
  'BOAT', 'BOWL', 'MUSHROOM_STEW', 'APPLE', 'GOLDEN_APPLE',
  'DISC_DRIFT', 'DISC_HOLLOW', 'DISC_GRIND',

  // --- The caves ------------------------------------------------------------
  'CAVE_CRYSTAL', 'GLOW_BERRY',
];

export const ITEM_ID = {};
for (let i = 0; i < NAMED_ITEMS.length; i++) ITEM_ID[NAMED_ITEMS[i]] = ITEM_ID_BASE + i;

/**
 * Tool and armour icons are generated parametrically (kind x material), so they
 * take contiguous runs after the named items rather than individual entries.
 * Both bases are rounded up to a multiple of the stride, purely so the numbers
 * stay readable when debugging.
 */
const roundUp = (n, step) => Math.ceil(n / step) * step;
ITEM_ID.TOOL_BASE = roundUp(ITEM_ID_BASE + NAMED_ITEMS.length, GEAR_STRIDE);
ITEM_ID.ARMOR_BASE = ITEM_ID.TOOL_BASE + roundUp(TOOL_KINDS.length * GEAR_STRIDE, GEAR_STRIDE);

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

/**
 * The four horizontal facings, in a fixed order.
 *
 * `dx`/`dz` is the direction the block faces — for a door, the side the panel
 * sits on and therefore the side you walk up to it from. Index order matters:
 * rotating by one step is `(facing + 1) % 4`, which is how a door swings.
 */
export const FACINGS = [
  { name: 'north', dx: 0, dz: -1, panel: 'PANEL_NZ' },
  { name: 'east',  dx: 1, dz: 0,  panel: 'PANEL_PX' },
  { name: 'south', dx: 0, dz: 1,  panel: 'PANEL_PZ' },
  { name: 'west',  dx: -1, dz: 0, panel: 'PANEL_NX' },
];

/** Nearest facing to a look direction. Used when placing a door or a bed. */
export function facingFromLook(dx, dz) {
  return Math.abs(dx) > Math.abs(dz)
    ? (dx > 0 ? 1 : 3)
    : (dz > 0 ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------
/**
 * Eight ids: four facings times open/closed.
 *
 * Metadata would be the obvious way to store a facing, but the world is a flat
 * Uint8Array with no room for it, and the mesher runs in a worker that only
 * receives that array — so anything the geometry depends on has to *be* the id.
 * That is the same reasoning behind the lit furnace and the awakened throne.
 *
 * A closed door's panel sits on its facing side; opening it swings the panel
 * one step round, which is why the facing order above is fixed.
 */
export const DOORS = [];
for (let f = 0; f < FACINGS.length; f++) {
  for (const open of [false, true]) {
    const facing = FACINGS[f];
    // Open swings the panel to the next side round.
    const panel = open ? FACINGS[(f + 1) % 4].panel : facing.panel;
    const id = 110 + f * 2 + (open ? 1 : 0);
    const block = defineBlock(id, open ? `door_open_${facing.name}` : `door_${facing.name}`, {
      displayName: 'Wooden Door', tiles: TILE.DOOR, hardness: 1.0, toolType: 'axe',
      shape: SHAPES[panel],
      // Only the plain closed north door is a real item; every other variant is
      // a state of one that has been placed, and drops that one.
      obtainable: !open && f === 0,
      doorFacing: f,
      doorOpen: open,
    });
    DOORS.push(block);
  }
}

/** The one you craft, carry and place. Facing is chosen at placement time. */
export const DOOR_CLOSED = DOORS[0];

export function doorBlock(facing, open) {
  return DOORS[((facing % 4) + 4) % 4 * 2 + (open ? 1 : 0)];
}

export function isDoor(id) {
  const block = BLOCKS[id];
  return !!block && block.doorFacing !== null;
}

export function isDoorOpen(id) {
  const block = BLOCKS[id];
  return !!block && block.doorOpen === true;
}

// Every door variant drops the carryable one.
for (const door of DOORS) door.drops = DOOR_CLOSED.id;

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------
/**
 * Eight ids: four facings times foot/head.
 *
 * A bed was one block, which meant it had no direction to lie in and looked
 * like a rug. Two halves give it a length, and the head end carries a pillow so
 * which way it points is readable without needing rotated textures — the mesher
 * has no UV rotation, so a directional top face is not on the table.
 */
export const BEDS = [];
for (let f = 0; f < FACINGS.length; f++) {
  for (const head of [false, true]) {
    const facing = FACINGS[f];
    const id = 118 + f * 2 + (head ? 1 : 0);
    const block = defineBlock(id, head ? `bed_head_${facing.name}` : `bed_foot_${facing.name}`, {
      displayName: 'Bed', hardness: 0.4,
      tiles: {
        top: head ? TILE.BED_HEAD_TOP : TILE.BED_TOP,
        bottom: TILE.PLANKS,
        side: TILE.BED_SIDE,
      },
      shape: SHAPES.BED,
      obtainable: !head && f === 0,
      bedFacing: f,
      bedHead: head,
    });
    BEDS.push(block);
  }
}

/** The one you craft and carry. */
export const BED = BEDS[0];

export function bedBlock(facing, head) {
  return BEDS[((facing % 4) + 4) % 4 * 2 + (head ? 1 : 0)];
}

export function isBed(id) {
  const block = BLOCKS[id];
  return !!block && block.bedFacing !== null;
}

for (const bed of BEDS) bed.drops = BED.id;

export const TORCH = defineBlock(64, 'torch', {
  displayName: 'Torch', tiles: TILE.TORCH, hardness: 0.1,
  shape: SHAPES.TORCH, emissive: true,
  // Decoration, not architecture — you walk through a torch rather than being
  // stopped by a stick. The shape is still used for rendering and the hitbox.
  solid: false,
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
  // Ground cover you brush through, like tall grass — it scatters the surface
  // of the Comb thickly enough that solid growths would make it a maze.
  opaque: false, cullSameType: false, solid: false,
  cross: true, crossHeight: 0.8,
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

// ---------------------------------------------------------------------------
// Farming
// ---------------------------------------------------------------------------

/**
 * Tilled soil. Two blocks rather than one with a moisture field, matching how
 * the lit/unlit furnace is done — the state is visible, so it may as well be
 * the block id, which also means it saves and syncs to the worker for free.
 *
 * Slightly shorter than a full cube, so a field reads as tilled at a glance.
 */
export const FARMLAND = defineBlock(75, 'farmland', {
  displayName: 'Farmland', hardness: 0.5, toolType: 'shovel',
  tiles: { top: TILE.FARMLAND, side: TILE.DIRT, bottom: TILE.DIRT },
  shape: SHAPES.FARMLAND,
  drops: 2, // reverts to plain dirt when broken
});

export const FARMLAND_MOIST = defineBlock(76, 'farmland_moist', {
  displayName: 'Farmland', hardness: 0.5, toolType: 'shovel',
  tiles: { top: TILE.FARMLAND_MOIST, side: TILE.DIRT, bottom: TILE.DIRT },
  shape: SHAPES.FARMLAND,
  drops: 2,
});

export function isFarmland(id) {
  return id === FARMLAND.id || id === FARMLAND_MOIST.id;
}

/**
 * Wheat, in four visible stages. Non-solid so you walk through a field, and
 * `cullSameType` off so neighbouring stalks do not erase each other's faces.
 */
export const WHEAT_STAGES = [];
for (let stage = 0; stage < 4; stage++) {
  WHEAT_STAGES.push(defineBlock(77 + stage, `wheat_stage_${stage}`, {
    displayName: 'Wheat',
    tiles: TILE.WHEAT_0 + stage,
    hardness: 0.05,
    solid: false, opaque: false, cullSameType: false,
    // Crossed quads, growing taller with each stage.
    cross: true, crossHeight: 0.45 + stage * 0.18,
    // Drops are handled specially: a ripe crop yields grain, an unripe one only
    // returns the seed you planted. See Game.onBlockBroken.
    drops: ITEM_ID.SEEDS,
  }));
}

/** The last stage is the only one worth harvesting. */
export const WHEAT_RIPE = WHEAT_STAGES[WHEAT_STAGES.length - 1];

export function wheatStage(id) {
  const index = WHEAT_STAGES.findIndex((b) => b.id === id);
  return index;
}

// ---------------------------------------------------------------------------
// Saplings and ladders
// ---------------------------------------------------------------------------

/**
 * Saplings. One per wood type, so the tree you plant is the tree you felled.
 *
 * `grows` names the tree style rather than pointing at blocks directly — the
 * growth code already knows how to build each style, and duplicating the
 * log/leaf pair here would be a second place to keep in step.
 */
export const SAPLINGS = [];
function defineSapling(id, tile, name, displayName, grows) {
  const block = defineBlock(id, name, {
    displayName, tiles: tile, hardness: 0.05,
    solid: false, opaque: false, cullSameType: false,
    cross: true, crossHeight: 0.7,
    grows,
  });
  SAPLINGS.push(block);
  return block;
}

export const SAPLING_OAK = defineSapling(91, TILE.SAPLING_OAK, 'oak_sapling', 'Oak Sapling', 'oak');
export const SAPLING_ACACIA = defineSapling(92, TILE.SAPLING_ACACIA, 'acacia_sapling', 'Acacia Sapling', 'acacia');
export const SAPLING_SPRUCE = defineSapling(93, TILE.SAPLING_SPRUCE, 'spruce_sapling', 'Spruce Sapling', 'spruce');

export function isSapling(id) {
  const b = BLOCKS[id];
  return !!b && !!b.grows;
}

/**
 * Leaves become their own sapling and the occasional stick.
 *
 * Wired up here rather than in each leaf's options because saplings are defined
 * after the leaves are; the alternative is writing the ids inline, which is the
 * magic-number trap the save palette exists to avoid.
 *
 * Both drops are chance-based, so clearing a canopy gives you enough to replant
 * without burying you in saplings.
 */
for (const [leaf, sapling] of [
  [LEAVES, SAPLING_OAK],
  [ACACIA_LEAVES, SAPLING_ACACIA],
  [SPRUCE_LEAVES, SAPLING_SPRUCE],
]) {
  leaf.drops = 0;   // nothing guaranteed; everything comes off the bonus table
  leaf.sapling = sapling.id;
  leaf.decays = true;
  leaf.bonusDrops = [
    { id: sapling.id, chance: 0.11, min: 1, max: 1 },
    { id: ITEM_ID.STICK, chance: 0.08, min: 1, max: 2 },
  ];
}

/**
 * Only oak drops apples, and rarely — it should feel like a find rather than a
 * reason to farm leaves, and it gives the three tree species something to tell
 * them apart beyond colour.
 */
LEAVES.bonusDrops.push({ id: ITEM_ID.APPLE, chance: 0.035, min: 1, max: 1 });

/** Blocks that hold leaves up. A leaf too far from one of these decays. */
export const LEAF_SUPPORTS = new Set([LOG.id, ACACIA_LOG.id, SPRUCE_LOG.id]);

export function isLeaf(id) {
  const b = BLOCKS[id];
  return !!b && b.decays === true;
}

/**
 * A ladder. Climbable rather than solid: standing in one lets you move up and
 * down freely, which is handled in the player's physics.
 */
export const LADDER = defineBlock(94, 'ladder', {
  displayName: 'Ladder', tiles: TILE.LADDER, hardness: 0.4, toolType: 'axe',
  solid: false, opaque: false, cullSameType: false,
  climbable: true,
  // A thin panel against one wall rather than a cross — you should be able to
  // see past a ladder, and it should not look like a plant.
  shape: SHAPES.LADDER,
});

// ---------------------------------------------------------------------------
// The Comb — materials, flora and hazards
// ---------------------------------------------------------------------------

/**
 * Waxy amber seams in the comb walls. The dimension's renewable material.
 * Named for the seam rather than the substance, because the lump it drops is
 * `comb_resin` and the save palette keys on names being unique.
 */
export const COMB_RESIN = defineBlock(82, 'comb_resin_seam', {
  displayName: 'Resin Seam', tiles: TILE.COMB_RESIN, hardness: 0.9,
  toolType: 'axe',
  drops: ITEM_ID.COMB_RESIN, dropCount: [2, 4],
  lightEmission: 3,
});

/** Sealed wax — soft, quiet underfoot, and the base for resin building blocks. */
export const COMB_WAX = defineBlock(83, 'comb_wax', {
  displayName: 'Comb Wax', tiles: TILE.COMB_WAX, hardness: 0.7, toolType: 'axe',
});

/** A proper light source for the Comb, brighter than a torch. */
export const COMB_LANTERN = defineBlock(84, 'comb_lantern', {
  displayName: 'Comb Lantern', tiles: TILE.COMB_LANTERN, hardness: 0.6,
  toolType: 'pickaxe', emissive: true, lightEmission: 15,
});

export const COMB_GLASS = defineBlock(85, 'comb_glass', {
  displayName: 'Comb Glass', tiles: TILE.COMB_GLASS, hardness: 0.4,
  opaque: false, toolType: 'pickaxe',
});

/** Polished floor tile and a fluted pillar — the shrine's architecture. */
export const COMB_TILE = defineBlock(86, 'comb_tile', {
  displayName: 'Comb Tile', tiles: TILE.COMB_TILE, hardness: 2.6,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
});

export const COMB_PILLAR = defineBlock(87, 'comb_pillar', {
  displayName: 'Comb Pillar', hardness: 2.6,
  tiles: { top: TILE.COMB_PILLAR_TOP, bottom: TILE.COMB_PILLAR_TOP, side: TILE.COMB_PILLAR_SIDE },
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
});

/**
 * Crimson spines. Walking into them hurts — the Comb's only environmental
 * hazard, and the reason its floor is worth looking at before you sprint.
 */
export const COMB_SPINE = defineBlock(88, 'comb_spine', {
  displayName: 'Comb Spine', tiles: TILE.COMB_SPINE, hardness: 0.2,
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.7,
  /** Damage per second while standing in it. */
  contactDamage: 2,
});

/** Faintly luminous fungus, thick in the hollow cells. */
export const PALE_FUNGUS = defineBlock(89, 'pale_fungus', {
  displayName: 'Pale Fungus', tiles: TILE.PALE_FUNGUS, hardness: 0.1,
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.6,
  emissive: true, lightEmission: 6,
});

/**
 * The throne once a Comb Heart has been set in it. Purely a different block —
 * the state is visible, so it may as well be the id, which also means it saves
 * and syncs to the worker for free.
 */
export const THRONE_AWAKENED = defineBlock(90, 'comb_throne_awakened', {
  displayName: 'Awakened Throne', hardness: 6.0,
  tiles: { top: TILE.THRONE_AWAKENED_TOP, bottom: TILE.COMB_BRICK, side: TILE.THRONE_AWAKENED_SIDE },
  toolType: 'pickaxe', harvestLevel: 2, requiresTool: true,
  emissive: true, lightEmission: 14,
  obtainable: false,
});

// ---------------------------------------------------------------------------
// Comb expansion — regions, hives and the deep
// ---------------------------------------------------------------------------

/** Amber, locked in the stone. What the shrine compass is made from. */
export const AMBER_ORE = defineBlock(95, 'amber_ore', {
  displayName: 'Amber Ore', tiles: TILE.AMBER_ORE, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
  drops: ITEM_ID.AMBER, dropCount: [1, 2],
  lightEmission: 2,
});

/** Hive walls: dense wax, harder than the resin it is built from. */
export const HIVE_WALL = defineBlock(96, 'hive_wall', {
  displayName: 'Hive Wall', tiles: TILE.HIVE_WALL, hardness: 2.2, toolType: 'axe',
});

/**
 * The heart of a hive. Breaking it is what releases the royal jelly, and it is
 * the only source — so a hive is a place you raid rather than a place you pass.
 */
export const HIVE_CORE = defineBlock(97, 'hive_core', {
  displayName: 'Hive Core', tiles: TILE.HIVE_CORE, hardness: 4.0,
  toolType: 'axe', requiresTool: true,
  drops: ITEM_ID.ROYAL_JELLY, dropCount: [2, 4],
  emissive: true, lightEmission: 10,
});

/** A cheap Comb light source, made from resin rather than coal. */
export const RESIN_TORCH = defineBlock(98, 'resin_torch', {
  displayName: 'Resin Torch', tiles: TILE.RESIN_TORCH, hardness: 0.1,
  shape: SHAPES.TORCH, emissive: true, solid: false,
  lightEmission: 12,
});

/** Ground cover for the two surface regions that are not bare plateau. */
export const COMB_MOSS = defineBlock(99, 'comb_moss', {
  displayName: 'Comb Moss', tiles: TILE.COMB_MOSS, hardness: 0.5, toolType: 'shovel',
});

export const COMB_ASH = defineBlock(100, 'comb_ash', {
  displayName: 'Comb Ash', tiles: TILE.COMB_ASH, hardness: 0.4, toolType: 'shovel',
});

/** The stratum below the hollow cells — darker, denser, and where amber lives. */
export const DEEP_COMB = defineBlock(101, 'deep_comb_stone', {
  displayName: 'Deep Comb Stone', tiles: TILE.DEEP_COMB, hardness: 2.4,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
});

/** Big crystal growths — brighter than the veins, and they drop more. */
export const CRYSTAL_CLUSTER = defineBlock(102, 'crystal_cluster', {
  displayName: 'Crystal Cluster', tiles: TILE.CRYSTAL_CLUSTER, hardness: 1.6,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
  drops: ITEM_ID.COMB_SHARD, dropCount: [4, 7],
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.9,
  emissive: true, lightEmission: 11,
});

/** Damp, overgrown stone — the tell that a room down here was built, not carved. */
export const MOSSY_COBBLE = defineBlock(81, 'mossy_cobblestone', {
  displayName: 'Mossy Cobblestone', tiles: TILE.MOSSY_COBBLE, hardness: 2.0,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
});

// ---------------------------------------------------------------------------
// Rails, records, plates, signs and mushrooms
// ---------------------------------------------------------------------------

/**
 * A grind rail.
 *
 * Solid so you can stand on it, but only an eighth of a block tall so you roll
 * onto one rather than having to hop it — the whole point is that a line of
 * rails is something you ride, not an obstacle.
 */
export const RAIL = defineBlock(103, 'rail', {
  displayName: 'Grind Rail', tiles: TILE.RAIL, hardness: 0.7,
  toolType: 'pickaxe', shape: SHAPES.RAIL, opaque: false,
});

/** Holds four lines of whatever you type. Text lives in a block entity. */
export const SIGN = defineBlock(104, 'sign', {
  displayName: 'Sign', tiles: TILE.SIGN, hardness: 0.6, toolType: 'axe',
  shape: SHAPES.SIGN, opaque: false, solid: false,
});

/** Plays a record. Which record is playing lives in a block entity. */
export const JUKEBOX = defineBlock(105, 'jukebox', {
  displayName: 'Jukebox', hardness: 1.6, toolType: 'axe',
  tiles: { top: TILE.JUKEBOX_TOP, bottom: TILE.PLANKS, side: TILE.JUKEBOX_SIDE },
});

/**
 * Two blocks rather than one block with a flag: the pressed state is visible,
 * so making it the id means it meshes, saves and syncs to the worker for free —
 * the same trick the door and the throne use.
 */
export const PRESSURE_PLATE = defineBlock(106, 'pressure_plate', {
  displayName: 'Pressure Plate', tiles: TILE.PRESSURE_PLATE, hardness: 0.5,
  toolType: 'axe', shape: SHAPES.PLATE, opaque: false, solid: false,
});

export const PRESSURE_PLATE_PRESSED = defineBlock(107, 'pressure_plate_pressed', {
  displayName: 'Pressure Plate', tiles: TILE.PRESSURE_PLATE, hardness: 0.5,
  toolType: 'axe', shape: SHAPES.PLATE_PRESSED, opaque: false, solid: false,
  drops: 106, obtainable: false,
});

export function isPlate(id) {
  return id === PRESSURE_PLATE.id || id === PRESSURE_PLATE_PRESSED.id;
}

export const MUSHROOM_RED = defineBlock(108, 'mushroom_red', {
  displayName: 'Red Mushroom', tiles: TILE.MUSHROOM_RED, hardness: 0.1,
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.4,
});

export const MUSHROOM_BROWN = defineBlock(109, 'mushroom_brown', {
  displayName: 'Brown Mushroom', tiles: TILE.MUSHROOM_BROWN, hardness: 0.1,
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.4,
});

// ---------------------------------------------------------------------------
// The deep: stone, decoration and what grows down there
// ---------------------------------------------------------------------------

/**
 * Deepslate. Below y16 the stone changes, so how far down you are is readable
 * without checking the coordinate readout — which matters now that the deep is
 * somewhere you spend time rather than a wall you tunnel through.
 *
 * Slower to mine than stone, so descending still costs something.
 */
export const DEEPSLATE = defineBlock(126, 'deepslate', {
  displayName: 'Deepslate', tiles: TILE.DEEPSLATE, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
  drops: 127,
});

export const DEEPSLATE_COBBLE = defineBlock(127, 'deepslate_cobble', {
  displayName: 'Cobbled Deepslate', tiles: TILE.DEEPSLATE_COBBLE, hardness: 3.0,
  toolType: 'pickaxe', harvestLevel: 0, requiresTool: true,
});

/**
 * Dripstone. Rendered as a cross rather than a box for the same reason plants
 * are: a box would print the tapered texture onto a cube's lid and read as a
 * stone block with a spike drawn on top.
 */
export const DRIPSTONE = defineBlock(128, 'dripstone', {
  displayName: 'Dripstone', tiles: TILE.DRIPSTONE, hardness: 1.4,
  toolType: 'pickaxe', requiresTool: true,
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.9,
});

/** Faint light, growing on cave walls. The reason a cave is navigable at all. */
export const GLOW_LICHEN = defineBlock(129, 'glow_lichen', {
  displayName: 'Glow Lichen', tiles: TILE.GLOW_LICHEN, hardness: 0.2,
  solid: false, opaque: false, cullSameType: false,
  cross: true, crossHeight: 0.85,
  emissive: true, lightEmission: 7,
  // Drops itself, so lichen is a light source you can gather and replant, and
  // occasionally a berry — which is what makes clearing a patch worth doing.
  bonusDrops: [{ id: ITEM_ID.GLOW_BERRY, chance: 0.35, min: 1, max: 2 }],
});

/** The rind of a geode — you break through this to reach the crystals. */
export const GEODE_SHELL = defineBlock(130, 'geode_shell', {
  displayName: 'Geode Shell', tiles: TILE.GEODE_SHELL, hardness: 2.6,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
});

/** What is inside one. Bright, and the only source of cave crystal. */
export const GEODE_CRYSTAL = defineBlock(131, 'geode_crystal', {
  displayName: 'Crystal Cluster', tiles: TILE.GEODE_CRYSTAL, hardness: 1.8,
  toolType: 'pickaxe', harvestLevel: 1, requiresTool: true,
  emissive: true, lightEmission: 9,
  drops: ITEM_ID.CAVE_CRYSTAL, dropCount: [2, 4],
});

/** Brighter than a torch and it does not need coal — the reward for a geode. */
export const CAVE_LANTERN = defineBlock(132, 'cave_lantern', {
  displayName: 'Cave Lantern', tiles: TILE.CAVE_LANTERN, hardness: 0.4,
  emissive: true, lightEmission: 15,
});

/** Every log/leaf pair, so terrain can pick a tree style per biome. */
export const TREE_WOODS = {
  oak: { log: LOG.id, leaves: LEAVES.id },
  acacia: { log: ACACIA_LOG.id, leaves: ACACIA_LEAVES.id },
  spruce: { log: SPRUCE_LOG.id, leaves: SPRUCE_LEAVES.id },
};

// ---------------------------------------------------------------------------
// Items — ids at or above ITEM_ID_BASE, so one comparison tells a placeable
// block from an item. See the note on ITEM_ID_BASE for why the line moved.
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
    /** Held item that gives a bearing to the nearest Comb shrine. */
    locatesShrines: options.locatesShrines === true,
    /** Health restored on top of the hunger, for the rare restorative foods. */
    healing: options.healing ?? 0,
    /** Item left in your hand after eating — the bowl a stew came in. */
    eatReturns: options.eatReturns ?? 0,
    /** Which tune this record plays in a jukebox; null for everything else. */
    disc: options.disc ?? null,
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

// --- Farming ---------------------------------------------------------------
export const WHEAT = defineItem(ITEM_ID.WHEAT, 'wheat', {
  displayName: 'Wheat', tile: TILE.WHEAT_ITEM,
});
export const SEEDS = defineItem(ITEM_ID.SEEDS, 'wheat_seeds', {
  displayName: 'Wheat Seeds', tile: TILE.SEEDS,
});
/** The first food you can farm rather than hunt. */
export const BREAD = defineItem(ITEM_ID.BREAD, 'bread', {
  displayName: 'Bread', tile: TILE.BREAD, food: 5, saturation: 6,
});

// --- Comb expansion ---------------------------------------------------------
export const AMBER = defineItem(ITEM_ID.AMBER, 'amber', {
  displayName: 'Amber', tile: TILE.AMBER_ITEM,
});

/** Strong, rare food. The only source is a hive core. */
export const ROYAL_JELLY = defineItem(ITEM_ID.ROYAL_JELLY, 'royal_jelly', {
  displayName: 'Royal Jelly', tile: TILE.ROYAL_JELLY, food: 8, saturation: 9,
});

/**
 * Sustingus jelly.
 *
 * Nobody has established what a sustingus is, and the jelly is no more
 * forthcoming. It is edible, it keeps indefinitely, and it burns with enough
 * enthusiasm to make it the fuel every rocket in this game runs on.
 */
export const SUSTINGUS_JELLY = defineItem(ITEM_ID.SUSTINGUS_JELLY, 'sustingus_jelly', {
  displayName: 'Sustingus Jelly', tile: TILE.SUSTINGUS_JELLY, food: 4, saturation: 5,
});

/** Goes up, makes a noise, makes some colours. Also shoves a skateboard along. */
export const ROCKET = defineItem(ITEM_ID.ROCKET, 'rocket', {
  displayName: 'Rocket', tile: TILE.ROCKET, maxStack: 16,
});

/**
 * Right click to drop in and ride.
 *
 * Deliberately not a `tool`: that descriptor is what makes an item wear out
 * when you mine or swing with it, and a board that snapped because you dug a
 * hole while carrying it would be nonsense. It never breaks.
 */
export const SKATEBOARD = defineItem(ITEM_ID.SKATEBOARD, 'skateboard', {
  displayName: 'Skateboard', tile: TILE.SKATEBOARD, maxStack: 1,
});

// ---------------------------------------------------------------------------
// Boats, food and records
// ---------------------------------------------------------------------------

/** Right click water to set it down, right click the boat to get in. */
export const BOAT = defineItem(ITEM_ID.BOAT, 'boat', {
  displayName: 'Boat', tile: TILE.BOAT, maxStack: 1,
});

export const BOWL = defineItem(ITEM_ID.BOWL, 'bowl', {
  displayName: 'Bowl', tile: TILE.BOWL,
});

/**
 * Worth more than bread and made from something you find rather than farm, so
 * there is a reason to pick up the mushrooms you walk past.
 */
export const MUSHROOM_STEW = defineItem(ITEM_ID.MUSHROOM_STEW, 'mushroom_stew', {
  displayName: 'Mushroom Stew', tile: TILE.MUSHROOM_STEW,
  food: 6, saturation: 7, maxStack: 1,
  /** Eating it leaves the bowl behind. */
  eatReturns: ITEM_ID.BOWL,
});

/** Falls out of oak leaves now and then. The cheapest food in the game. */
export const APPLE = defineItem(ITEM_ID.APPLE, 'apple', {
  displayName: 'Apple', tile: TILE.APPLE, food: 4, saturation: 3,
});

/**
 * The one food that heals rather than just feeds. Expensive on purpose — eight
 * gold for a heal is meant to be a decision, not a habit.
 */
export const GOLDEN_APPLE = defineItem(ITEM_ID.GOLDEN_APPLE, 'golden_apple', {
  displayName: 'Golden Apple', tile: TILE.GOLDEN_APPLE,
  food: 4, saturation: 10, healing: 6,
});

/**
 * Records. Not craftable — they are dungeon and shrine loot, so a jukebox is a
 * reason to go somewhere rather than a reason to stand at a bench.
 */
export const DISC_DRIFT = defineItem(ITEM_ID.DISC_DRIFT, 'disc_drift', {
  displayName: 'Music Disc — Drift', tile: TILE.DISC_DRIFT, maxStack: 1, disc: 'drift',
});
export const DISC_HOLLOW = defineItem(ITEM_ID.DISC_HOLLOW, 'disc_hollow', {
  displayName: 'Music Disc — Hollow', tile: TILE.DISC_HOLLOW, maxStack: 1, disc: 'hollow',
});
export const DISC_GRIND = defineItem(ITEM_ID.DISC_GRIND, 'disc_grind', {
  displayName: 'Music Disc — Grind', tile: TILE.DISC_GRIND, maxStack: 1, disc: 'grind',
});

/** Every record, in the order the loot tables roll them. */
export const MUSIC_DISCS = [DISC_DRIFT, DISC_HOLLOW, DISC_GRIND];

// ---------------------------------------------------------------------------
// What the caves yield
// ---------------------------------------------------------------------------

/** Cut out of a geode. Makes the lantern, and nothing else yet. */
export const CAVE_CRYSTAL = defineItem(ITEM_ID.CAVE_CRYSTAL, 'cave_crystal', {
  displayName: 'Cave Crystal', tile: TILE.CAVE_CRYSTAL,
});

/**
 * Picked off glow lichen. Weak food, but it is food you find in the one place
 * you cannot farm — which is the point of it.
 */
export const GLOW_BERRY = defineItem(ITEM_ID.GLOW_BERRY, 'glow_berry', {
  displayName: 'Glow Berries', tile: TILE.GLOW_BERRY, food: 2, saturation: 1,
});

/**
 * Points at the nearest shrine.
 *
 * Shrines are one per ~1600 chunks by design, which is a long walk even when you
 * know roughly where to go and an impossible one when you do not. This makes
 * finding one navigation rather than luck: hold it and the HUD gives a live
 * bearing and distance.
 */
export const SHRINE_COMPASS = defineItem(ITEM_ID.SHRINE_COMPASS, 'shrine_compass', {
  displayName: 'Shrine Compass', tile: TILE.SHRINE_COMPASS, maxStack: 1,
  /** Read by the HUD; the item itself holds no state. */
  locatesShrines: true,
});

// --- Husbandry and fishing --------------------------------------------------
/** Shears: not a mining tool, so they get durability without a `tool` block. */
export const SHEARS = defineItem(ITEM_ID.SHEARS, 'shears', {
  displayName: 'Shears', tile: TILE.SHEARS, maxStack: 1,
  tool: { kind: 'shears', material: 'iron', tier: -1, speed: 1, durability: 238, damage: 2 },
});

export const FISHING_ROD = defineItem(ITEM_ID.FISHING_ROD, 'fishing_rod', {
  displayName: 'Fishing Rod', tile: TILE.FISHING_ROD, maxStack: 1,
  tool: { kind: 'rod', material: 'wood', tier: -1, speed: 1, durability: 64, damage: 1 },
});

export const FISH = defineItem(ITEM_ID.FISH, 'fish', {
  displayName: 'Raw Fish', tile: TILE.FISH, food: 2, saturation: 1,
});
export const COOKED_FISH = defineItem(ITEM_ID.COOKED_FISH, 'cooked_fish', {
  displayName: 'Cooked Fish', tile: TILE.COOKED_FISH, food: 5, saturation: 6,
});

// --- The Comb ---------------------------------------------------------------
export const COMB_RESIN_ITEM = defineItem(ITEM_ID.COMB_RESIN, 'comb_resin', {
  displayName: 'Comb Resin', tile: TILE.COMB_RESIN_ITEM,
  // Edible, barely — it is wax. Enough to keep you moving, never enough to live on.
  food: 2, saturation: 1,
});

/**
 * The Crown. Not craftable, not lootable — the only one in a world comes from
 * awakening a throne, which means beating the Warden guarding it.
 */
export const CROWN = defineItem(ITEM_ID.CROWN, 'comb_crown', {
  displayName: 'Crown of the Comb',
  tile: TILE.CROWN,
  maxStack: 1,
  armor: { piece: 'helmet', material: 'crown', defense: 4, durability: 1400 },
});

/**
 * Seeds come from digging up any grassy surface — the entry point into farming
 * has to be something you trip over in the first minute, not a reward.
 *
 * Assigned here rather than in each block's options because those are declared
 * long before `ITEM_ID` exists; writing the number inline would be a magic
 * constant that the name-based save palette could not protect.
 */
for (const grassy of [GRASS, DRY_GRASS, PODZOL, SWAMP_GRASS]) {
  grassy.bonusDrops = [{ id: ITEM_ID.SEEDS, chance: 0.22, min: 1, max: 1 }];
}
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

const TOOL_LABELS = { pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel', sword: 'Sword', hoe: 'Hoe' };

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
        // Swords hit hardest; a hoe is a farming implement and a poor weapon;
        // everything else is middling.
        damage: kind === 'sword' ? stats.swordDamage
              : kind === 'hoe' ? 1
              : Math.max(2, stats.swordDamage - 2),
        /** Tills grass and dirt into farmland. */
        tills: kind === 'hoe',
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
