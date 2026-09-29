/**
 * recipeBook.js — Finding out how to make things, in game.
 *
 * Until now the only way to learn a recipe was to already know it. Jev's pick
 * (see JEV_DECISIONS.md) was both halves of what modern crafting games do: a
 * searchable browser of every block and item, with whatever you can make
 * right now pinned at the top, where clicking a recipe lays its ingredients
 * out in the grid for you; and, for anything else, a page showing how it is
 * made, what it smelts from, and what it is used in.
 *
 * One instance sits beside each crafting grid (the 2x2 in the inventory and
 * the 3x3 table). It owns no state of its own beyond what is on screen: what
 * can be crafted is worked out afresh from the inventory each refresh.
 *
 * Phase 3 added discovery (see discovery.js): a recipe only appears once you
 * have held something that goes into it, and the book counts what is left.
 */

import { RECIPES, SMELTING } from '../player/crafting.js';
import {
  obtainableBlocks, obtainableItems, getDisplayName, getIconTile, getMaxStack,
} from '../world/blocks.js';
import { getTileDataURL } from '../world/textures.js';
import { audio } from '../engine/audio.js';

const STORAGE_KEY = 'voxelcraft.recipeBook.open';

/** Ingredient counts for one batch of a recipe. */
function needsOf(recipe) {
  const counts = new Map();
  const add = (id) => counts.set(id, (counts.get(id) ?? 0) + 1);
  if (recipe.type === 'shaped') {
    for (const row of recipe.pattern) {
      for (const cell of row) if (cell !== '.' && cell !== ' ') add(recipe.key[cell]);
    }
  } else {
    for (const id of recipe.ingredients) add(id);
  }
  return counts;
}

/** Grid width a recipe needs: 2 fits the inventory, 3 needs a table. */
function sizeOf(recipe) {
  if (recipe.type === 'shaped') {
    return Math.max(recipe.pattern.length, ...recipe.pattern.map((row) => row.length));
  }
  return recipe.ingredients.length <= 4 ? 2 : 3;
}

/** Every recipe, grouped by what it makes. Built once; recipes never change. */
const BY_RESULT = new Map();
for (const recipe of RECIPES) {
  const list = BY_RESULT.get(recipe.result.id) ?? [];
  list.push(recipe);
  BY_RESULT.set(recipe.result.id, list);
}

/** Which recipes use an item, for the "used in" row. */
const USED_IN = new Map();
for (const recipe of RECIPES) {
  for (const id of needsOf(recipe).keys()) {
    const set = USED_IN.get(id) ?? new Set();
    set.add(recipe.result.id);
    USED_IN.set(id, set);
  }
}

/** Smelting, looked up backwards: what an item is smelted from. */
const SMELTED_FROM = new Map();
for (const [input, output] of SMELTING) {
  const list = SMELTED_FROM.get(output.id) ?? [];
  list.push(input);
  SMELTED_FROM.set(output.id, list);
}

function icon(id) {
  return `url(${getTileDataURL(getIconTile(id))})`;
}

export class RecipeBook {
  /**
   * @param hud the HUD, for the inventory, tooltips and refreshing
   * @param options {panel, grid, size, toggle}
   *   panel   container element for the book
   *   grid    the crafting grid array it fills
   *   size    2 or 3
   *   toggle  button that shows and hides the book
   */
  constructor(hud, { panel, grid, size, toggle }) {
    this.hud = hud;
    this.panel = panel;
    this.grid = grid;
    this.size = size;
    this.query = '';
    /** Item whose page is open, or null for the list. */
    this.detailId = null;

    this._build();
    let open = true;
    try {
      open = localStorage.getItem(STORAGE_KEY) !== '0';
    } catch {
      // Storage blocked: the book simply starts open.
    }
    this.setOpen(open);
    toggle?.addEventListener('click', () => {
      this.setOpen(!this.open);
      try {
        localStorage.setItem(STORAGE_KEY, this.open ? '1' : '0');
      } catch {
        // Not remembered; harmless.
      }
    });
  }

  setOpen(open) {
    this.open = open;
    this.panel.classList.toggle('show', open);
    if (open) this.refresh();
  }

  _build() {
    this.panel.innerHTML = `
      <div class="rbHead">
        <div class="invLabel" style="margin:0">Recipes</div>
        <input class="rbSearch" type="text" placeholder="Search&hellip;" autocomplete="off" spellcheck="false">
      </div>
      <div class="rbBody"></div>`;
    this.body = this.panel.querySelector('.rbBody');
    const search = this.panel.querySelector('.rbSearch');
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.detailId = null;
      this.refresh();
    });
  }

  /** What there is to craft with: the inventory plus whatever is in the grid. */
  _available() {
    const counts = new Map();
    const add = (stack) => {
      if (stack && stack.durability === undefined) counts.set(stack.id, (counts.get(stack.id) ?? 0) + stack.count);
    };
    for (const stack of this.hud.player.inventory.slots) add(stack);
    for (const stack of this.grid) add(stack);
    return counts;
  }

  /** How many batches of a recipe the materials cover, in this grid. */
  _batches(recipe, available) {
    if (sizeOf(recipe) > this.size) return 0;
    let batches = Infinity;
    for (const [id, need] of needsOf(recipe)) {
      batches = Math.min(batches, Math.floor((available.get(id) ?? 0) / need));
    }
    return batches === Infinity ? 0 : batches;
  }

  refresh() {
    if (!this.open || !this.panel.closest('.overlay.show')) return;
    if (this.detailId !== null) this._renderDetail(this.detailId);
    else this._renderList();
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  /** Whether the player has found out how to make this yet. */
  _known(id) {
    const discovery = this.hud.game.discovery;
    return !discovery || discovery.knows(id);
  }

  _renderList() {
    const available = this._available();
    const craftable = [];
    const recipes = [];
    const materials = [];
    const matches = (id) => !this.query || getDisplayName(id).toLowerCase().includes(this.query);

    for (const id of [...obtainableBlocks(), ...obtainableItems()]) {
      if (!matches(id)) continue;
      const list = BY_RESULT.get(id);
      if (!list) materials.push(id);
      else if (!this._known(id)) continue;
      else if (list.some((r) => this._batches(r, available) > 0)) craftable.push(id);
      else recipes.push(id);
    }

    this.body.textContent = '';
    this._section('Can make now', craftable, 'craftable');
    this._section(this.size === 2 ? 'Other recipes' : 'Missing materials', recipes, 'locked');
    this._section('Found, not made', materials, 'material');
    if (!craftable.length && !recipes.length && !materials.length) {
      const empty = document.createElement('div');
      empty.className = 'rbEmpty';
      empty.textContent = 'Nothing matches.';
      this.body.appendChild(empty);
    }
    const hidden = this.hud.game.discovery?.remaining ?? 0;
    if (hidden > 0) {
      const note = document.createElement('div');
      note.className = 'rbEmpty rbUndiscovered';
      note.textContent = `${hidden} more to discover: pick up new materials to learn what they make.`;
      this.body.appendChild(note);
    }
  }

  _section(title, ids, kind) {
    if (ids.length === 0) return;
    const label = document.createElement('div');
    label.className = 'rbLabel';
    label.textContent = `${title} (${ids.length})`;
    const grid = document.createElement('div');
    grid.className = 'rbGrid';
    for (const id of ids) grid.appendChild(this._entry(id, kind));
    this.body.append(label, grid);
  }

  _entry(id, kind) {
    const cell = document.createElement('div');
    cell.className = `rbItem ${kind}`;
    cell.style.backgroundImage = icon(id);
    cell.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Left click on something you can make fills the grid; anything else,
      // or a right click, opens its page.
      if (kind === 'craftable' && e.button === 0) this._fillFor(id, e.shiftKey);
      else this._showDetail(id);
    });
    cell.addEventListener('contextmenu', (e) => e.preventDefault());
    this._tooltip(cell, id, kind === 'craftable'
      ? 'Click to fill the grid, shift-click for as many as you can'
      : 'Click to see how it is made');
    return cell;
  }

  _tooltip(cell, id, hint) {
    const parts = {
      binding: { role: 'recipe', get: () => ({ id, count: 1 }) },
      hint,
    };
    cell.addEventListener('mouseenter', () => this.hud._showTooltip(parts));
    cell.addEventListener('mouseleave', () => this.hud._hideTooltip());
  }

  // -------------------------------------------------------------------------
  // Filling the grid
  // -------------------------------------------------------------------------

  _fillFor(id, max) {
    const available = this._available();
    const recipe = (BY_RESULT.get(id) ?? []).find((r) => this._batches(r, available) > 0);
    if (recipe) this.fill(recipe, max);
  }

  /**
   * Lay one batch of a recipe out in the grid, or as many as the materials
   * and stack sizes allow. Whatever was in the grid goes back to the
   * inventory first, so it counts toward the ingredients.
   */
  fill(recipe, max = false) {
    const hud = this.hud;
    const inv = hud.player.inventory;
    hud._emptyGrid(this.grid);

    const available = this._available();
    let sets = max ? this._batches(recipe, available) : Math.min(1, this._batches(recipe, available));
    for (const id of needsOf(recipe).keys()) sets = Math.min(sets, getMaxStack(id));
    if (sets <= 0) {
      audio.uiError();
      return;
    }

    const place = (index, id) => {
      const taken = inv.removeFirst(id, sets);
      if (taken > 0) this.grid[index] = { id, count: taken };
    };
    if (recipe.type === 'shaped') {
      recipe.pattern.forEach((row, y) => {
        [...row].forEach((cell, x) => {
          if (cell !== '.' && cell !== ' ') place(y * this.size + x, recipe.key[cell]);
        });
      });
    } else {
      recipe.ingredients.forEach((id, i) => place(i, id));
    }
    audio.uiSlot();
    hud.refreshAll();
  }

  // -------------------------------------------------------------------------
  // An item's page
  // -------------------------------------------------------------------------

  _showDetail(id) {
    this.detailId = id;
    audio.uiSelect();
    this.refresh();
  }

  _renderDetail(id) {
    const available = this._available();
    this.body.textContent = '';

    const head = document.createElement('div');
    head.className = 'rbDetailHead';
    const back = document.createElement('button');
    back.className = 'miniButton';
    back.textContent = '← Back';
    back.addEventListener('click', () => { this.detailId = null; this.refresh(); });
    const badge = document.createElement('div');
    badge.className = 'rbItem';
    badge.style.backgroundImage = icon(id);
    const name = document.createElement('div');
    name.className = 'rbName';
    name.textContent = getDisplayName(id);
    head.append(back, badge, name);
    this.body.appendChild(head);

    const recipes = BY_RESULT.get(id) ?? [];
    for (const recipe of recipes) this.body.appendChild(this._recipeCard(recipe, available));

    const smelted = SMELTED_FROM.get(id);
    if (smelted) this._iconRow('Smelted from', smelted);
    if (!recipes.length && !smelted) {
      const note = document.createElement('div');
      note.className = 'rbEmpty';
      note.textContent = 'Not crafted. Mine it, find it, or get it from a mob.';
      this.body.appendChild(note);
    }

    // Only what you know about; the rest stays a surprise.
    const used = [...(USED_IN.get(id) ?? [])].filter((result) => this._known(result));
    if (used.length) this._iconRow('Used to make', used);
  }

  /** One way of making it: the pattern, what you have of each ingredient, and a Fill button. */
  _recipeCard(recipe, available) {
    const card = document.createElement('div');
    card.className = 'rbCard';

    const pattern = document.createElement('div');
    pattern.className = 'rbPattern';
    const width = sizeOf(recipe);
    pattern.style.gridTemplateColumns = `repeat(${width}, 26px)`;
    const cells = [];
    if (recipe.type === 'shaped') {
      for (let y = 0; y < width; y++) {
        for (let x = 0; x < width; x++) {
          const ch = recipe.pattern[y]?.[x];
          cells.push(ch && ch !== '.' && ch !== ' ' ? recipe.key[ch] : null);
        }
      }
    } else {
      for (let i = 0; i < width * width; i++) cells.push(recipe.ingredients[i] ?? null);
    }
    for (const ingredient of cells) {
      const cell = document.createElement('div');
      cell.className = 'rbCell';
      if (ingredient !== null) {
        cell.style.backgroundImage = icon(ingredient);
        cell.addEventListener('mousedown', (e) => { e.preventDefault(); this._showDetail(ingredient); });
        this._tooltip(cell, ingredient, 'Click to see how it is made');
      }
      pattern.appendChild(cell);
    }

    const arrow = document.createElement('div');
    arrow.className = 'rbArrow';
    arrow.textContent = recipe.result.count > 1 ? `→ ×${recipe.result.count}` : '→';

    const needs = document.createElement('div');
    needs.className = 'rbNeeds';
    for (const [ingredient, count] of needsOf(recipe)) {
      const have = available.get(ingredient) ?? 0;
      const line = document.createElement('div');
      line.className = have >= count ? 'ok' : 'short';
      line.textContent = `${getDisplayName(ingredient)}  ${Math.min(have, 99)}/${count}`;
      needs.appendChild(line);
    }

    card.append(pattern, arrow, needs);

    if (sizeOf(recipe) > this.size) {
      const note = document.createElement('div');
      note.className = 'rbNote';
      note.textContent = 'Needs a crafting table';
      card.appendChild(note);
    } else if (this._batches(recipe, available) > 0) {
      const fill = document.createElement('button');
      fill.className = 'miniButton';
      fill.textContent = 'Fill grid';
      fill.addEventListener('click', (e) => this.fill(recipe, e.shiftKey));
      card.appendChild(fill);
    }
    return card;
  }

  _iconRow(title, ids) {
    const label = document.createElement('div');
    label.className = 'rbLabel';
    label.textContent = title;
    const row = document.createElement('div');
    row.className = 'rbGrid';
    for (const id of ids) {
      const cell = document.createElement('div');
      cell.className = 'rbItem';
      cell.style.backgroundImage = icon(id);
      cell.addEventListener('mousedown', (e) => { e.preventDefault(); this._showDetail(id); });
      this._tooltip(cell, id, 'Click to see how it is made');
      row.appendChild(cell);
    }
    this.body.append(label, row);
  }
}
