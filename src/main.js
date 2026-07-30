/**
 * main.js — Entry point, world lifecycle and game loop.
 *
 * Owns the coarse state machine:
 *   worlds -> loading -> menu -> playing -> paused | container | dead
 *
 * A "session" is one loaded world. Switching worlds tears down the World (and
 * its worker) and builds a new one, while the Player, HUD and renderer persist
 * — that keeps the DOM stable and avoids rebuilding the whole UI per world.
 */

import Settings from './settings.js';
import { Renderer } from './engine/renderer.js';
import { Input } from './engine/input.js';
import { SkyCycle } from './engine/sky.js';
import { ViewModel } from './engine/viewmodel.js';
import { World } from './world/world.js';
import { Player } from './player/player.js';
import { EntityManager } from './entities/entityManager.js';
import { HUD } from './ui/hud.js';
import { SettingsScreen } from './ui/settings.js';
import { TerrainGenerator } from './world/terrain.js';
import { SaveManager, captureState, applyState, SAVE_FORMAT_VERSION } from './world/save.js';
import { makeFurnaceState } from './player/crafting.js';
import {
  isLiquid, GRASS, DIRT, SAND, SNOW, STONE, DRY_GRASS, PODZOL, SWAMP_GRASS,
  CRAFTING_TABLE, isFurnaceBlock, isDoor, DOOR_CLOSED, DOOR_OPEN, BED, CHEST,
} from './world/blocks.js';
import { audio } from './engine/audio.js';

// Re-exported on `window.VoxelCraft` for console debugging.
import * as Blocks from './world/blocks.js';
import * as Crafting from './player/crafting.js';
import * as Save from './world/save.js';
import * as MobTypes from './entities/mobTypes.js';
import { Inventory } from './player/inventory.js';

const el = (id) => document.getElementById(id);

/** Blocks that make a sensible place to stand at spawn. */
const SPAWNABLE_GROUND = new Set([
  GRASS.id, DIRT.id, SAND.id, SNOW.id, STONE.id,
  DRY_GRASS.id, PODZOL.id, SWAMP_GRASS.id,
]);

/** Seconds between automatic saves while playing. */
const AUTOSAVE_INTERVAL = 30;

export class Game {
  constructor() {
    this.canvas = el('game');

    this.renderer = new Renderer(this.canvas);
    this.input = new Input(this.canvas);
    this.sky = new SkyCycle(this.renderer, 0.08);
    this.viewModel = new ViewModel(this.renderer);
    window.addEventListener('resize', () => this.viewModel.resize(window.innerWidth / window.innerHeight));
    this.viewModel.resize(window.innerWidth / window.innerHeight);

    // The world is built per session; the player outlives it.
    this.world = null;
    this.terrainInfo = null;

    this.player = new Player(null, this.renderer.camera, this.input, { x: 0.5, y: 100, z: 0.5 });
    this.entities = new EntityManager(this.renderer.scene, null);
    this.entities.onItemPickup = () => audio.pickup();
    this.hud = new HUD(this);
    // Remembers where settings was opened from, so closing returns there.
    this._settingsReturnState = 'menu';
    this.settings = new SettingsScreen(this.input, () => this._closeSettings());

    this.state = 'worlds';
    this.cameraInWater = false;
    this.cameraInLava = false;
    this.saveFormatVersion = SAVE_FORMAT_VERSION;

    /** Metadata for the world currently loaded. */
    this.saveMeta = null;
    this.worldName = null;
    this._autosaveTimer = 0;
    this._playTime = 0;
    this._saving = false;

    this._lastFrameTime = performance.now();

    this._bindUI();
    this._bindGameEvents();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  _bindUI() {
    el('playButton').addEventListener('click', () => this.input.requestLock());
    el('resumeButton').addEventListener('click', () => this.input.requestLock());
    el('quitButton').addEventListener('click', () => this.exitToMenu());
    el('startSettingsButton').addEventListener('click', () => this._openSettings());
    el('pauseSettingsButton').addEventListener('click', () => this._openSettings());
    el('respawnButton').addEventListener('click', () => this._respawn());

    el('newWorldButton').addEventListener('click', () => this._showCreateForm(true));
    el('modeSurvival').addEventListener('click', () => this._setCreateMode(false));
    el('modeCreative').addEventListener('click', () => this._setCreateMode(true));
    el('cancelCreateButton').addEventListener('click', () => this._showCreateForm(false));
    el('confirmCreateButton').addEventListener('click', () => this._createWorld());
    el('newWorldName').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._createWorld(); });
    el('newWorldSeed').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._createWorld(); });

    el('importWorldButton').addEventListener('click', () => el('importFileInput').click());
    el('importFileInput').addEventListener('change', (e) => this._importWorld(e));

    // Browsers refuse to start audio before a user gesture, so every button
    // and the canvas double as the unlock.
    const unlockAudio = () => audio.init();
    document.addEventListener('mousedown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    // Clicking the dimmed area outside a container panel throws the held stack
    // into the world, mirroring Minecraft.
    for (const screen of ['inventoryScreen', 'craftingScreen', 'furnaceScreen']) {
      el(screen).addEventListener('mousedown', (e) => {
        // Only when the click misses the panel itself.
        if (e.target !== e.currentTarget) return;
        if (!this.hud.cursorStack) return;
        const stack = this.hud.cursorStack;
        this.hud.cursorStack = null;
        this.player.throwItem(stack.id, stack.count, this.entities, stack.durability);
        this.hud.refreshAll();
      });
    }

    this.input.onLockChange = (locked) => {
      if (locked) {
        if (this.state !== 'playing' && this.state !== 'dead') this._setState('playing');
      } else if (this.state === 'playing') {
        this._setState('paused');
        this.saveWorld('Autosaved');
      }
    };
  }

  _bindGameEvents() {
    this.player.survival.onDeath = (cause) => this._onDeath(cause);

    // Right-clicking a station opens its interface instead of placing a block.
    this.player.onUseStation = (blockId, x, y, z) => {
      if (blockId === CRAFTING_TABLE.id) {
        this._openContainer(() => this.hud.openCraftingTable());
        return true;
      }

      // --- Doors: toggle open/closed ---------------------------------------
      if (isDoor(blockId)) {
        const opening = blockId === DOOR_CLOSED.id;
        this.world.setBlock(x, y, z, opening ? DOOR_OPEN.id : DOOR_CLOSED.id);
        // Doors are two blocks tall; keep both halves in step.
        for (const dy of [-1, 1]) {
          if (isDoor(this.world.getBlock(x, y + dy, z))) {
            this.world.setBlock(x, y + dy, z, opening ? DOOR_OPEN.id : DOOR_CLOSED.id);
          }
        }
        audio.door(opening);
        return true;
      }

      // --- Chests -----------------------------------------------------------
      if (blockId === CHEST.id) {
        const entity = this.world.getBlockEntity(x, y, z, () => ({
          type: 'chest',
          state: { slots: new Array(27).fill(null) },
        }));
        audio.chest(true);
        this._openContainer(() => this.hud.openChest(entity.state));
        return true;
      }

      // --- Beds -------------------------------------------------------------
      if (blockId === BED.id) {
        this._useBed(x, y, z);
        return true;
      }
      if (isFurnaceBlock(blockId)) {
        const entity = this.world.getBlockEntity(x, y, z, () => ({
          type: 'furnace',
          state: makeFurnaceState(),
          wasLit: false,
        }));
        this._openContainer(() => this.hud.openFurnace(entity.state));
        return true;
      }
      return false;
    };

    // Breaking a container spills its contents rather than deleting them.
    this.player.onBlockBroken = (blockId, target) => {
      if (!target) return;
      const key = `${target.x},${target.y},${target.z}`;
      const entity = this.world.blockEntities.get(key);

      if (entity && isFurnaceBlock(blockId)) {
        for (const field of ['input', 'fuel', 'output']) {
          const stack = entity.state[field];
          if (stack) this.player.inventory.addExisting(stack);
        }
        this.world.blockEntities.delete(key);
      } else if (entity && blockId === CHEST.id) {
        for (const stack of entity.state.slots) {
          if (stack) this.player.inventory.addExisting(stack);
        }
        this.world.blockEntities.delete(key);
      }

      // A door is two blocks; breaking either half removes both.
      if (isDoor(blockId)) {
        for (const dy of [-1, 1]) {
          if (isDoor(this.world.getBlock(target.x, target.y + dy, target.z))) {
            this.world.setBlock(target.x, target.y + dy, target.z, 0);
          }
        }
      }
    };
  }

  /**
   * Sleeping. Sets your spawn point, and skips to dawn if it is actually night
   * and nothing hostile is nearby — the same conditions Minecraft imposes, so a
   * bed is not simply a "skip the danger" button.
   */
  _useBed(x, y, z) {
    this.player.spawnPoint.set(x + 0.5, y + 1, z + 0.5);

    if (!this.sky.isNight) {
      this.hud.showToast('You can only sleep at night');
      return;
    }

    const hostileNearby = this.entities.mobs.some(
      (m) => !m.dead && m.type.brain && m.type.brain.hostile &&
             m.horizontalDistanceTo(this.player.position) < 12
    );
    if (hostileNearby) {
      this.hud.showToast('Monsters nearby!');
      return;
    }

    // Wind forward to just after sunrise and restore a little health.
    this.sky.setTime(0.02);
    this.player.survival.heal(3);
    this.hud.showToast('Spawn point set — good morning');
    this.saveWorld();
  }

  // -------------------------------------------------------------------------
  // World menu
  // -------------------------------------------------------------------------

  async boot() {
    this._lastFrameTime = performance.now();
    requestAnimationFrame(this._loop);
    await this._showWorldScreen();
  }

  async _showWorldScreen() {
    this._setState('worlds');
    this._showCreateForm(false);
    el('worldError').textContent = '';
    await this._refreshWorldList();
  }

  async _refreshWorldList() {
    const list = el('worldList');
    list.innerHTML = '';

    if (!SaveManager.available) {
      list.innerHTML = '<div class="emptyNote">Saving is unavailable in this browser ' +
        '(private mode blocks storage). You can still play, but nothing will be kept.</div>';
      return;
    }

    let worlds = [];
    try {
      worlds = await SaveManager.list();
    } catch (error) {
      list.innerHTML = `<div class="emptyNote">Could not read saved worlds: ${error.message}</div>`;
      return;
    }

    if (worlds.length === 0) {
      list.innerHTML = '<div class="emptyNote">No worlds yet — create one to start playing.</div>';
      return;
    }

    for (const world of worlds) {
      const row = document.createElement('div');
      row.className = 'worldRow' + (world.tooNew ? ' tooNew' : '');

      const played = Math.round(world.playTimeSeconds / 60);
      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML =
        `<div class="wname">${escapeHtml(world.name)}` +
        (world.allowCreative ? '<span class="badge">Creative</span>' : '') +
        (world.tooNew ? '<span class="badge warn">Newer version</span>' : '') +
        '</div>' +
        `<div class="wmeta">seed ${world.seed} &middot; ${played}m played &middot; ` +
        `${world.editedBlocks.toLocaleString()} blocks changed &middot; ${formatWhen(world.updatedAt)}</div>`;

      const play = document.createElement('button');
      play.textContent = 'Play';
      play.disabled = world.tooNew;
      play.addEventListener('click', (e) => { e.stopPropagation(); this._openWorld(world.id); });

      const exportBtn = document.createElement('button');
      exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this._exportWorld(world);
      });

      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${world.name}"? This cannot be undone.`)) return;
        await SaveManager.delete(world.id);
        await this._refreshWorldList();
      });

      row.append(info, play, exportBtn, del);
      if (!world.tooNew) row.addEventListener('click', () => this._openWorld(world.id));
      list.appendChild(row);
    }
  }

  _showCreateForm(show) {
    el('newWorldForm').style.display = show ? '' : 'none';
    el('worldActions').style.display = show ? 'none' : '';
    if (show) {
      el('newWorldName').value = 'New World';
      el('newWorldSeed').value = '';
      this._setCreateMode(false);
      el('newWorldName').focus();
      el('newWorldName').select();
    }
  }

  /**
   * Game mode is chosen once, at creation, and fixed for the world's lifetime.
   * A survival world can never be switched to creative — that is the whole
   * point of picking survival.
   */
  _setCreateMode(creative) {
    this._createCreative = creative;
    el('modeSurvival').classList.toggle('selected', !creative);
    el('modeCreative').classList.toggle('selected', creative);
    el('modeNote').textContent = creative
      ? 'Creative worlds can switch between creative and survival at any time.'
      : 'Survival is permanent — this world can never be switched to creative.';
  }

  /**
   * Seeds may be typed as text; hash non-numeric input so "hello" is a valid
   * seed just like it is in Minecraft.
   */
  _parseSeed(text) {
    const trimmed = text.trim();
    if (trimmed === '') return (Math.random() * 0x7fffffff) | 0;
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10) | 0;
    let h = 0;
    for (let i = 0; i < trimmed.length; i++) h = (Math.imul(h, 31) + trimmed.charCodeAt(i)) | 0;
    return h;
  }

  async _createWorld() {
    const name = el('newWorldName').value.trim() || 'New World';
    const seed = this._parseSeed(el('newWorldSeed').value);
    const save = SaveManager.createNew(name, seed, this._createCreative === true);
    try {
      if (SaveManager.available) await SaveManager.put(save);
    } catch (error) {
      el('worldError').textContent = 'Could not save: ' + error.message;
    }
    await this._startSession(save, true);
  }

  async _openWorld(id) {
    try {
      const save = await SaveManager.get(id);
      if (!save) return;
      await this._startSession(save, save.player === null);
    } catch (error) {
      el('worldError').textContent = error.message;
    }
  }

  async _exportWorld(world) {
    const json = await SaveManager.exportJSON(world.id);
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = world.name.replace(/[^\w-]+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async _importWorld(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await SaveManager.importJSON(await file.text());
      await this._refreshWorldList();
    } catch (error) {
      el('worldError').textContent = 'Import failed: ' + error.message;
    }
    event.target.value = '';
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load a world and get it ready to play.
   * @param isNew true when there is no player state to restore
   */
  async _startSession(save, isNew) {
    this._setState('loading');
    el('loadingFill').style.width = '0%';

    // Tear down any previous session, including its worker.
    if (this.world) this.world.dispose();
    this.entities.clear();

    this.world = new World(this.renderer.scene, {
      seed: save.seed,
      terrainVersion: save.terrainVersion,
    });
    this.player.world = this.world;
    this.entities.world = this.world;
    this.terrainInfo = new TerrainGenerator(save.seed, save.terrainVersion);

    // Whether this world may use creative at all, fixed when it was created.
    this.allowCreative = save.allowCreative === true;

    this.saveMeta = {
      id: save.id,
      name: save.name,
      createdAt: save.createdAt,
      playTimeSeconds: save.playTimeSeconds ?? 0,
      allowCreative: this.allowCreative,
    };
    this.worldName = save.name;
    this._playTime = save.playTimeSeconds ?? 0;
    this._autosaveTimer = 0;

    if (isNew) {
      this.player.survival.respawn();
      this.player.inventory.clear();
      this.player.inventory.armor.fill(null);
      // Creative worlds start in creative; survival worlds can never leave it.
      this.player.creative = this.allowCreative;
      this.sky.setTime(save.time ?? 0.08);
      await this._preloadAround(0, 0);
      const spawn = this._findSpawnColumn();
      this.player.teleportToSurface(spawn.x, spawn.z);
      this.player.spawnPoint.copy(this.player.position);
      this.player.inventory.giveStarterItems();
      this.player.inventory.selectSlot(0);
    } else {
      const { missing } = await applyState(this, save);
      if (missing.length > 0) {
        console.warn('[save] blocks no longer in this build:', missing.join(', '));
      }
      await this._preloadAround(this.player.position.x, this.player.position.z);
    }

    el('startWorldName').textContent = save.name;
    this._setState('menu');
  }

  /** Wait for the 3x3 chunk area around a position to finish generating. */
  _preloadAround(worldX, worldZ) {
    const REQUIRED = 9;
    const fill = el('loadingFill');
    const centerCX = Math.floor(worldX / 16);
    const centerCZ = Math.floor(worldZ / 16);
    const probe = { x: worldX, y: 0, z: worldZ };

    return new Promise((resolve) => {
      const tick = () => {
        this.world.update(probe, 0);

        let ready = 0;
        for (let cz = -1; cz <= 1; cz++) {
          for (let cx = -1; cx <= 1; cx++) {
            const chunk = this.world.getChunk(centerCX + cx, centerCZ + cz);
            if (chunk && chunk.ready) ready++;
          }
        }

        fill.style.width = ((ready / REQUIRED) * 100).toFixed(0) + '%';
        if (ready >= REQUIRED) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /** Nearest column to the origin that is dry land above sea level. */
  _findSpawnColumn() {
    for (let radius = 0; radius < 40; radius++) {
      for (let i = -radius; i <= radius; i++) {
        const ring = radius === 0
          ? [[0, 0]]
          : [[i, -radius], [i, radius], [-radius, i], [radius, i]];

        for (const [x, z] of ring) {
          const y = this.world.getSurfaceY(x, z);
          if (y <= Settings.seaLevel) continue;
          if (!SPAWNABLE_GROUND.has(this.world.getBlock(x, y, z))) continue;
          if (isLiquid(this.world.getBlock(x, y + 1, z))) continue;
          return { x, z };
        }
      }
    }
    return { x: 0, z: 0 };
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  /** Persist the current session. Safe to call at any time. */
  async saveWorld(toast) {
    if (!this.saveMeta || !this.world || this._saving || !SaveManager.available) return;
    this._saving = true;
    try {
      const save = await captureState(this, {
        ...this.saveMeta,
        playTimeSeconds: this._playTime,
      });
      await SaveManager.put(save);
      if (toast) this.hud.showSaveToast(toast);
    } catch (error) {
      console.error('[save] failed', error);
      this.hud.showSaveToast('Save failed');
    } finally {
      this._saving = false;
    }
  }

  /** Save and return to the world list. */
  async exitToMenu() {
    await this.saveWorld();
    this.hud.closeAllContainers();
    this.input.releaseLock();
    if (this.world) this.world.unloadAll();
    this.entities.clear();
    await this._showWorldScreen();
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  _setState(next) {
    this.state = next;
    el('worldScreen').classList.toggle('show', next === 'worlds');
    el('loadingScreen').classList.toggle('show', next === 'loading');
    el('startScreen').classList.toggle('show', next === 'menu');
    el('pauseScreen').classList.toggle('show', next === 'paused');
    el('deathScreen').classList.toggle('show', next === 'dead');
    if (next !== 'settings' && this.settings && this.settings.isOpen) {
      this.settings.screen.classList.remove('show');
    }
  }

  /**
   * Open settings. Remembers where it was opened from so closing goes back
   * there rather than always dumping you on the main menu.
   */
  _openSettings() {
    if (this.settings.isOpen) return;
    this._settingsReturnState = this.state === 'settings' ? this._settingsReturnState : this.state;
    this.hud.closeAllContainers();
    this._setState('settings');
    this.input.releaseLock();
    this.settings.open();
  }

  _closeSettings() {
    const back = this._settingsReturnState;
    // Returning to play needs the pointer back; a menu does not.
    if (back === 'playing' || back === 'container') {
      this._setState('paused');
    } else {
      this._setState(back);
    }
  }

  /** Open a container UI, releasing the pointer so the mouse can click slots. */
  _openContainer(open) {
    this._setState('container');
    this.input.releaseLock();
    open();
  }

  _closeContainer() {
    this.hud.closeAllContainers();
    this._setState('playing');
    this.input.requestLock();
  }

  _onDeath(cause) {
    const messages = {
      fall: 'You hit the ground too hard.',
      mob: 'You were slain by a zombie.',
      starve: 'You starved to death.',
      void: 'You fell out of the world.',
      lava: 'You tried to swim in lava.',
      explosion: 'A creeper got too close.',
    };
    el('deathCause').textContent = messages[cause] ?? 'You died.';
    this.hud.closeAllContainers();
    this._setState('dead');
    this.input.releaseLock();
    this.saveWorld();
  }

  _respawn() {
    this.player.respawn();
    this._setState('playing');
    this.input.requestLock();
  }

  // -------------------------------------------------------------------------
  // Game loop
  // -------------------------------------------------------------------------

  _loop = (now) => {
    requestAnimationFrame(this._loop);

    // Clamp dt so a backgrounded tab does not resume with a giant physics step.
    const dt = Math.min((now - this._lastFrameTime) / 1000, 0.1);
    this._lastFrameTime = now;

    this._update(dt);
  };

  _update(dt) {
    const input = this.input;

    // Nothing to simulate or draw until a world is loaded.
    if (!this.world) {
      input.endFrame();
      return;
    }

    const playing = this.state === 'playing';

    // --- Global hotkeys ----------------------------------------------------
    if (playing || this.state === 'container') {
      if (input.actionWasPressed('debug')) this.hud.toggleDebug();

      if (input.actionWasPressed('mute')) {
        this.hud.showToast(audio.toggleMute() ? 'Sound off' : 'Sound on');
      }

      if (input.actionWasPressed('settings')) this._openSettings();

      // Drop throws one item; holding sprint throws the whole stack.
      if (playing && input.actionWasPressed('drop')) {
        this.player.dropHeld(input.isActionDown('sprint'), { entities: this.entities });
      }

      if (input.actionWasPressed('creative')) {
        if (!this.allowCreative) {
          this.hud.showToast('This is a survival world');
        } else {
          const creative = this.player.toggleCreative(this.allowCreative);
          this.hud.showToast(creative ? 'Creative mode' : 'Survival mode');
          if (this.state === 'container') this.hud.openInventory();
        }
      }

      if (input.actionWasPressed('inventory')) {
        if (this.state === 'container') this._closeContainer();
        else this._openContainer(() => this.hud.openInventory());
      } else if (input.wasPressed('Escape') && this.state === 'container') {
        this._closeContainer();
      }

      // A drawn bow must not survive the menu opening.
      if (this.state === 'container') this.player.drawProgress = 0;
    }

    // --- Simulation --------------------------------------------------------
    if (playing) {
      this._playTime += dt;
      this.player.update(dt, { entities: this.entities });
      this.entities.update(dt, {
        player: this.player,
        isDay: this.sky.isDay,
        isNight: this.sky.isNight,
      });

      this._autosaveTimer += dt;
      if (this._autosaveTimer >= AUTOSAVE_INTERVAL) {
        this._autosaveTimer = 0;
        this.saveWorld('Saved');
      }
    }

    // The world keeps streaming even while paused, so resuming is seamless.
    // Fluids and furnaces still tick while a container is open, as in Minecraft.
    const simDt = playing || this.state === 'container' ? dt : 0;
    this.world.update(this.player.position, simDt);
    this.sky.update(playing ? dt : 0, this.world);

    // --- Presentation ------------------------------------------------------
    this.renderer.setSelection(playing ? this.player.targetBlock : null);

    const camera = this.renderer.camera.position;
    this.cameraInWater = this.world.isWater(camera.x, camera.y, camera.z);
    this.cameraInLava = this.world.isLava(camera.x, camera.y, camera.z);

    this.hud.update(dt);
    this.renderer.render();

    // The hand is drawn last, over the world, so it cannot clip into blocks.
    if (playing || this.state === 'container') {
      this.viewModel.update(playing ? dt : 0, this.player);
      this.viewModel.render();
    }

    input.endFrame();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatWhen(timestamp) {
  const seconds = (Date.now() - timestamp) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const game = new Game();
game.boot();

// Save on the way out — closing the tab should not lose progress.
window.addEventListener('beforeunload', () => {
  if (game.state === 'playing' || game.state === 'paused' || game.state === 'container') {
    game.saveWorld();
  }
});

// Handy for poking at the world from the browser console:
//   game.world.setBlock(x, y, z, VoxelCraft.blocks.DIAMOND_BLOCK.id)
//   game.player.inventory.add(VoxelCraft.blocks.toolItemId('pickaxe', 'diamond'))
window.game = game;
window.VoxelCraft = {
  blocks: Blocks, crafting: Crafting, save: Save, Inventory,
  mobTypes: MobTypes, settings: Settings, audio,
};
