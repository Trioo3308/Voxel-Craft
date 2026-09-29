/**
 * hud.js — All DOM-based user interface.
 *
 * Kept deliberately separate from the 3D layer: the HUD only ever *reads* game
 * state and writes to elements defined in index.html. Nothing in the simulation
 * depends on the HUD existing, so it is safe to restyle or replace wholesale.
 *
 * Slot handling is generic. Every clickable slot supplies a `get`/`set` pair,
 * so the hotbar, backpack, armour, crafting grids and furnace all share one
 * implementation of pick-up / place / split.
 */

import { getTileDataURL } from '../world/textures.js';
import {
  getIconTile, getDisplayName, obtainableBlocks, obtainableItems,
  getMaxStack, getDurability, getArmor, getTool, getThing, getBlock, isBlockId, ARMOR_PIECES,
  BLOCKS, ITEM_ID, TOOL_KINDS, toolItemId, armorItemId,
  idByName,
} from '../world/blocks.js';
import { HOTBAR_SIZE, STORAGE_SIZE, Inventory } from '../player/inventory.js';
import { findRecipe, consumeGrid, fuelValueFor, smeltResultFor, SMELT_SECONDS } from '../player/crafting.js';
import {
  tableOffers, tableAccepts, applyEnchantments, anvilCombine, describeEnchantments, isEnchanted,
  enchantability, ENCHANTMENTS, roman, ANVIL_LIMIT,
} from '../player/enchanting.js';
import { roundXp } from '../player/experience.js';
import { ACHIEVEMENTS, ADVANCEMENT_TABS } from '../player/progress.js';
import { BIOME_NAMES } from '../world/terrain.js';
import { dimensionInfo } from '../world/dimensions.js';
import Settings from '../settings.js';
import { audio } from '../engine/audio.js';
import { keybinds } from '../engine/keybinds.js';
import { prefs } from '../engine/preferences.js';
import { Vitals } from './vitals.js';
import { RecipeBook } from './recipeBook.js';
import { CompassStrip } from './compassStrip.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** As many characters as fit legibly on a sign in the world. */
const SIGN_LINE_LENGTH = 15;


const el = (id) => document.getElementById(id);

/** Two clicks on the same slot within this many ms gather matching items. */
const DOUBLE_CLICK_MS = 300;

/** Name colours for the better materials, so a good find reads as one. */
const MATERIAL_COLORS = {
  iron: '#e8e8e8', gold: '#ffd84d', diamond: '#7ff0e6', combium: '#fff1c9', crown: '#ffd84d',
};

/** Harvest tiers as the tool a block asks for. Matches the gear table in blocks.js. */
const TIER_NAMES = ['wooden', 'stone', 'iron', 'diamond', 'combium'];

/**
 * What a tooltip says about a stack: its name, and only the facts that change
 * what you would do with it.
 */
function describeStack(stack) {
  const lines = [];
  let color = null;
  const tool = getTool(stack.id);
  const armor = getArmor(stack.id);

  if (tool) {
    color = MATERIAL_COLORS[tool.material] ?? null;
    if (tool.kind === 'sword') lines.push(`${tool.damage} attack damage`);
    else if (['pickaxe', 'axe', 'shovel', 'hoe'].includes(tool.kind)) lines.push(`Mining speed ×${tool.speed}`);
  }
  if (armor) {
    color = MATERIAL_COLORS[armor.material] ?? color;
    lines.push(`+${armor.defense} armour`);
  }

  const max = getDurability(stack.id);
  if (max > 0) lines.push(`Durability ${stack.durability ?? max} / ${max}`);

  const thing = getThing(stack.id);
  if (thing && thing.food > 0) {
    lines.push(`Restores ${thing.food} hunger` + (thing.healing > 0 ? `, heals ${thing.healing}` : ''));
  }

  if (isBlockId(stack.id)) {
    const block = getBlock(stack.id);
    if (block.requiresTool && block.toolType) {
      const tier = TIER_NAMES[block.harvestLevel ?? 0] ?? 'better';
      lines.push(`Needs a ${tier} ${block.toolType} or better`);
    }
  }

  const smelt = smeltResultFor(stack.id);
  if (smelt) lines.push(`Smelts into ${getDisplayName(smelt.id)}`);
  const fuel = fuelValueFor(stack.id);
  if (fuel > 0) {
    const items = fuel / SMELT_SECONDS;
    const text = Number.isInteger(items) ? String(items) : items.toFixed(1);
    lines.push(`Fuel: smelts ${text} item${items === 1 ? '' : 's'}`);
  }

  if (stack.count > 1) lines.push(`Stack of ${stack.count}`);
  // Enchantments are listed right under the name, and an enchanted thing's
  // name turns aqua, as in Minecraft.
  const ench = describeEnchantments(stack);
  if (ench.length > 0) color = '#7ff2f2';
  if (stack.work > 0) lines.push(`Worked at an anvil ${stack.work} time${stack.work === 1 ? '' : 's'}`);
  return { name: getDisplayName(stack.id), color, lines, ench };
}

/**
 * Lay out one tab's advancements as a tree growing left to right: depth is the
 * column, leaves take one row each in order, and a parent sits level with the
 * middle of its children.
 * @returns {{pos: Map<string,{x,y}>, depth: number, rows: number}}
 */
function layoutTree(nodes) {
  const names = new Set(nodes.map((n) => n.name));
  const children = new Map();
  const roots = [];
  for (const node of nodes) {
    if (node.parent && names.has(node.parent)) {
      if (!children.has(node.parent)) children.set(node.parent, []);
      children.get(node.parent).push(node);
    } else {
      roots.push(node);
    }
  }
  const pos = new Map();
  let row = 0;
  let depth = 0;
  const place = (node, x) => {
    depth = Math.max(depth, x);
    const kids = children.get(node.name) ?? [];
    let y;
    if (kids.length === 0) {
      y = row++;
    } else {
      const ys = kids.map((kid) => place(kid, x + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(node.name, { x, y });
    return y;
  };
  for (const root of roots) {
    place(root, 0);
    row += 0.5;
  }
  return { pos, depth, rows: Math.ceil(row) };
}

/**
 * The enchanting table's line of unreadable script, fixed by the seed so it
 * holds still while you think. The glyphs are the ones Minecraft's table
 * writes in, borrowed from Unicode lookalikes.
 */
const GLYPHS = ['ᔑ', 'ʖ', 'ᓵ', '↸', 'ᒷ', '⎓', '⊣', '⍑', '╎', '⋮', 'ꖌ', 'ꖎ', 'ᒲ', 'リ', '∷', 'ᓭ', 'ℸ', '⚍', '⍊', '∴', 'ᑑ', '⨅'];
function glyphLine(seed) {
  let h = seed >>> 0;
  const next = () => {
    h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return h / 4294967296;
  };
  const words = [];
  for (let w = 0; w < 3; w++) {
    let word = '';
    const length = 2 + Math.floor(next() * 4);
    for (let c = 0; c < length; c++) word += GLYPHS[Math.floor(next() * GLYPHS.length)];
    words.push(word);
  }
  return words.join(' ');
}

/**
 * The picture on each achievement's card: an item or block that stands for
 * it. By name, like the achievements themselves. Anything missing just shows
 * a card without a picture.
 */
const ACHIEVEMENT_ICONS = {
  wood: 'log', bench: 'crafting_table', pickaxe: ['pickaxe', 'wood'], furnace: 'furnace',
  iron: 'IRON_INGOT', diamonds: 'DIAMOND', deep: 'bedrock', farmer: 'BREAD', shepherd: 'wool',
  angler: 'FISH', tamer: 'BONE', sailor: 'BOAT', dj: 'jukebox', combium: 'COMBIUM_INGOT',
  portal: 'obsidian', comb: 'combium_ore', obsidian: 'obsidian', nether: 'netherrack',
  glowstone: 'glowstone', aether: 'aether_grass', warden: ['sword', 'combium'], throne: 'CROWN',
  skater: 'SKATEBOARD', grinder: 'rail', sevenTwenty: 'SKATEBOARD', stylish: 'ROCKET',
  miner: ['pickaxe', 'iron'], walker: ['boots', 'iron'], survivor: 'bed_foot_north',
};

function achievementIcon(name) {
  // Advancements name their own icon (content/core.json); the table above is
  // kept for any saved name a pack no longer describes.
  const fromData = ACHIEVEMENTS.find((a) => a.name === name)?.icon;
  if (fromData && idByName(fromData) !== null) return idByName(fromData);
  const key = ACHIEVEMENT_ICONS[name];
  if (!key) return null;
  if (Array.isArray(key)) {
    const [kind, material] = key;
    return TOOL_KINDS.includes(kind) ? toolItemId(kind, material) : armorItemId(kind, material);
  }
  if (key === key.toUpperCase()) return ITEM_ID[key] ?? null;
  return BLOCKS.find((b) => b && b.name === key)?.id ?? null;
}

export class HUD {
  /** @param {import('../main.js').Game} game */
  constructor(game) {
    this.game = game;
    this.player = game.player;

    // --- Element refs ------------------------------------------------------
    this.hotbarEl = el('hotbar');
    this.statsEl = el('stats');
    this.itemNameEl = el('itemName');
    this.breakBarEl = el('breakBar');
    this.breakFillEl = el('breakFill');
    this.damageFlashEl = el('damageFlash');
    this.waterOverlayEl = el('waterOverlay');
    this.lavaOverlayEl = el('lavaOverlay');
    this.debugEl = el('debug');
    this.locatorEl = el('locator');
    this._locatorTimer = 0;
    this.compassEl = el('compass');
    this.compassFillEl = el('compassNeedle');
    this._compassTimer = 0;
    this.styleBox = el('styleBox');
    this.styleTricks = el('styleTricks');
    this.stylePoints = el('stylePoints');
    this.styleTotal = el('styleTotal');

    this.signScreen = el('signScreen');
    this.signInputs = [0, 1, 2, 3].map((i) => el(`signLine${i}`));
    this.activeSign = null;
    this.progressScreen = el('progressScreen');
    this.progressCount = el('progressCount');
    this.statList = el('statList');

    /** Result text kept on screen after a run ends. See `_updateStyle`. */
    this._styleHeld = null;
    /** Last board event sequence drawn, so each one is reacted to once. */
    this._styleSeen = 0;
    this.saveToastEl = el('saveToast');

    this.inventoryScreen = el('inventoryScreen');
    this.craftingScreen = el('craftingScreen');
    this.furnaceScreen = el('furnaceScreen');
    this.chestScreen = el('chestScreen');
    this.enchantScreen = el('enchantScreen');
    this.anvilScreen = el('anvilScreen');
    this.xpBar = el('xpBar');
    this.xpFill = el('xpFill');
    this.xpLevel = el('xpLevel');
    this.drawBarEl = el('drawBar');
    this.drawFillEl = el('drawFill');
    this.bossBarEl = el('bossBar');
    this.bossNameEl = el('bossName');
    this.bossFillEl = el('bossFill');
    this.portalOverlayEl = el('portalOverlay');
    this.paletteSection = el('paletteSection');
    this.paletteGrid = el('paletteGrid');
    this.modeBadge = el('modeBadge');
    this.cursorStackEl = el('cursorStack');

    // --- State -------------------------------------------------------------
    /** Stack currently "in hand" while rearranging. */
    this.cursorStack = null;
    this.showDebug = false;
    /** 2x2 inventory grid and 3x3 table grid. */
    this.invCraftGrid = new Array(4).fill(null);
    this.tableCraftGrid = new Array(9).fill(null);
    /** Furnace state object currently open, or null. */
    this.activeFurnace = null;
    /** Chest state object currently open, or null. */
    this.activeChest = null;

    this._lastInventoryVersion = -1;
    this._lastSelected = -1;
    this._itemNameTimer = 0;
    this._toastTimer = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._fps = 0;
    this._debugTimer = 0;

    /** Slot the pointer is over, for tooltips and hover shortcuts. */
    this.hovered = null;
    /** Drag in progress, {button, parts[]}, resolved on mouseup. */
    this._drag = null;
    this._lastClick = null;
    this.tooltipEl = el('tooltip');
    this.compassStrip = el('compassStrip') ? new CompassStrip(el('compassStrip')) : null;
    // One binding per inventory slot, shared by every screen that shows it.
    this._hotbarBindings = Array.from({ length: HOTBAR_SIZE }, (_, i) => this._invBinding(i));
    this._backpackBindings = Array.from({ length: STORAGE_SIZE }, (_, i) => this._invBinding(HOTBAR_SIZE + i));

    this._buildHotbar();
    this._buildStatRows();
    this._buildInventoryScreen();
    this._buildCraftingScreen();
    this._buildFurnaceScreen();
    this._buildChestScreen();
    this._buildEnchantScreen();
    this._buildAnvilScreen();
    this._bindEvents();
  }

  // -------------------------------------------------------------------------
  // Slot construction
  // -------------------------------------------------------------------------
  //
  // Every interactive slot is backed by a *binding* — where its stack lives and
  // what it will accept — rather than by a click handler. That one change is
  // what lets a single implementation do everything a player expects of an
  // inventory: click and split, shift-click across screens, drag a stack out
  // over several slots, double-click to gather, swap with a hotbar key, and
  // throw from under the cursor.
  //
  //   get()          -> stack | null
  //   set(stack)
  //   accept?(stack) -> whether this slot may receive it (armour, fuel, ...)
  //   role           'inv' | 'chest' | 'grid' | 'armor' | 'furnace' | 'output'
  //                  | 'result' | 'palette'
  //   index?         inventory index, for role 'inv'
  //   special?       (button, shift) => void. Results and the palette act at
  //                  once and never take part in a drag.

  /** @param binding null for a display-only slot (the in-game hotbar) */
  _makeSlot(binding = null, className = '') {
    const slot = document.createElement('div');
    slot.className = 'slot ' + className + (binding ? ' interactive' : '');
    const icon = document.createElement('div');
    icon.className = 'icon';
    const count = document.createElement('div');
    count.className = 'count';
    const durability = document.createElement('div');
    durability.className = 'durability';
    durability.innerHTML = '<i></i>';
    slot.append(icon, count, durability);

    const parts = { slot, icon, count, durability, bar: durability.firstChild, binding };
    if (binding) {
      // mousedown rather than click, so the right button registers at all.
      slot.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._onSlotDown(parts, e);
      });
      slot.addEventListener('mouseenter', () => this._onSlotEnter(parts));
      slot.addEventListener('mouseleave', () => this._onSlotLeave(parts));
      slot.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    return parts;
  }

  /**
   * Binding for one slot of the player's own inventory. Reads through
   * `this.player.inventory` on every call rather than capturing it, so the
   * bindings survive the inventory object being replaced.
   */
  _invBinding(index) {
    return {
      role: 'inv',
      index,
      get: () => this.player.inventory.slots[index],
      set: (s) => this.player.inventory.setSlot(index, s),
    };
  }

  /** Build a row of slots backed by an arbitrary array (the crafting grids). */
  _buildArrayGrid(container, array, size, onChange, className = '') {
    const views = [];
    for (let i = 0; i < size; i++) {
      const parts = this._makeSlot({
        role: 'grid',
        get: () => array[i],
        set: (s) => { array[i] = s; onChange?.(); },
      }, className);
      container.appendChild(parts.slot);
      views.push(parts);
    }
    return views;
  }

  /** The backpack and hotbar rows that every container screen repeats. */
  _buildPlayerRows(storageId, hotbarId) {
    const storage = [];
    for (let i = 0; i < STORAGE_SIZE; i++) {
      const parts = this._makeSlot(this._backpackBindings[i]);
      el(storageId).appendChild(parts.slot);
      storage.push(parts);
    }
    const hotbar = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const parts = this._makeSlot(this._hotbarBindings[i]);
      el(hotbarId).appendChild(parts.slot);
      hotbar.push(parts);
    }
    return { storage, hotbar };
  }

  /** A crafting result: shows what the grid makes, and crafts when clicked. */
  _resultBinding(grid, size) {
    return {
      role: 'result',
      get: () => findRecipe(grid, size),
      set: () => {},
      special: (button, shift) => {
        if (shift) this._craftAll(grid, size);
        else this._takeCraftResult(grid, size);
      },
    };
  }

  _buildHotbar() {
    this.hotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const parts = this._makeSlot();
      this.hotbarEl.appendChild(parts.slot);
      this.hotbarSlots.push(parts);
    }
  }

  _buildStatRows() {
    // Health, hunger, armour and air: pixel art with ghost hearts. See vitals.js.
    this.vitals = new Vitals(this.statsEl);
  }

  _buildInventoryScreen() {
    const rows = this._buildPlayerRows('storageGrid', 'invHotbarGrid');
    this.storageSlots = rows.storage;
    this.invHotbarSlots = rows.hotbar;

    // Armour slots reject anything that is not the matching piece.
    this.armorBindings = [];
    this.armorSlots = [];
    for (let i = 0; i < ARMOR_PIECES.length; i++) {
      const binding = {
        role: 'armor',
        get: () => this.player.inventory.armor[i],
        set: (s) => {
          if (s && !this.player.inventory.armor[i]) audio.equip();
          this.player.inventory.armor[i] = s;
          this.player.inventory.touch();
        },
        accept: (stack) => Inventory.armorSlotFor(stack.id) === i,
      };
      const parts = this._makeSlot(binding, `armorSlot armor-${ARMOR_PIECES[i]}`);
      // Shown in the tooltip while the slot is empty, so it says what goes there.
      parts.emptyHint = ARMOR_PIECES[i][0].toUpperCase() + ARMOR_PIECES[i].slice(1);
      el('armorGrid').appendChild(parts.slot);
      this.armorSlots.push(parts);
      this.armorBindings.push(binding);
    }

    // 2x2 crafting grid + its result.
    this.invCraftSlots = this._buildArrayGrid(el('invCraftGrid'), this.invCraftGrid, 4);
    this.invRecipes = new RecipeBook(this, {
      panel: el('invRecipes'), grid: this.invCraftGrid, size: 2, toggle: el('invRecipeToggle'),
    });
    this.invCraftResultSlot = this._makeSlot(this._resultBinding(this.invCraftGrid, 2), 'resultSlot');
    el('invCraftResult').appendChild(this.invCraftResultSlot.slot);

    // Creative palette: every block, then every item.
    this.paletteIds = [...obtainableBlocks(), ...obtainableItems()];
    this.paletteSlots = [];
    for (const id of this.paletteIds) {
      const parts = this._makeSlot({
        role: 'palette',
        get: () => ({ id, count: 1 }),
        set: () => {},
        special: (button, shift) => this._onPaletteClick(id, button, shift),
      });
      parts.icon.style.backgroundImage = `url(${getTileDataURL(getIconTile(id))})`;
      parts.searchText = getDisplayName(id).toLowerCase();
      this.paletteGrid.appendChild(parts.slot);
      this.paletteSlots.push(parts);
    }

    // Filter the palette as you type. The game ignores keys while a text field
    // has focus, so typing here cannot trigger hotkeys.
    const search = el('paletteSearch');
    if (search) {
      search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        for (const parts of this.paletteSlots) {
          parts.slot.style.display = !query || parts.searchText.includes(query) ? '' : 'none';
        }
      });
    }

    el('sortInvButton')?.addEventListener('click', () => {
      this._sortBindings(this._backpackBindings);
      this.refreshAll();
    });
  }

  _buildCraftingScreen() {
    this.tableCraftSlots = this._buildArrayGrid(el('tableCraftGrid'), this.tableCraftGrid, 9);
    this.tableRecipes = new RecipeBook(this, {
      panel: el('tableRecipes'), grid: this.tableCraftGrid, size: 3, toggle: el('tableRecipeToggle'),
    });
    this.tableResultSlot = this._makeSlot(this._resultBinding(this.tableCraftGrid, 3), 'resultSlot');
    el('tableCraftResult').appendChild(this.tableResultSlot.slot);

    const rows = this._buildPlayerRows('tableStorageGrid', 'tableHotbarGrid');
    this.tableStorageSlots = rows.storage;
    this.tableHotbarSlots = rows.hotbar;
  }

  _buildFurnaceScreen() {
    const field = (name, role, accept) => ({
      role,
      get: () => this.activeFurnace?.[name] ?? null,
      set: (s) => { if (this.activeFurnace) this.activeFurnace[name] = s; },
      accept,
    });

    // Only smeltable things go in the top slot, only fuels in the bottom, and
    // the output is take-only.
    this.furnaceInputBinding = field('input', 'furnace', (s) => !!smeltResultFor(s.id));
    this.furnaceFuelBinding = field('fuel', 'furnace', (s) => fuelValueFor(s.id) > 0);
    this.furnaceInputSlot = this._makeSlot(this.furnaceInputBinding);
    this.furnaceFuelSlot = this._makeSlot(this.furnaceFuelBinding);
    // Taking the output pays out the experience the furnace banked for it.
    const output = field('output', 'output', () => false);
    const putOutput = output.set;
    output.set = (next) => {
      const furnace = this.activeFurnace;
      const before = furnace?.output?.count ?? 0;
      const after = next && furnace?.output && next.id === furnace.output.id ? next.count : 0;
      if (furnace && before > after && furnace.xp > 0) {
        const share = (furnace.xp * (before - after)) / before;
        furnace.xp -= share;
        const points = roundXp(share);
        if (points > 0) {
          this.player.gainXp(points);
          audio.xpOrb();
        }
      }
      putOutput(next);
    };
    this.furnaceOutputSlot = this._makeSlot(output);

    el('furnaceInput').appendChild(this.furnaceInputSlot.slot);
    el('furnaceFuel').appendChild(this.furnaceFuelSlot.slot);
    el('furnaceOutput').appendChild(this.furnaceOutputSlot.slot);

    const rows = this._buildPlayerRows('furnaceStorageGrid', 'furnaceHotbarGrid');
    this.furnaceStorageSlots = rows.storage;
    this.furnaceHotbarSlots = rows.hotbar;
  }

  _buildChestScreen() {
    // The chest's own 27 slots live on the block entity, so they read through
    // whichever chest is currently open.
    this.chestBindings = [];
    this.chestSlots = [];
    for (let i = 0; i < 27; i++) {
      const binding = {
        role: 'chest',
        get: () => this.activeChest?.slots[i] ?? null,
        set: (s) => { if (this.activeChest) this.activeChest.slots[i] = s; },
      };
      const parts = this._makeSlot(binding);
      el('chestGrid').appendChild(parts.slot);
      this.chestSlots.push(parts);
      this.chestBindings.push(binding);
    }

    const rows = this._buildPlayerRows('chestStorageGrid', 'chestHotbarGrid');
    this.chestStorageSlots = rows.storage;
    this.chestHotbarSlots = rows.hotbar;

    el('sortChestButton')?.addEventListener('click', () => {
      if (!this.activeChest) return;
      this._sortBindings(this.chestBindings);
      this.refreshAll();
    });
  }

  // -------------------------------------------------------------------------
  // The enchanting table
  // -------------------------------------------------------------------------

  _buildEnchantScreen() {
    this.enchantState = { item: null, lapis: null, shelves: 0 };
    this.enchantOffers = [null, null, null];
    const field = (name, accept, emptyHint) => ({
      role: 'enchant',
      get: () => this.enchantState[name],
      set: (s) => { this.enchantState[name] = s; },
      accept,
      emptyHint,
    });
    this.enchantItemBinding = field('item', (s) => enchantability(s.id) > 0 && !isEnchanted(s));
    this.enchantLapisBinding = field('lapis', (s) => s.id === ITEM_ID.LAPIS);
    this.enchantItemSlot = this._makeSlot(this.enchantItemBinding);
    this.enchantItemSlot.emptyHint = 'Item';
    this.enchantLapisSlot = this._makeSlot(this.enchantLapisBinding);
    this.enchantLapisSlot.emptyHint = 'Lapis';
    el('enchantItem').appendChild(this.enchantItemSlot.slot);
    el('enchantLapis').appendChild(this.enchantLapisSlot.slot);

    this.enchantButtons = [...document.querySelectorAll('#enchantOffers .enchantOffer')];
    this.enchantButtons.forEach((button, i) => {
      button.addEventListener('click', () => this._enchant(i));
    });

    const rows = this._buildPlayerRows('enchantStorageGrid', 'enchantHotbarGrid');
    this.enchantStorageSlots = rows.storage;
    this.enchantHotbarSlots = rows.hotbar;
  }

  /** @param shelves bookshelves around the table, from enchanting.js */
  openEnchanting(shelves) {
    this.enchantState.shelves = shelves;
    this.refreshAll();
    this.enchantScreen.classList.add('show');
    audio.uiOpen();
  }

  closeEnchanting() {
    // The table keeps nothing: what you left in it comes back to you.
    this._returnCursor();
    for (const name of ['item', 'lapis']) {
      if (this.enchantState[name]) this._giveBack(this.enchantState[name]);
      this.enchantState[name] = null;
    }
    this.enchantScreen.classList.remove('show');
    audio.uiClose();
    this.refreshAll();
  }

  _paintEnchanting() {
    if (!this.enchantItemSlot) return;
    const { item, lapis, shelves } = this.enchantState;
    this._paintSlot(this.enchantItemSlot, item);
    this._paintSlot(this.enchantLapisSlot, lapis);
    this.enchantOffers = item ? tableOffers({ ...item, count: 1 }, shelves, this.player.enchantSeed) : [null, null, null];

    const creative = this.player.creative;
    const level = this.player.experience.level;
    const lapisCount = lapis?.count ?? 0;
    this.enchantButtons.forEach((button, i) => {
      const offer = this.enchantOffers[i];
      button.classList.toggle('empty', !offer);
      button.disabled = !offer;
      if (!offer) {
        button.querySelector('.glyphs').textContent = '';
        button.querySelector('.cost').textContent = '';
        button.querySelector('.lapisCost').textContent = '';
        button.title = '';
        return;
      }
      const affordable = creative || (level >= offer.cost && lapisCount >= offer.lapis);
      button.classList.toggle('unaffordable', !affordable);
      button.querySelector('.glyphs').textContent = glyphLine(this.player.enchantSeed + i * 131);
      button.querySelector('.cost').textContent = String(offer.cost);
      button.querySelector('.lapisCost').textContent = `${offer.lapis} lapis`;
      const def = ENCHANTMENTS[offer.hint.name];
      // Like Minecraft, the table only admits to one enchantment of the roll.
      const hint = `${def.label}${def.max > 1 ? ' ' + roman(offer.hint.level) : ''} . . . ?`;
      button.title = affordable
        ? hint
        : `${hint}\nNeeds level ${offer.cost} and ${offer.lapis} lapis`;
    });
    el('enchantShelves').textContent = shelves > 0
      ? `${shelves} ${shelves === 1 ? 'bookshelf' : 'bookshelves'} nearby`
      : 'No bookshelves nearby: surround the table to reach level 30';
  }

  _enchant(i) {
    const offer = this.enchantOffers[i];
    const state = this.enchantState;
    if (!offer || !state.item) return;
    const player = this.player;
    const creative = player.creative;
    if (!creative && (player.experience.level < offer.cost || (state.lapis?.count ?? 0) < offer.lapis)) {
      audio.uiError();
      return;
    }

    const result = applyEnchantments({ ...state.item, count: 1 }, offer.enchantments);
    if (state.item.count > 1) {
      // A stack of books: one is enchanted and comes to you, the rest stay.
      state.item.count--;
      this._giveBack(result);
    } else {
      state.item = result;
    }
    if (!creative) {
      state.lapis.count -= offer.lapis;
      if (state.lapis.count <= 0) state.lapis = null;
      player.experience.spendLevels(offer.levels);
    }
    // New offers next time, as in Minecraft.
    player.enchantSeed = (Math.random() * 0x7fffffff) | 0;
    audio.enchant();
    this.game.onEnchanted?.(result, offer);
    this.refreshAll();
  }

  // -------------------------------------------------------------------------
  // The anvil
  // -------------------------------------------------------------------------

  _buildAnvilScreen() {
    this.anvilState = { left: null, right: null };
    this.anvilResult = null;
    const field = (name) => ({
      role: 'anvil',
      get: () => this.anvilState[name],
      set: (s) => { this.anvilState[name] = s; },
    });
    this.anvilLeftBinding = field('left');
    this.anvilRightBinding = field('right');
    this.anvilLeftSlot = this._makeSlot(this.anvilLeftBinding);
    this.anvilRightSlot = this._makeSlot(this.anvilRightBinding);
    this.anvilOutputSlot = this._makeSlot({
      role: 'anvilOut',
      get: () => this.anvilResult?.result ?? null,
      set: () => {},
      special: (button, shift) => this._takeAnvil(shift),
    }, 'resultSlot');
    el('anvilLeft').appendChild(this.anvilLeftSlot.slot);
    el('anvilRight').appendChild(this.anvilRightSlot.slot);
    el('anvilOutput').appendChild(this.anvilOutputSlot.slot);

    const rows = this._buildPlayerRows('anvilStorageGrid', 'anvilHotbarGrid');
    this.anvilStorageSlots = rows.storage;
    this.anvilHotbarSlots = rows.hotbar;
  }

  openAnvil() {
    this.refreshAll();
    this.anvilScreen.classList.add('show');
    audio.uiOpen();
  }

  closeAnvil() {
    this._returnCursor();
    for (const name of ['left', 'right']) {
      if (this.anvilState[name]) this._giveBack(this.anvilState[name]);
      this.anvilState[name] = null;
    }
    this.anvilScreen.classList.remove('show');
    audio.uiClose();
    this.refreshAll();
  }

  _paintAnvil() {
    if (!this.anvilLeftSlot) return;
    const { left, right } = this.anvilState;
    this.anvilResult = anvilCombine(left, right, idByName);
    this._paintSlot(this.anvilLeftSlot, left);
    this._paintSlot(this.anvilRightSlot, right);
    this._paintSlot(this.anvilOutputSlot, this.anvilResult?.result ?? null);

    const label = el('anvilCost');
    const r = this.anvilResult;
    if (!r) {
      label.textContent = left && right ? 'These two do not combine' : 'Gear on the left; a book, a matching item or its material on the right';
      label.className = 'anvilCost';
      return;
    }
    const creative = this.player.creative;
    if (!creative && r.cost >= ANVIL_LIMIT) {
      label.textContent = 'Too expensive!';
      label.className = 'anvilCost bad';
    } else {
      label.textContent = `Cost: ${r.cost} level${r.cost === 1 ? '' : 's'}`;
      label.className = 'anvilCost' + (creative || this.player.experience.level >= r.cost ? '' : ' bad');
    }
  }

  _takeAnvil(shift) {
    const r = this.anvilResult;
    const player = this.player;
    if (!r) return;
    const creative = player.creative;
    if (!creative && (r.cost >= ANVIL_LIMIT || player.experience.level < r.cost)) {
      audio.uiError();
      return;
    }
    if (shift) {
      if (player.inventory.addExisting(r.result) > 0) return;
    } else {
      if (this.cursorStack) return;
      this.cursorStack = r.result;
    }
    const state = this.anvilState;
    state.left = null;
    if (state.right) {
      state.right.count -= r.uses;
      if (state.right.count <= 0 || state.right.durability !== undefined || state.right.ench) state.right = null;
    }
    if (!creative) player.experience.spendLevels(r.cost);
    audio.anvil();
    this.game.onAnvilUsed?.(r.result);
    player.inventory.touch();
  }

  _bindEvents() {
    document.addEventListener('mousemove', (e) => {
      this._mouseX = e.clientX;
      this._mouseY = e.clientY;
      if (this.cursorStack) {
        this.cursorStackEl.style.left = e.clientX + 'px';
        this.cursorStackEl.style.top = e.clientY + 'px';
      }
      if (this.tooltipEl.classList.contains('show')) this._placeTooltip();
    });

    // A drag resolves wherever the button comes up, even off the panel.
    document.addEventListener('mouseup', (e) => this._onSlotUp(e));

    // While hovering a slot: number keys swap with the hotbar, Drop throws.
    document.addEventListener('keydown', (e) => this._onContainerKey(e));

    // Right-clicking inside any container UI is a game action, never a menu.
    for (const screen of [this.inventoryScreen, this.craftingScreen, this.furnaceScreen, this.chestScreen]) {
      screen.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    this.player.survival.onDamage(() => {
      this.flashDamage();
      this._showHitArc();
    });
  }

  // -------------------------------------------------------------------------
  // Slot interaction
  // -------------------------------------------------------------------------

  _onSlotDown(parts, e) {
    const b = parts.binding;
    const button = e.button;
    if (button !== 0 && button !== 2) return;
    // A second button pressed mid-drag is ignored rather than half-applied.
    if (this._drag) return;

    if (b.special) {
      b.special(button, e.shiftKey);
      this.refreshAll();
      this._showTooltip(parts);
      return;
    }

    if (e.shiftKey && button === 0) {
      audio.uiSlot();
      this._quickMove(b);
      this.refreshAll();
      this._showTooltip(parts);
      return;
    }

    const now = performance.now();
    const last = this._lastClick;
    const doubleClick = button === 0 && last && last.parts === parts &&
      last.pickedUp && now - last.time < DOUBLE_CLICK_MS;
    this._lastClick = { parts, time: now, pickedUp: false };

    if (doubleClick && this.cursorStack) {
      this._gather();
      this._lastClick = null;
      this.refreshAll();
      return;
    }

    if (this.cursorStack) {
      // Holding something: resolve on release, so dragging across several
      // slots can spread the stack out instead of dropping it all in one.
      this._drag = { button, parts: [parts] };
      parts.slot.classList.add('dragTarget');
      this._hideTooltip();
      return;
    }

    // Empty hand: pick up now, which is what makes a following drag possible.
    this._slotAction(button, b.get, b.set, b.accept);
    if (this.cursorStack) audio.uiSlot();
    this._lastClick.pickedUp = !!this.cursorStack;
    this.refreshAll();
    this._hideTooltip();
  }

  _onSlotEnter(parts) {
    this.hovered = parts;
    if (this._drag) this._extendDrag(parts);
    this._showTooltip(parts);
  }

  _onSlotLeave(parts) {
    if (this.hovered === parts) this.hovered = null;
    this._hideTooltip();
  }

  _onSlotUp(e) {
    const drag = this._drag;
    if (!drag || e.button !== drag.button) return;
    this._drag = null;
    for (const p of drag.parts) p.slot.classList.remove('dragTarget');

    audio.uiSlot();
    if (drag.parts.length === 1) {
      const b = drag.parts[0].binding;
      this._slotAction(drag.button, b.get, b.set, b.accept);
    } else {
      this._distribute(drag.parts.map((p) => p.binding), drag.button);
    }
    this.refreshAll();
    if (this.hovered) this._showTooltip(this.hovered);
  }

  _extendDrag(parts) {
    const b = parts.binding;
    if (!b || b.special || this._drag.parts.includes(parts)) return;
    if (!this._canReceive(b, this.cursorStack)) return;
    this._drag.parts.push(parts);
    parts.slot.classList.add('dragTarget');
  }

  /** Whether a slot could take at least one of this stack. */
  _canReceive(b, stack) {
    if (!stack || (b.accept && !b.accept(stack))) return false;
    const slot = b.get();
    if (!slot) return true;
    return slot.id === stack.id && slot.durability === undefined &&
      stack.durability === undefined && slot.count < getMaxStack(slot.id);
  }

  /**
   * Spread the held stack over the slots a drag crossed. The left button
   * shares it out evenly; the right lays exactly one in each.
   */
  _distribute(bindings, button) {
    const held = this.cursorStack;
    const targets = bindings.filter((b) => this._canReceive(b, held));
    if (!held || targets.length === 0) return;

    const max = getMaxStack(held.id);
    const share = button === 2 ? 1 : Math.max(1, Math.floor(held.count / targets.length));
    for (const b of targets) {
      if (held.count <= 0) break;
      const slot = b.get();
      const n = Math.min(share, slot ? max - slot.count : max, held.count);
      if (n <= 0) continue;
      if (slot) {
        slot.count += n;
        b.set(slot);
      } else {
        b.set({ ...held, count: n });
      }
      held.count -= n;
    }
    this.cursorStack = held.count > 0 ? held : null;
  }

  /** Which container screen is showing, for deciding where shift-click goes. */
  _openScreen() {
    if (this.enchantScreen.classList.contains('show')) return 'enchant';
    if (this.anvilScreen.classList.contains('show')) return 'anvil';
    if (this.chestScreen.classList.contains('show')) return 'chest';
    if (this.furnaceScreen.classList.contains('show')) return 'furnace';
    if (this.craftingScreen.classList.contains('show')) return 'table';
    if (this.inventoryScreen.classList.contains('show')) return 'inventory';
    return null;
  }

  /** Shift-click: send a whole stack to wherever it obviously belongs. */
  _quickMove(b) {
    const stack = b.get();
    if (!stack) return;
    b.set(this._moveInto(stack, this._quickTargets(b, stack)));
  }

  _quickTargets(b, stack) {
    const screen = this._openScreen();
    if (b.role !== 'inv') return [...this._backpackBindings, ...this._hotbarBindings];

    if (screen === 'chest' && this.activeChest) return this.chestBindings;
    if (screen === 'enchant') {
      if (stack.id === ITEM_ID.LAPIS) return [this.enchantLapisBinding];
      if (enchantability(stack.id) > 0 && !isEnchanted(stack)) return [this.enchantItemBinding];
    }
    if (screen === 'anvil') return [this.anvilLeftBinding, this.anvilRightBinding];
    if (screen === 'furnace' && this.activeFurnace) {
      if (smeltResultFor(stack.id)) return [this.furnaceInputBinding];
      if (fuelValueFor(stack.id) > 0) return [this.furnaceFuelBinding];
    }
    if (screen === 'inventory') {
      const piece = Inventory.armorSlotFor(stack.id);
      if (piece >= 0 && !this.player.inventory.armor[piece]) return [this.armorBindings[piece]];
    }
    // Otherwise hop between the hotbar and the backpack.
    return b.index < HOTBAR_SIZE ? this._backpackBindings : this._hotbarBindings;
  }

  /**
   * Put as much of a stack as fits into a list of slots: topping up matching
   * stacks first, then filling empty ones.
   * @returns what is left of the stack, or null if it all moved
   */
  _moveInto(stack, targets) {
    const max = getMaxStack(stack.id);
    const gear = stack.durability !== undefined;
    let count = stack.count;

    if (!gear) {
      for (const t of targets) {
        if (count <= 0) break;
        const slot = t.get();
        if (!slot || slot.id !== stack.id || slot.durability !== undefined || slot.count >= max) continue;
        if (t.accept && !t.accept(stack)) continue;
        const n = Math.min(max - slot.count, count);
        slot.count += n;
        t.set(slot);
        count -= n;
      }
    }
    for (const t of targets) {
      if (count <= 0) break;
      if (t.get() || (t.accept && !t.accept(stack))) continue;
      const n = Math.min(max, count);
      // Gear moves as the same object, so its wear goes with it.
      t.set(gear ? stack : { ...stack, count: n });
      count -= n;
    }

    if (count <= 0) return null;
    stack.count = count;
    return stack;
  }

  /** Double-click: pull every matching item on screen onto the held stack. */
  _gather() {
    const held = this.cursorStack;
    if (!held || held.durability !== undefined) return;
    const max = getMaxStack(held.id);
    const chest = this._openScreen() === 'chest' ? this.chestBindings : [];
    const sources = [...chest, ...this._backpackBindings, ...this._hotbarBindings];

    // Partial stacks first, so whole stacks elsewhere stay whole if they can.
    for (const takeWhole of [false, true]) {
      for (const b of sources) {
        if (held.count >= max) return;
        const slot = b.get();
        if (!slot || slot.id !== held.id || slot.durability !== undefined) continue;
        if (!takeWhole && slot.count >= max) continue;
        const n = Math.min(max - held.count, slot.count);
        held.count += n;
        slot.count -= n;
        b.set(slot.count > 0 ? slot : null);
      }
    }
  }

  /** Hovering a slot and pressing 1-9 swaps it with that hotbar slot. */
  _swapWithHotbar(b, index) {
    const hot = this._hotbarBindings[index];
    if (b.role === 'inv' && b.index === index) return;
    const here = b.get();
    const there = hot.get();
    if (there && b.accept && !b.accept(there)) return;
    b.set(there ?? null);
    hot.set(here ?? null);
  }

  _onContainerKey(e) {
    if (!this.hovered || !this.anyContainerOpen || e.repeat) return;
    if (e.target instanceof HTMLInputElement) return;
    const b = this.hovered.binding;
    if (!b || b.special || this.cursorStack) return;

    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      e.preventDefault();
      this._swapWithHotbar(b, Number(digit[1]) - 1);
    } else if (e.code === keybinds.get('drop')) {
      const stack = b.get();
      if (!stack || !this.game.entities) return;
      // As in the world: Ctrl throws the whole stack.
      const n = e.ctrlKey ? stack.count : 1;
      this.player.throwItem(stack.id, n, this.game.entities, stack.durability, stack);
      stack.count -= n;
      b.set(stack.count > 0 ? stack : null);
    } else {
      return;
    }
    this.refreshAll();
    this._showTooltip(this.hovered);
  }

  /** Merge and order a run of slots: blocks, then items, then gear. */
  _sortBindings(bindings) {
    const stacks = [];
    for (const b of bindings) {
      const s = b.get();
      if (s) stacks.push(s);
      b.set(null);
    }

    const merged = [];
    for (const s of stacks) {
      const max = getMaxStack(s.id);
      if (s.durability !== undefined || max <= 1) {
        merged.push(s);
        continue;
      }
      let count = s.count;
      for (const m of merged) {
        if (count <= 0) break;
        if (m.id !== s.id || m.durability !== undefined || m.count >= max) continue;
        const n = Math.min(max - m.count, count);
        m.count += n;
        count -= n;
      }
      if (count > 0) merged.push({ ...s, count });
    }

    const rank = (s) => (s.durability !== undefined ? 2 : isBlockId(s.id) ? 0 : 1);
    merged.sort((a, c) => rank(a) - rank(c) || a.id - c.id || c.count - a.count);
    merged.forEach((s, i) => bindings[i].set(s));
  }

  /**
   * Minecraft-style slot interaction against any storage location.
   *
   *   LEFT  empty hand -> take the whole stack
   *         holding    -> drop it all, merging into a match, else swapping
   *   RIGHT empty hand -> take half (rounded up)
   *         holding    -> deposit exactly one; swap if the types differ
   *
   * @param accept optional predicate gating what may be placed here
   *   (armour slots, furnace fuel, etc.)
   */
  _slotAction(button, get, set, accept) {
    if (button !== 0 && button !== 2) return;

    const slot = get();
    const held = this.cursorStack;
    const allowed = (stack) => !accept || accept(stack);

    if (button === 2) {
      // ---- Right click ----------------------------------------------------
      if (!held) {
        if (!slot) return;
        const take = Math.ceil(slot.count / 2);
        this.cursorStack = { ...slot, count: take };
        slot.count -= take;
        set(slot.count <= 0 ? null : slot);
        return;
      }
      if (!allowed(held)) return;

      if (!slot) {
        set({ ...held, count: 1 });
        this._consumeOneHeld();
      } else if (slot.id === held.id && slot.durability === undefined) {
        if (slot.count >= getMaxStack(slot.id)) return;
        slot.count++;
        set(slot);
        this._consumeOneHeld();
      } else {
        this.cursorStack = slot;
        set(held);
      }
      return;
    }

    // ---- Left click -------------------------------------------------------
    if (held) {
      if (!allowed(held)) {
        // A take-only slot (the furnace output) still tops up a matching stack
        // in hand, so collecting a batch of ingots is one click, not two.
        if (slot && slot.id === held.id && held.durability === undefined) {
          const moved = Math.min(getMaxStack(held.id) - held.count, slot.count);
          held.count += moved;
          slot.count -= moved;
          set(slot.count > 0 ? slot : null);
        }
        return;
      }
      if (!slot) {
        set(held);
        this.cursorStack = null;
      } else if (slot.id === held.id && slot.durability === undefined) {
        const moved = Math.min(getMaxStack(slot.id) - slot.count, held.count);
        slot.count += moved;
        held.count -= moved;
        set(slot);
        this.cursorStack = held.count > 0 ? held : null;
      } else {
        set(held);
        this.cursorStack = slot;
      }
    } else if (slot) {
      this.cursorStack = slot;
      set(null);
    }
  }

  _consumeOneHeld() {
    if (!this.cursorStack) return;
    this.cursorStack.count--;
    if (this.cursorStack.count <= 0) this.cursorStack = null;
  }

  _onPaletteClick(id, button, shift = false) {
    if (button !== 0 && button !== 2) return;
    const wanted = button === 2 ? 1 : getMaxStack(id);

    // Shift sends it straight to the inventory, skipping the cursor.
    if (shift) {
      this.player.inventory.add(id, wanted);
      return;
    }

    if (this.cursorStack && this.cursorStack.id === id) {
      this.cursorStack.count = Math.min(getMaxStack(id), this.cursorStack.count + wanted);
    } else {
      if (this.cursorStack) this._giveBack(this.cursorStack);
      this.cursorStack = Inventory.makeStack(id, wanted);
    }
  }

  // -------------------------------------------------------------------------
  // Tooltips
  // -------------------------------------------------------------------------

  _showTooltip(parts) {
    const b = parts.binding;
    if (!b || this.cursorStack || this._drag) {
      this._hideTooltip();
      return;
    }

    const stack = b.get();
    let info;
    if (stack) {
      info = describeStack(stack);
      if (b.role === 'result') info.lines.push('Shift-click to craft as many as you can');
      if (b.role === 'palette') info.lines.push('Shift-click to put a stack in your inventory');
      if (parts.hint) info.lines.push(parts.hint);
    } else if (parts.emptyHint) {
      info = { name: `${parts.emptyHint} slot`, color: '#9aa4b8', lines: [] };
    } else {
      this._hideTooltip();
      return;
    }

    const t = this.tooltipEl;
    t.textContent = '';
    const name = document.createElement('div');
    name.className = 'ttName';
    name.textContent = info.name;
    if (info.color) name.style.color = info.color;
    t.appendChild(name);
    for (const line of info.ench ?? []) {
      const row = document.createElement('div');
      row.className = 'ttLine ttEnch';
      row.textContent = line;
      t.appendChild(row);
    }
    for (const line of info.lines) {
      const row = document.createElement('div');
      row.className = 'ttLine';
      row.textContent = line;
      t.appendChild(row);
    }
    t.classList.add('show');
    this._placeTooltip();
  }

  _hideTooltip() {
    this.tooltipEl.classList.remove('show');
  }

  /** Beside the cursor, flipped to the other side at the screen edge. */
  _placeTooltip() {
    const t = this.tooltipEl;
    const x = this._mouseX ?? 0;
    const y = this._mouseY ?? 0;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const left = x + 16 + w > window.innerWidth ? x - 12 - w : x + 16;
    const top = Math.min(window.innerHeight - h - 4, Math.max(4, y - 10));
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  // -------------------------------------------------------------------------
  // Crafting
  // -------------------------------------------------------------------------

  /** Clicking the result slot crafts one batch into the cursor. */
  _takeCraftResult(grid, size) {
    const recipe = findRecipe(grid, size);
    if (!recipe) return;

    if (this.cursorStack) {
      // Only stack onto a matching, non-gear item in hand.
      if (this.cursorStack.id !== recipe.id || this.cursorStack.durability !== undefined) return;
      if (this.cursorStack.count + recipe.count > getMaxStack(recipe.id)) return;
      this.cursorStack.count += recipe.count;
    } else {
      this.cursorStack = Inventory.makeStack(recipe.id, recipe.count);
    }

    consumeGrid(grid);
    // The game owns the achievement list; the HUD only reports what happened.
    if (this.game._notePlayerMilestone) {
      this.game._notePlayerMilestone('crafted', recipe.id, null);
    }
  }

  /**
   * Shift-click on a result: craft batch after batch straight into the
   * inventory until the grid runs out or there is no room left.
   */
  _craftAll(grid, size) {
    const inv = this.player.inventory;
    for (let guard = 0; guard < 64; guard++) {
      const recipe = findRecipe(grid, size);
      if (!recipe || inv.roomFor(recipe.id) < recipe.count) break;
      inv.add(recipe.id, recipe.count);
      consumeGrid(grid);
      if (this.game._notePlayerMilestone) {
        this.game._notePlayerMilestone('crafted', recipe.id, null);
      }
    }
  }

  /**
   * Return a stack to the inventory, throwing whatever does not fit.
   *
   * `addExisting` rather than `add`: plain `add` mints a fresh stack, which
   * silently repaired any tool that passed through a crafting grid or the
   * cursor. It also reports what did not fit rather than keeping it, and that
   * overflow used to simply vanish.
   */
  _giveBack(stack) {
    if (!stack) return;
    const left = this.player.inventory.addExisting(stack);
    if (left > 0 && this.game.entities) {
      this.player.throwItem(stack.id, left, this.game.entities, stack.durability, stack);
    }
  }

  /** Return a crafting grid's contents to the inventory (on close). */
  _emptyGrid(grid) {
    for (let i = 0; i < grid.length; i++) {
      this._giveBack(grid[i]);
      grid[i] = null;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /** Level and progress over the hotbar; hidden in creative, where it means nothing. */
  _updateXpBar() {
    const xp = this.player.experience;
    const hidden = this.player.creative;
    this.xpBar.classList.toggle('hidden', hidden);
    if (hidden) return;
    const width = (xp.progress * 100).toFixed(1) + '%';
    if (this._xpWidth !== width) {
      this._xpWidth = width;
      this.xpFill.style.width = width;
    }
    const text = xp.level > 0 ? String(xp.level) : '';
    if (this._xpText !== text) {
      this._xpText = text;
      this.xpLevel.textContent = text;
    }
  }

  update(dt) {
    this._updateXpBar();
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    const inventory = this.player.inventory;
    if (inventory.version !== this._lastInventoryVersion) {
      this._lastInventoryVersion = inventory.version;
      this.refreshAll();
    }

    if (inventory.selected !== this._lastSelected) {
      this._lastSelected = inventory.selected;
      this._showItemName();
    }

    if (this._itemNameTimer > 0) {
      this._itemNameTimer -= dt;
      if (this._itemNameTimer <= 0) this.itemNameEl.classList.remove('show');
    }
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.saveToastEl.classList.remove('show');
    }

    this._updateLocator(dt);
    this._updateCompass(dt);
    this._updateStyle(dt);
    this._updateStats(dt);
    if (this.compassStrip && this.game.world) {
      const heading = ((-this.player.yaw * 180) / Math.PI + 360) % 360;
      this.compassStrip.update(heading, this.player.position, this.game.compassMarkers(), this.game.state === 'playing');
    }
    // Mining progress is drawn as cracks on the block itself now (see the
    // renderer); the old bar stays hidden.
    this._updateBossBar();
    this._updateOverlays();

    // The furnace runs on its own; keep its panel live while open.
    if (this.activeFurnace && this.furnaceScreen.classList.contains('show')) {
      this._paintFurnace();
    }

    if (this.showDebug) {
      this._debugTimer -= dt;
      if (this._debugTimer <= 0) {
        this._debugTimer = 0.2;
        this._updateDebug();
      }
    }
  }

  /**
   * Position, facing and biome.
   *
   * The world is infinite and there is no map, so without this "walk back to
   * where I built the portal" is pure guesswork. Refreshed on a timer because
   * it writes to the DOM and nothing here changes meaningfully per frame.
   */
  _updateLocator(dt) {
    this.locatorEl.classList.toggle('show', Settings.showLocator === true);
    if (!Settings.showLocator) return;

    this._locatorTimer -= dt;
    if (this._locatorTimer > 0) return;
    this._locatorTimer = 0.2;

    const p = this.player;
    const x = Math.floor(p.position.x);
    const y = Math.floor(p.position.y);
    const z = Math.floor(p.position.z);

    // Yaw 0 faces -Z. Sixteenths of a turn would be over-precise for a compass
    // you glance at, so this is the eight-point rose.
    const turns = ((-p.yaw / (Math.PI * 2)) % 1 + 1) % 1;
    const facing = COMPASS[Math.round(turns * 8) % 8];

    let biome = '';
    const terrain = this.game.terrainInfo;
    if (terrain && this.game.world?.dimension === 'overworld') {
      const surface = this.game.world.getSurfaceY(x, z);
      if (surface >= 0) biome = BIOME_NAMES[terrain.biomeAt(x, z, surface)] ?? '';
    } else if (this.game.world) {
      biome = dimensionInfo(this.game.world.dimension).name;
    }

    this.locatorEl.textContent =
      `${x}, ${y}, ${z}   ${facing}` + (biome ? `\n${biome}` : '');
  }

  /**
   * Bearing and distance to the nearest Comb shrine, while holding the compass.
   *
   * Shown as a turn instruction rather than a raw heading — "bear left 40" is
   * something you can act on without doing trigonometry, which is the whole
   * point of the item.
   */
  _updateCompass(dt) {
    const held = this.player.inventory.getSelected();
    const item = held ? getThing(held.id) : null;
    const active = !!(item && item.locatesShrines);

    this.compassEl.classList.toggle('show', active);
    if (!active) return;

    this._compassTimer -= dt;
    if (this._compassTimer > 0) return;
    this._compassTimer = 0.15;

    const label = this.compassEl.firstChild;
    const target = this.game.nearestShrine();
    if (!target) {
      // Writing to the element itself would delete the needle along with the text.
      label.textContent = 'The needle is still.';
      this.compassFillEl.style.transform = 'rotate(0deg)';
      return;
    }

    const dx = target.wx - this.player.position.x;
    const dz = target.wz - this.player.position.z;
    const distance = Math.hypot(dx, dz);

    // Yaw 0 faces -Z. Positive `relative` means the shrine is to the right.
    const bearing = Math.atan2(dx, -dz);
    let relative = bearing - (-this.player.yaw);
    relative = Math.atan2(Math.sin(relative), Math.cos(relative));
    const degrees = Math.round(relative * 180 / Math.PI);

    const turn = Math.abs(degrees) < 8
      ? 'dead ahead'
      : degrees > 0 ? `bear right ${degrees}°` : `bear left ${-degrees}°`;

    label.textContent = `Shrine  ${Math.round(distance)}m\n${turn}`;
    // The needle points at the shrine relative to where you are facing.
    this.compassFillEl.style.transform = `rotate(${degrees}deg)`;
  }

  /**
   * The trick combo readout.
   *
   * Shown while riding and for a couple of seconds after a landing or a bail,
   * so the number you just earned is still on screen when you look at it.
   */
  _updateStyle(dt) {
    const board = this.player.board;
    if (!board) return;

    const visible = board.riding || board.displayTimer > 0;
    this.styleBox.classList.toggle('show', visible);
    if (!visible) {
      this._styleHeld = null;
      // Stay caught up while hidden, so a stale event cannot fire on reappear.
      this._styleSeen = board.eventSeq;
      return;
    }

    // React to anything that happened since the last draw. Bails and banks both
    // end the run, so their text is held on screen for the rest of the display
    // window — otherwise the number you just scored would flash by in one frame.
    const fresh = board.eventSeq !== this._styleSeen;
    const event = fresh ? board.lastEvent : null;
    this._styleSeen = board.eventSeq;
    if (event) {
      this.styleBox.classList.remove('pop', 'bail');
      // Reflow so the animation restarts even on back-to-back landings.
      void this.styleBox.offsetWidth;

      if (event.type === 'bail') {
        this.styleBox.classList.add('bail');
        this._styleHeld = { tricks: 'BAILED', points: event.lost > 0 ? `-${event.lost}` : '' };
        audio.skateBail();
      } else {
        this.styleBox.classList.add('pop');
        if (event.type === 'land') audio.skateLand(event.combo);
        if (event.type === 'bank') {
          this._styleHeld = { tricks: 'RUN BANKED', points: `+${event.gained}` };
        }
      }
    }

    const combo = board.describeCombo();
    if (combo) {
      // A live chain always wins: landing a new trick replaces the old result.
      this._styleHeld = null;
      this.styleTricks.textContent = combo.names;
      this.stylePoints.innerHTML =
        `${combo.total}<span class="mult"> x${combo.multiplier}</span>`;
    } else if (this._styleHeld) {
      this.styleTricks.textContent = this._styleHeld.tricks;
      this.stylePoints.textContent = this._styleHeld.points;
    } else {
      // Between runs: just the lifetime total.
      this.styleTricks.textContent = '';
      this.stylePoints.textContent = '';
    }

    this.styleTotal.textContent = `STYLE ${board.totalStyle}`;
  }

  _updateStats(dt) {
    this.statsEl.classList.toggle('hidden', this.player.creative);
    this.vitals.update(dt, this.player);
  }

  _updateBreakBar() {
    const progress = this.player.breakProgress;
    const active = progress > 0.001 && progress < 1;
    this.breakBarEl.classList.toggle('active', active);
    if (active) this.breakFillEl.style.width = (progress * 100).toFixed(1) + '%';

    // Bow draw, shown just below.
    const draw = this.player.drawProgress;
    const drawing = draw > 0.001;
    this.drawBarEl.classList.toggle('active', drawing);
    if (drawing) {
      this.drawFillEl.style.width = (draw * 100).toFixed(1) + '%';
      // Turns green at full power so you know when to release.
      this.drawFillEl.style.background = draw >= 0.999 ? '#7fd44a' : '#d8c070';
    }
  }

  /**
   * Boss health, shown only while one is actually nearby.
   *
   * Picks the closest living boss rather than the first, so the bar always
   * describes the fight you are in.
   */
  _updateBossBar() {
    const BOSS_BAR_RANGE = 48;
    let nearest = null;
    let nearestDist = BOSS_BAR_RANGE;

    for (const mob of this.game.entities.mobs) {
      if (!mob.type.boss || mob.dead) continue;
      const d = mob.horizontalDistanceTo(this.player.position);
      if (d >= nearestDist) continue;
      nearest = mob;
      nearestDist = d;
    }

    this.bossBarEl.classList.toggle('active', !!nearest);
    if (!nearest) return;

    this.bossNameEl.textContent = nearest.type.displayName ?? nearest.type.name;
    const fraction = Math.max(0, nearest.health / nearest.type.maxHealth);
    this.bossFillEl.style.width = (fraction * 100).toFixed(1) + '%';
  }

  _updateOverlays() {
    this.waterOverlayEl.classList.toggle('active', this.game.cameraInWater);
    this.lavaOverlayEl.classList.toggle('active', this.game.cameraInLava);
    // Portal transit whites out the screen as the charge builds.
    this.portalOverlayEl.style.opacity = (this.player.portalCharge * 0.85).toFixed(3);
  }

  _updateDebug() {
    const p = this.player;
    const world = this.game.world;
    const pos = p.position;
    const biomeId = this.game.terrainInfo.biomeAt(Math.floor(pos.x), Math.floor(pos.z));
    const held = p.inventory.getSelected();
    const tool = held ? getTool(held.id) : null;

    this.debugEl.textContent = [
      `${this._fps} fps`,
      `XYZ  ${pos.x.toFixed(2)} / ${pos.y.toFixed(2)} / ${pos.z.toFixed(2)}`,
      `Chunk ${Math.floor(pos.x / 16)}, ${Math.floor(pos.z / 16)}   Facing ${this._facingName(p.yaw)}`,
      `Biome ${BIOME_NAMES[biomeId]}`,
      `Time  ${this.game.sky.clockText}  (${this.game.sky.isNight ? 'night' : 'day'})`,
      '',
      `World  ${this.game.worldName ?? '-'}  seed ${world.seed}`,
      `Format v${this.game.saveFormatVersion}  terrain v${world.terrainVersion}`,
      '',
      `Chunks  ${world.stats.loaded} loaded, ${world.stats.pending} pending`,
      `Draws   ${this.game.renderer.drawCalls}`,
      `Tris    ${this.game.renderer.triangles.toLocaleString()}`,
      `Mobs    ${this.game.entities.mobs.length}   Items ${this.game.entities.items.length}`,
      `Fluid   ${world.fluids.stats.pending} queued`,
      '',
      `Mode    ${p.creative ? 'Creative' : 'Survival'}${p.flying ? ' (flying)' : ''}` +
        `${this.game.allowCreative ? '' : '  [survival world]'}`,
      `Held    ${held ? getDisplayName(held.id) : 'nothing'}${tool ? ` (tier ${tool.tier}, ${held.durability}/${tool.durability})` : ''}`,
      p.targetBlock
        ? `Target  ${getDisplayName(p.targetBlock.block)} @ ${p.targetBlock.x},${p.targetBlock.y},${p.targetBlock.z}`
        : 'Target  none',
    ].join('\n');
  }

  _facingName(yaw) {
    const deg = ((-yaw * 180) / Math.PI + 360) % 360;
    const names = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];
    return names[Math.round(deg / 45) % 8];
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  /** Repaint every visible container. */
  refreshAll() {
    const inv = this.player.inventory;
    const slots = inv.slots;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this._paintSlot(this.hotbarSlots[i], slots[i]);
      this._paintSlot(this.invHotbarSlots[i], slots[i]);
      this._paintSlot(this.tableHotbarSlots[i], slots[i]);
      this._paintSlot(this.furnaceHotbarSlots[i], slots[i]);
      this._paintSlot(this.chestHotbarSlots[i], slots[i]);
      this._paintSlot(this.enchantHotbarSlots[i], slots[i]);
      this._paintSlot(this.anvilHotbarSlots[i], slots[i]);
      this.hotbarSlots[i].slot.classList.toggle('selected', i === inv.selected);
    }

    for (let i = 0; i < STORAGE_SIZE; i++) {
      const stack = slots[HOTBAR_SIZE + i];
      this._paintSlot(this.storageSlots[i], stack);
      this._paintSlot(this.tableStorageSlots[i], stack);
      this._paintSlot(this.furnaceStorageSlots[i], stack);
      this._paintSlot(this.chestStorageSlots[i], stack);
      this._paintSlot(this.enchantStorageSlots[i], stack);
      this._paintSlot(this.anvilStorageSlots[i], stack);
    }

    for (let i = 0; i < 27; i++) {
      this._paintSlot(this.chestSlots[i], this.activeChest ? this.activeChest.slots[i] : null);
    }

    for (let i = 0; i < this.armorSlots.length; i++) {
      this._paintSlot(this.armorSlots[i], inv.armor[i]);
    }

    for (let i = 0; i < 4; i++) this._paintSlot(this.invCraftSlots[i], this.invCraftGrid[i]);
    for (let i = 0; i < 9; i++) this._paintSlot(this.tableCraftSlots[i], this.tableCraftGrid[i]);

    this._paintSlot(this.invCraftResultSlot, findRecipe(this.invCraftGrid, 2));
    this._paintSlot(this.tableResultSlot, findRecipe(this.tableCraftGrid, 3));

    if (this.activeFurnace) this._paintFurnace();
    this._paintEnchanting();
    this._paintAnvil();
    this._paintCursorStack();
    // What you can craft changes with every move, so the books follow.
    this.invRecipes?.refresh();
    this.tableRecipes?.refresh();
  }

  /** Backwards-compatible alias — some call sites still use this name. */
  refreshInventory() {
    this.refreshAll();
  }

  _paintSlot(parts, stack) {
    parts.slot.classList.toggle('enchanted', isEnchanted(stack));
    if (!stack) {
      parts.icon.style.backgroundImage = '';
      parts.count.textContent = '';
      parts.durability.classList.remove('show');
      return;
    }

    const url = `url(${getTileDataURL(getIconTile(stack.id))})`;
    parts.icon.style.backgroundImage = url;
    // The glint is masked to the icon's own shape (see .slot.enchanted in CSS).
    if (isEnchanted(stack)) parts.icon.style.setProperty('--icon', url);
    parts.count.textContent = stack.count > 1 ? stack.count : '';

    // Wear bar, green fading to red as the tool nears breaking.
    const max = getDurability(stack.id);
    if (max > 0 && stack.durability !== undefined && stack.durability < max) {
      const ratio = Math.max(0, stack.durability / max);
      parts.durability.classList.add('show');
      parts.bar.style.width = (ratio * 100).toFixed(1) + '%';
      parts.bar.style.background = `hsl(${Math.round(ratio * 110)}, 85%, 45%)`;
    } else {
      parts.durability.classList.remove('show');
    }
  }

  _paintFurnace() {
    const f = this.activeFurnace;
    this._paintSlot(this.furnaceInputSlot, f.input);
    this._paintSlot(this.furnaceFuelSlot, f.fuel);
    this._paintSlot(this.furnaceOutputSlot, f.output);

    const flame = f.burnMax > 0 ? Math.max(0, f.burnRemaining / f.burnMax) : 0;
    el('furnaceFlame').style.height = (flame * 100).toFixed(1) + '%';
    el('furnaceCook').style.width = ((f.cookProgress / SMELT_SECONDS) * 100).toFixed(1) + '%';
  }

  _paintCursorStack() {
    const show = !!this.cursorStack;
    this.cursorStackEl.classList.toggle('show', show);
    if (!show) return;
    this.cursorStackEl.querySelector('.icon').style.backgroundImage =
      `url(${getTileDataURL(getIconTile(this.cursorStack.id))})`;
    this.cursorStackEl.querySelector('.count').textContent =
      this.cursorStack.count > 1 ? this.cursorStack.count : '';
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  openInventory() {
    this.paletteSection.style.display = this.player.creative ? '' : 'none';
    // A survival world says so plainly, since the mode key will not work there.
    const locked = this.game.allowCreative === false;
    this.modeBadge.textContent = this.player.creative ? 'Creative'
      : locked ? 'Survival (locked)' : 'Survival';
    this.modeBadge.classList.toggle('warn', locked);
    this.refreshAll();
    this.inventoryScreen.classList.add('show');
    this.invRecipes.refresh();
    audio.uiOpen();
  }

  closeInventory() {
    this._emptyGrid(this.invCraftGrid);
    this._returnCursor();
    this.inventoryScreen.classList.remove('show');
    audio.uiClose();
    this.refreshAll();
  }

  openCraftingTable() {
    this.refreshAll();
    this.craftingScreen.classList.add('show');
    this.tableRecipes.refresh();
    audio.uiOpen();
  }

  closeCraftingTable() {
    this._emptyGrid(this.tableCraftGrid);
    this._returnCursor();
    this.craftingScreen.classList.remove('show');
    audio.uiClose();
    this.refreshAll();
  }

  /** @param state furnace state object owned by the world's block entity */
  openFurnace(state) {
    this.activeFurnace = state;
    this.refreshAll();
    this.furnaceScreen.classList.add('show');
  }

  closeFurnace() {
    this._returnCursor();
    this.furnaceScreen.classList.remove('show');
    // Contents stay in the furnace — it keeps smelting without us.
    this.activeFurnace = null;
    this.refreshAll();
  }

  /** @param state chest state object owned by the world's block entity */
  openChest(state) {
    this.activeChest = state;
    this.refreshAll();
    this.chestScreen.classList.add('show');
  }

  closeChest() {
    this._returnCursor();
    this.chestScreen.classList.remove('show');
    // Contents stay in the chest.
    this.activeChest = null;
    this.refreshAll();
  }

  // -------------------------------------------------------------------------
  // Signs
  // -------------------------------------------------------------------------

  /**
   * The sign editor.
   *
   * Four plain text inputs writing straight into the block entity's state, so
   * there is no apply step and nothing to lose — closing the screen is the
   * whole commit. Lines are capped at 15 characters because that is what fits
   * on a sign in the world at a readable size.
   */
  openSign(state) {
    this.activeSign = state;
    for (let i = 0; i < this.signInputs.length; i++) {
      this.signInputs[i].value = state.lines[i] ?? '';
    }
    this.signScreen.classList.add('show');
    // Focus the first line, so you can just start typing.
    this.signInputs[0].focus();
    this.signInputs[0].select();
  }

  closeSign() {
    if (this.activeSign) {
      for (let i = 0; i < this.signInputs.length; i++) {
        this.activeSign.lines[i] = this.signInputs[i].value.slice(0, SIGN_LINE_LENGTH);
      }
    }
    this.activeSign = null;
    this.signScreen.classList.remove('show');
  }

  // -------------------------------------------------------------------------
  // Achievements and statistics
  // -------------------------------------------------------------------------

  /**
   * The advancement tree (Phase 3; Jev's pick). One tab per branch of the
   * game plus statistics; each tree is laid out once from its parent links,
   * so nodes never jump about as you earn them, and only what `visible`
   * allows is drawn — the rest waits until its parent is earned.
   */
  openProgress() {
    const { achievements } = this.game;
    const { earned, total } = achievements.progress;
    this.progressCount.textContent = `${earned} / ${total}`;
    this._advTab ??= ADVANCEMENT_TABS[0]?.id ?? 'stats';
    // Shown first, so the tree can measure the view it is centring in.
    this.progressScreen.classList.add('show');
    this._buildAdvTabs();
    this._renderAdvTab();
  }

  _buildAdvTabs() {
    const bar = el('advTabs');
    bar.textContent = '';
    const tabs = [...ADVANCEMENT_TABS, { id: 'stats', title: 'Statistics', icon: 'book' }];
    for (const tab of tabs) {
      const button = document.createElement('button');
      button.className = 'advTab' + (tab.id === this._advTab ? ' active' : '');
      const iconId = idByName(tab.icon);
      const pic = document.createElement('i');
      if (iconId !== null) pic.style.backgroundImage = `url(${getTileDataURL(getIconTile(iconId))})`;
      const label = document.createElement('span');
      label.textContent = tab.title;
      button.append(pic, label);
      if (tab.id !== 'stats') {
        const nodes = ACHIEVEMENTS.filter((a) => a.tab === tab.id);
        const got = nodes.filter((a) => this.game.achievements.has(a.name)).length;
        const count = document.createElement('b');
        count.textContent = `${got}/${nodes.length}`;
        button.append(count);
      }
      button.addEventListener('click', () => {
        this._advTab = tab.id;
        audio.uiSwitch?.();
        this._buildAdvTabs();
        this._renderAdvTab();
      });
      bar.appendChild(button);
    }
  }

  _renderAdvTab() {
    const view = el('advView');
    const canvas = el('advCanvas');
    const stats = el('statList');
    const info = el('advInfo');
    info.textContent = '';
    const showStats = this._advTab === 'stats';
    canvas.style.display = showStats ? 'none' : '';
    stats.style.display = showStats ? '' : 'none';
    if (showStats) {
      stats.innerHTML = '';
      for (const [label, value] of this.game.stats.rows()) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = label;
        const amount = document.createElement('span');
        amount.className = 'statValue';
        amount.textContent = value;
        li.append(name, amount);
        stats.appendChild(li);
      }
      return;
    }

    const achievements = this.game.achievements;
    const nodes = ACHIEVEMENTS.filter((a) => a.tab === this._advTab);
    const layout = layoutTree(nodes);
    const COL = 128, ROW = 70, PAD = 36, SIZE = 44;
    const width = PAD * 2 + (layout.depth + 1) * COL;
    const height = PAD * 2 + Math.max(1, layout.rows) * ROW;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.querySelectorAll('.advNode').forEach((n) => n.remove());
    const svg = el('advLines');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = '';

    const at = (name) => {
      const p = layout.pos.get(name);
      return { x: PAD + p.x * COL, y: PAD + p.y * ROW };
    };
    for (const node of nodes) {
      if (!achievements.visible(node) || !node.parent || !layout.pos.has(node.parent)) continue;
      const a = at(node.parent), b = at(node.name);
      const mid = a.x + SIZE + (COL - SIZE) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${a.x + SIZE} ${a.y + SIZE / 2} H${mid} V${b.y + SIZE / 2} H${b.x}`);
      path.setAttribute('class', achievements.has(node.name) ? 'advLine done' : 'advLine');
      svg.appendChild(path);
    }
    for (const node of nodes) {
      if (!achievements.visible(node)) continue;
      const { x, y } = at(node.name);
      const got = achievements.has(node.name);
      const cell = document.createElement('div');
      cell.className = `advNode ${node.frame ?? 'task'}${got ? ' earned' : ''}`;
      cell.style.left = `${x}px`;
      cell.style.top = `${y}px`;
      const iconId = idByName(node.icon);
      if (iconId !== null) cell.style.backgroundImage = `url(${getTileDataURL(getIconTile(iconId))})`;
      const show = () => {
        const kind = node.frame === 'challenge' ? 'Challenge' : node.frame === 'goal' ? 'Goal' : 'Advancement';
        info.innerHTML = '';
        const title = document.createElement('b');
        title.textContent = node.title;
        const hint = document.createElement('span');
        hint.textContent = node.hint;
        const state = document.createElement('em');
        state.textContent = got ? `${kind} earned` : kind;
        info.append(title, hint, state);
        info.className = 'advInfo show' + (got ? ' earned' : '');
      };
      cell.addEventListener('mouseenter', show);
      canvas.appendChild(cell);
    }

    // Start with the tree's root in view: centred if the whole tree fits,
    // otherwise from its left edge, level with the first root.
    const first = nodes.find((n) => !n.parent);
    const rootY = first ? at(first.name).y + SIZE / 2 : height / 2;
    this._advPan = {
      x: width <= view.clientWidth ? (view.clientWidth - width) / 2 : 0,
      y: height <= view.clientHeight ? (view.clientHeight - height) / 2 : view.clientHeight / 2 - rootY,
    };
    this._applyAdvPan();
    if (!this._advDragBound) {
      this._advDragBound = true;
      let drag = null;
      view.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: { ...this._advPan } }; });
      window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        this._advPan = { x: drag.pan.x + e.clientX - drag.x, y: drag.pan.y + e.clientY - drag.y };
        this._applyAdvPan();
      });
      window.addEventListener('mouseup', () => { drag = null; });
      view.addEventListener('wheel', (e) => {
        e.preventDefault();
        this._advPan = { x: this._advPan.x - e.deltaX, y: this._advPan.y - e.deltaY };
        this._applyAdvPan();
      }, { passive: false });
    }
  }

  /** Keep the tree from being dragged right off the screen. */
  _applyAdvPan() {
    const view = el('advView');
    const canvas = el('advCanvas');
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    const vw = view.clientWidth, vh = view.clientHeight;
    const clamp = (v, lo, hi) => Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), v));
    this._advPan.x = clamp(this._advPan.x, vw - w - 40, 40);
    this._advPan.y = clamp(this._advPan.y, vh - h - 40, 40);
    canvas.style.transform = `translate(${this._advPan.x}px, ${this._advPan.y}px)`;
  }

  closeProgress() {
    this.progressScreen.classList.remove('show');
  }

  /** Close whatever container is open. */
  closeAllContainers() {
    if (this.inventoryScreen.classList.contains('show')) this.closeInventory();
    if (this.craftingScreen.classList.contains('show')) this.closeCraftingTable();
    if (this.furnaceScreen.classList.contains('show')) this.closeFurnace();
    if (this.chestScreen.classList.contains('show')) this.closeChest();
    if (this.enchantScreen.classList.contains('show')) this.closeEnchanting();
    if (this.anvilScreen.classList.contains('show')) this.closeAnvil();
    if (this.signScreen.classList.contains('show')) this.closeSign();
    if (this.progressScreen.classList.contains('show')) this.closeProgress();
    if (this.game.worldMap?.isOpen) this.game.worldMap.close();
    if (this.game.chat?.isOpen) this.game.chat.close();
    this.game._onContainersClosed?.();
  }

  get anyContainerOpen() {
    return (
      this.inventoryScreen.classList.contains('show') ||
      this.craftingScreen.classList.contains('show') ||
      this.furnaceScreen.classList.contains('show') ||
      this.chestScreen.classList.contains('show') ||
      this.enchantScreen.classList.contains('show') ||
      this.anvilScreen.classList.contains('show') ||
      this.signScreen.classList.contains('show') ||
      this.progressScreen.classList.contains('show') ||
      !!this.game.worldMap?.isOpen ||
      !!this.game.chat?.isOpen
    );
  }

  /** Never let the held stack vanish when a screen closes. */
  _returnCursor() {
    this._drag = null;
    this.hovered = null;
    this._hideTooltip();
    if (!this.cursorStack) return;
    this._giveBack(this.cursorStack);
    this.cursorStack = null;
    this._paintCursorStack();
  }

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  toggleDebug() {
    this.showDebug = !this.showDebug;
    this.debugEl.classList.toggle('show', this.showDebug);
    this._debugTimer = 0;
  }

  flashDamage() {
    if (!prefs.get('damageFlash')) return;
    this.damageFlashEl.classList.add('hit');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.damageFlashEl.classList.remove('hit'));
    });
  }

  /**
   * A red arc on the edge of the screen, on the side the hit came from.
   * Only for hits with a direction (mobs, arrows, explosions), and only if
   * the hit was recorded this instant, so a stale one is never shown.
   */
  _showHitArc() {
    const from = this.player.hitFrom;
    if (!from || performance.now() - from.at > 250) return;
    const p = this.player.position;
    const look = this.player.getLookDirection();
    const len = Math.hypot(look.x, look.z) || 1;
    const fx = look.x / len, fz = look.z / len;
    const dx = from.x - p.x, dz = from.z - p.z;
    // Angle from straight ahead, clockwise: positive means to your right.
    const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
    const arc = document.createElement('div');
    arc.className = 'hitArc';
    arc.style.transform = `rotate(${angle}rad)`;
    el('ui').appendChild(arc);
    setTimeout(() => arc.remove(), 1100);
  }

  /** Slide in a card with the achievement's icon, title and what it was for. */
  showAchievement(achievement) {
    const card = el('achievementCard');
    if (!card) {
      this.showToast(`Achievement: ${achievement.title}`);
      return;
    }
    const icon = achievementIcon(achievement.name);
    card.querySelector('.acIcon').style.backgroundImage = icon ? `url(${getTileDataURL(getIconTile(icon))})` : '';
    card.querySelector('.acTitle').textContent = achievement.title;
    card.querySelector('.acHint').textContent = achievement.hint;
    card.classList.remove('show');
    void card.offsetWidth; // restart the slide if one is already showing
    card.classList.add('show');
    clearTimeout(this._achievementTimer);
    this._achievementTimer = setTimeout(() => card.classList.remove('show'), 4200);
  }

  /** "New recipes" card, beside the achievement card, for what discovery taught. */
  showRecipes(ids) {
    const card = el('recipeCard');
    if (!card || ids.length === 0) return;
    card.querySelector('.acIcon').style.backgroundImage = `url(${getTileDataURL(getIconTile(ids[0]))})`;
    const names = ids.slice(0, 3).map((id) => getDisplayName(id));
    const more = ids.length - names.length;
    card.querySelector('.acTitle').textContent = ids.length === 1 ? 'New recipe' : `${ids.length} new recipes`;
    card.querySelector('.acHint').textContent = names.join(', ') + (more > 0 ? `, and ${more} more` : '');
    card.classList.remove('show');
    void card.offsetWidth;
    card.classList.add('show');
    clearTimeout(this._recipeTimer);
    this._recipeTimer = setTimeout(() => card.classList.remove('show'), 3600);
  }

  _showItemName() {
    const stack = this.player.inventory.getSelected();
    this.itemNameEl.textContent = stack ? getDisplayName(stack.id) : '';
    this.itemNameEl.classList.add('show');
    this._itemNameTimer = 1.6;
  }

  showToast(text) {
    this.itemNameEl.textContent = text;
    this.itemNameEl.classList.add('show');
    this._itemNameTimer = 1.6;
  }

  /** Corner notice, used for autosave confirmation. */
  showSaveToast(text) {
    this.saveToastEl.textContent = text;
    this.saveToastEl.classList.add('show');
    this._toastTimer = 1.8;
  }
}
