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
  getMaxStack, getDurability, getArmor, getTool, getThing, ARMOR_PIECES,
} from '../world/blocks.js';
import { HOTBAR_SIZE, STORAGE_SIZE, Inventory } from '../player/inventory.js';
import { findRecipe, consumeGrid, fuelValueFor, smeltResultFor, SMELT_SECONDS } from '../player/crafting.js';
import { BIOME_NAMES } from '../world/terrain.js';
import { dimensionInfo } from '../world/dimensions.js';
import Settings from '../settings.js';
import { audio } from '../engine/audio.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** As many characters as fit legibly on a sign in the world. */
const SIGN_LINE_LENGTH = 15;

const HEART = '❤️';
const DRUMSTICK = '🍗';
const SHIELD = '🛡️';

const el = (id) => document.getElementById(id);

export class HUD {
  /** @param {import('../main.js').Game} game */
  constructor(game) {
    this.game = game;
    this.player = game.player;

    // --- Element refs ------------------------------------------------------
    this.hotbarEl = el('hotbar');
    this.healthEl = el('health');
    this.hungerEl = el('hunger');
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
    this.achievementList = el('achievementList');
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

    this._buildHotbar();
    this._buildStatRows();
    this._buildInventoryScreen();
    this._buildCraftingScreen();
    this._buildFurnaceScreen();
    this._buildChestScreen();
    this._bindEvents();
  }

  // -------------------------------------------------------------------------
  // Slot construction
  // -------------------------------------------------------------------------

  /**
   * @param {(button:number)=>void} [onAction] receives the mouse button:
   *   0 = left (whole stack), 2 = right (half / single item).
   */
  _makeSlot(onAction, className = '') {
    const slot = document.createElement('div');
    slot.className = 'slot ' + className;
    const icon = document.createElement('div');
    icon.className = 'icon';
    const count = document.createElement('div');
    count.className = 'count';
    const durability = document.createElement('div');
    durability.className = 'durability';
    durability.innerHTML = '<i></i>';
    slot.append(icon, count, durability);

    if (onAction) {
      // mousedown rather than click, so the right button registers at all.
      slot.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onAction(e.button);
      });
      slot.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    return { slot, icon, count, durability, bar: durability.firstChild };
  }

  /** Build a row of slots backed by an arbitrary array. */
  _buildArrayGrid(container, array, size, onChange, className = '') {
    const views = [];
    for (let i = 0; i < size; i++) {
      const parts = this._makeSlot(
        (button) => {
          this._slotAction(button, () => array[i], (s) => { array[i] = s; onChange?.(); });
          this.refreshAll();
        },
        className
      );
      container.appendChild(parts.slot);
      views.push(parts);
    }
    return views;
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
    this.heartPips = [];
    this.hungerPips = [];
    for (let i = 0; i < 10; i++) {
      const heart = document.createElement('span');
      heart.className = 'pip';
      heart.textContent = HEART;
      this.healthEl.appendChild(heart);
      this.heartPips.push(heart);

      const food = document.createElement('span');
      food.className = 'pip';
      food.textContent = DRUMSTICK;
      this.hungerEl.appendChild(food);
      this.hungerPips.push(food);
    }
    // Armour readout sits between the two bars, only shown when wearing gear.
    this.armorLabel = document.createElement('span');
    this.armorLabel.style.cssText = 'font-size:12px;margin-left:8px;text-shadow:1px 1px 2px #000';
    this.healthEl.appendChild(this.armorLabel);
  }

  _buildInventoryScreen() {
    const inv = this.player.inventory;

    // Backpack + hotbar rows share the inventory array.
    this.storageSlots = [];
    for (let i = 0; i < STORAGE_SIZE; i++) {
      const index = HOTBAR_SIZE + i;
      const parts = this._makeSlot((b) => this._inventorySlotAction(index, b));
      el('storageGrid').appendChild(parts.slot);
      this.storageSlots.push(parts);
    }

    this.invHotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const parts = this._makeSlot((b) => this._inventorySlotAction(i, b));
      el('invHotbarGrid').appendChild(parts.slot);
      this.invHotbarSlots.push(parts);
    }

    // Armour slots reject anything that is not the matching piece.
    this.armorSlots = [];
    for (let i = 0; i < ARMOR_PIECES.length; i++) {
      const parts = this._makeSlot((b) => {
        this._slotAction(
          b,
          () => inv.armor[i],
          (s) => { inv.armor[i] = s; inv.touch(); },
          (stack) => Inventory.armorSlotFor(stack.id) === i
        );
        this.refreshAll();
      }, 'armorSlot');
      parts.slot.title = ARMOR_PIECES[i];
      el('armorGrid').appendChild(parts.slot);
      this.armorSlots.push(parts);
    }

    // 2x2 crafting grid + its result.
    this.invCraftSlots = this._buildArrayGrid(el('invCraftGrid'), this.invCraftGrid, 4);
    this.invCraftResultSlot = this._makeSlot(
      () => { this._takeCraftResult(this.invCraftGrid, 2); this.refreshAll(); },
      'resultSlot'
    );
    el('invCraftResult').appendChild(this.invCraftResultSlot.slot);

    // Creative palette: every block, then every item.
    this.paletteIds = [...obtainableBlocks(), ...obtainableItems()];
    for (const id of this.paletteIds) {
      const parts = this._makeSlot((button) => this._onPaletteClick(id, button));
      parts.icon.style.backgroundImage = `url(${getTileDataURL(getIconTile(id))})`;
      parts.slot.title = getDisplayName(id);
      this.paletteGrid.appendChild(parts.slot);
    }
  }

  _buildCraftingScreen() {
    this.tableCraftSlots = this._buildArrayGrid(el('tableCraftGrid'), this.tableCraftGrid, 9);
    this.tableResultSlot = this._makeSlot(
      () => { this._takeCraftResult(this.tableCraftGrid, 3); this.refreshAll(); },
      'resultSlot'
    );
    el('tableCraftResult').appendChild(this.tableResultSlot.slot);

    this.tableStorageSlots = [];
    for (let i = 0; i < STORAGE_SIZE; i++) {
      const index = HOTBAR_SIZE + i;
      const parts = this._makeSlot((b) => this._inventorySlotAction(index, b));
      el('tableStorageGrid').appendChild(parts.slot);
      this.tableStorageSlots.push(parts);
    }
    this.tableHotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const parts = this._makeSlot((b) => this._inventorySlotAction(i, b));
      el('tableHotbarGrid').appendChild(parts.slot);
      this.tableHotbarSlots.push(parts);
    }
  }

  _buildFurnaceScreen() {
    const furnaceSlot = (field, filter) =>
      this._makeSlot((b) => {
        if (!this.activeFurnace) return;
        this._slotAction(b, () => this.activeFurnace[field], (s) => { this.activeFurnace[field] = s; }, filter);
        this.refreshAll();
      });

    // Only smeltable things go in the top slot, only fuels in the bottom.
    this.furnaceInputSlot = furnaceSlot('input', (s) => !!smeltResultFor(s.id));
    this.furnaceFuelSlot = furnaceSlot('fuel', (s) => fuelValueFor(s.id) > 0);
    // The output slot is take-only — you cannot put things back into it.
    this.furnaceOutputSlot = this._makeSlot((button) => {
      if (!this.activeFurnace || !this.activeFurnace.output) return;
      this._slotAction(button, () => this.activeFurnace.output, (s) => { this.activeFurnace.output = s; }, () => false);
      this.refreshAll();
    });

    el('furnaceInput').appendChild(this.furnaceInputSlot.slot);
    el('furnaceFuel').appendChild(this.furnaceFuelSlot.slot);
    el('furnaceOutput').appendChild(this.furnaceOutputSlot.slot);

    this.furnaceStorageSlots = [];
    for (let i = 0; i < STORAGE_SIZE; i++) {
      const index = HOTBAR_SIZE + i;
      const parts = this._makeSlot((b) => this._inventorySlotAction(index, b));
      el('furnaceStorageGrid').appendChild(parts.slot);
      this.furnaceStorageSlots.push(parts);
    }
    this.furnaceHotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const parts = this._makeSlot((b) => this._inventorySlotAction(i, b));
      el('furnaceHotbarGrid').appendChild(parts.slot);
      this.furnaceHotbarSlots.push(parts);
    }
  }

  _buildChestScreen() {
    // The chest's own 27 slots live on the block entity, so they are wired
    // through a getter that reads whichever chest is currently open.
    this.chestSlots = [];
    for (let i = 0; i < 27; i++) {
      const parts = this._makeSlot((button) => {
        if (!this.activeChest) return;
        this._slotAction(
          button,
          () => this.activeChest.slots[i],
          (s) => { this.activeChest.slots[i] = s; }
        );
        this.refreshAll();
      });
      el('chestGrid').appendChild(parts.slot);
      this.chestSlots.push(parts);
    }

    this.chestStorageSlots = [];
    for (let i = 0; i < STORAGE_SIZE; i++) {
      const index = HOTBAR_SIZE + i;
      const parts = this._makeSlot((b) => this._inventorySlotAction(index, b));
      el('chestStorageGrid').appendChild(parts.slot);
      this.chestStorageSlots.push(parts);
    }
    this.chestHotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const parts = this._makeSlot((b) => this._inventorySlotAction(i, b));
      el('chestHotbarGrid').appendChild(parts.slot);
      this.chestHotbarSlots.push(parts);
    }
  }

  _bindEvents() {
    document.addEventListener('mousemove', (e) => {
      if (!this.cursorStack) return;
      this.cursorStackEl.style.left = e.clientX + 'px';
      this.cursorStackEl.style.top = e.clientY + 'px';
    });

    // Right-clicking inside any container UI is a game action, never a menu.
    for (const screen of [this.inventoryScreen, this.craftingScreen, this.furnaceScreen, this.chestScreen]) {
      screen.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    this.player.survival.onDamage(() => this.flashDamage());
  }

  // -------------------------------------------------------------------------
  // Generic slot interaction
  // -------------------------------------------------------------------------

  _inventorySlotAction(index, button) {
    const inv = this.player.inventory;
    this._slotAction(button, () => inv.slots[index], (s) => inv.setSlot(index, s));
    this.refreshAll();
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
      if (!allowed(held)) return;
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

  _onPaletteClick(id, button) {
    if (button !== 0 && button !== 2) return;
    const wanted = button === 2 ? 1 : getMaxStack(id);

    if (this.cursorStack && this.cursorStack.id === id) {
      this.cursorStack.count = Math.min(getMaxStack(id), this.cursorStack.count + wanted);
    } else {
      if (this.cursorStack) this.player.inventory.add(this.cursorStack.id, this.cursorStack.count);
      this.cursorStack = Inventory.makeStack(id, wanted);
    }
    this.refreshAll();
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

  /** Return a crafting grid's contents to the inventory (on close). */
  _emptyGrid(grid) {
    for (let i = 0; i < grid.length; i++) {
      const stack = grid[i];
      if (!stack) continue;
      this.player.inventory.add(stack.id, stack.count);
      grid[i] = null;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(dt) {
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
    this._updateStats();
    this._updateBreakBar();
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

  _updateStats() {
    const survival = this.player.survival;
    this.statsEl.classList.toggle('hidden', this.player.creative);

    // Health can exceed the starting twenty — awakening a Comb throne raises the
    // cap permanently — so the row grows to fit rather than clipping the bonus
    // silently. Extra hearts are tinted so it reads as a boon, not a miscount.
    const wanted = Math.ceil(survival.maxHealth / 2);
    while (this.heartPips.length < wanted) {
      const heart = document.createElement('span');
      heart.className = 'pip bonus';
      heart.textContent = HEART;
      this.healthEl.appendChild(heart);
      this.heartPips.push(heart);
    }

    for (let i = 0; i < this.heartPips.length; i++) {
      const pip = this.heartPips[i];
      const threshold = (i + 1) * 2;
      // A pip past the current cap is hidden entirely, so losing a boost (or
      // loading a world without one) does not leave dead hearts on screen.
      pip.style.display = threshold - 1 <= survival.maxHealth ? '' : 'none';
      this._setPip(pip, survival.health, threshold);
    }

    for (let i = 0; i < 10; i++) {
      this._setPip(this.hungerPips[i], survival.hunger, (i + 1) * 2);
    }

    const armor = this.player.inventory.armorPoints;
    this.armorLabel.textContent = armor > 0 ? ` ${SHIELD} ${armor}` : '';
  }

  /** Each pip represents 2 points: full, half or empty. */
  _setPip(pip, value, threshold) {
    const full = value >= threshold;
    const half = !full && value >= threshold - 1;
    pip.classList.toggle('empty', !full && !half);
    pip.classList.toggle('half', half);
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
      this.hotbarSlots[i].slot.classList.toggle('selected', i === inv.selected);
    }

    for (let i = 0; i < STORAGE_SIZE; i++) {
      const stack = slots[HOTBAR_SIZE + i];
      this._paintSlot(this.storageSlots[i], stack);
      this._paintSlot(this.tableStorageSlots[i], stack);
      this._paintSlot(this.furnaceStorageSlots[i], stack);
      this._paintSlot(this.chestStorageSlots[i], stack);
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
    this._paintCursorStack();
  }

  /** Backwards-compatible alias — some call sites still use this name. */
  refreshInventory() {
    this.refreshAll();
  }

  _paintSlot(parts, stack) {
    if (!stack) {
      parts.icon.style.backgroundImage = '';
      parts.count.textContent = '';
      parts.durability.classList.remove('show');
      parts.slot.title = '';
      return;
    }

    parts.icon.style.backgroundImage = `url(${getTileDataURL(getIconTile(stack.id))})`;
    parts.count.textContent = stack.count > 1 ? stack.count : '';
    parts.slot.title = getDisplayName(stack.id);

    // Wear bar, green fading to red as the tool nears breaking.
    const max = getDurability(stack.id);
    if (max > 0 && stack.durability !== undefined && stack.durability < max) {
      const ratio = Math.max(0, stack.durability / max);
      parts.durability.classList.add('show');
      parts.bar.style.width = (ratio * 100).toFixed(1) + '%';
      parts.bar.style.background = `hsl(${Math.round(ratio * 110)}, 85%, 45%)`;
      parts.slot.title += `  ${stack.durability}/${max}`;
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
  }

  closeInventory() {
    this._emptyGrid(this.invCraftGrid);
    this._returnCursor();
    this.inventoryScreen.classList.remove('show');
    this.refreshAll();
  }

  openCraftingTable() {
    this.refreshAll();
    this.craftingScreen.classList.add('show');
  }

  closeCraftingTable() {
    this._emptyGrid(this.tableCraftGrid);
    this._returnCursor();
    this.craftingScreen.classList.remove('show');
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

  /** Rebuild and show the progress screen. Cheap: both lists are short. */
  openProgress() {
    const { achievements, stats } = this.game;

    const { earned, total } = achievements.progress;
    this.progressCount.textContent = `${earned} / ${total}`;

    this.achievementList.innerHTML = '';
    for (const row of achievements.rows()) {
      const li = document.createElement('li');
      li.className = row.earned ? 'earned' : 'locked';
      const title = document.createElement('span');
      title.className = 'achTitle';
      title.textContent = row.title;
      const hint = document.createElement('span');
      hint.className = 'achHint';
      hint.textContent = row.hint;
      li.append(title, hint);
      this.achievementList.appendChild(li);
    }

    this.statList.innerHTML = '';
    for (const [label, value] of stats.rows()) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('span');
      amount.className = 'statValue';
      amount.textContent = value;
      li.append(name, amount);
      this.statList.appendChild(li);
    }

    this.progressScreen.classList.add('show');
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
    if (this.signScreen.classList.contains('show')) this.closeSign();
    if (this.progressScreen.classList.contains('show')) this.closeProgress();
  }

  get anyContainerOpen() {
    return (
      this.inventoryScreen.classList.contains('show') ||
      this.craftingScreen.classList.contains('show') ||
      this.furnaceScreen.classList.contains('show') ||
      this.chestScreen.classList.contains('show') ||
      this.signScreen.classList.contains('show') ||
      this.progressScreen.classList.contains('show')
    );
  }

  /** Never let the held stack vanish when a screen closes. */
  _returnCursor() {
    if (!this.cursorStack) return;
    this.player.inventory.add(this.cursorStack.id, this.cursorStack.count);
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
    this.damageFlashEl.classList.add('hit');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.damageFlashEl.classList.remove('hit'));
    });
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
