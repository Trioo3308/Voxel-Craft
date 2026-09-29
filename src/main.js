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

import { prefs } from './engine/preferences.js';
import { terrainUniforms } from './engine/terrainMaterial.js';
import { DynamicLight } from './engine/dynamicLight.js';
import { sampleLocalLight } from './engine/localLight.js';
import { Exploration } from './world/exploration.js';
import { WorldMap } from './ui/worldMap.js';
import { Captions } from './ui/captions.js';
import { difficulty, setDifficulty as applyDifficulty, nextDifficulty, DIFFICULTIES } from './player/difficulty.js';
import { NetherTerrainGenerator, FORTRESS_SPACING, NETHER_LAVA_LEVEL, NETHER_CEILING } from './world/netherTerrain.js';
import Settings from './settings.js';
import { Renderer } from './engine/renderer.js';
import { Input } from './engine/input.js';
import { SkyCycle } from './engine/sky.js';
import { ViewModel } from './engine/viewmodel.js';
import { World } from './world/world.js';
import { getTileDataURL } from './world/textures.js';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from './world/chunk.js';
import { Player } from './player/player.js';
import { EntityManager } from './entities/entityManager.js';
import { ParticleSystem } from './entities/particles.js';
import { SignRenderer } from './world/signRenderer.js';
import { Weather, WEATHER } from './engine/weather.js';
import { HUD } from './ui/hud.js';
import { SettingsScreen } from './ui/settings.js';
import { TerrainGenerator } from './world/terrain.js';
import { SaveManager, captureState, applyState, SAVE_FORMAT_VERSION } from './world/save.js';
import { makeFurnaceState } from './player/crafting.js';
import { Statistics, Achievements } from './player/progress.js';
import {
  isLiquid, GRASS, DIRT, SAND, SNOW, STONE, DRY_GRASS, PODZOL, SWAMP_GRASS,
  CRAFTING_TABLE, isFurnaceBlock, isDoor, isDoorOpen, doorBlock, DOOR_CLOSED,
  isBed, BED, FACINGS, getBlock, CHEST,
  isPlate, PRESSURE_PLATE, PRESSURE_PLATE_PRESSED, SIGN, JUKEBOX, MUSIC_DISCS,
  PORTAL, COMBIUM_BLOCK, THRONE, THRONE_AWAKENED, ITEM_ID,
  LOG, ACACIA_LOG, SPRUCE_LOG, DIAMOND_ORE, FURNACE, getItem, getDisplayName,
  OBSIDIAN, GLOWSTONE, GRAVESTONE, isFluidFamily,
  SUGAR_CANE, ENCHANTING_TABLE, ANVIL, BOOKSHELF,
  getThing,
} from './world/blocks.js';
import { MINING_XP, xpBetween, roundXp } from './player/experience.js';
import { countBookshelves } from './player/enchanting.js';
import { caneCanStand } from './world/sugarCane.js';
import { RecipeDiscovery } from './player/discovery.js';
import { FarTerrain, FAR_REACH } from './engine/farTerrain.js';
import { HostSession, GuestSession, cleanName } from './net/session.js';
import { probeTransports, normalizeCode, isCode, formatCode } from './net/transport.js';
import { decodeEdits } from './net/codec.js';
import { Chat } from './ui/chat.js';
import { audio } from './engine/audio.js';
import { DIMENSIONS, dimensionInfo } from './world/dimensions.js';
import {
  CombTerrainGenerator, SHRINE_SPACING, SHRINE_LAYOUT, nearestShrineAnchor, HIVE_SPACING,
} from './world/combTerrain.js';
import { DUNGEON_SPACING, SKATEPARK_SPACING, BIOME_NAMES } from './world/terrain.js';
import {
  ignitePortal, extinguishPortal, buildReturnPortal, destinationOf,
  portalKindForIgniter, portalKindForFrame, kindForDimension,
} from './world/portal.js';
import { ISLAND_BAND, ISLAND_SPREAD, AETHER_VOID } from './world/aetherTerrain.js';
import { THRONE_LOOT, DUNGEON_LOOT, HIVE_LOOT, fillChest } from './entities/loot.js';
import { WARDEN } from './entities/mobTypes.js';

/**
 * Overworld coordinates are divided by this when entering the Comb, so the
 * dimension is compact relative to the overworld — the same trick the Nether
 * uses to make it a travel shortcut.
 */
const DIMENSION_SCALE = 4;

/** Extra max health granted permanently by awakening a throne. */
const THRONE_HEALTH_BONUS = 4;

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

/** Seed of the world behind the title screen, chosen for its view. */
const PANORAMA_SEED = 20260928;
/** Seconds between thumbnail grabs while playing, for the world list. */
const THUMBNAIL_INTERVAL = 30;

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

    // Progress is per-world and saved with it, but the objects live for the
    // lifetime of the game and are reloaded on each session — same as the
    // player, so the HUD can hold a reference that never goes stale.
    this.stats = new Statistics();
    this.achievements = new Achievements(this.stats);
    this.achievements.onUnlock = (achievement) => {
      this.hud.showAchievement(achievement);
      audio.achievement();
    };
    /** Low-detail land past the render distance; see farTerrain.js. */
    this.farTerrain = new FarTerrain(this.renderer.scene);
    /** Which recipes this world's player has found out about; see discovery.js. */
    this.discovery = new RecipeDiscovery();
    this.discovery.onDiscover = (ids) => this.hud.showRecipes(ids);
    this._discoveryVersion = -1;

    this.hud = new HUD(this);
    /**
     * Multiplayer (net/session.js): the HostSession or GuestSession while
     * playing with others, else null. `remoteWorld` is set while in someone
     * else's world, which this browser must never save as its own, and
     * `guestRecords` holds this world's guests' belongings by name.
     */
    this.net = null;
    this.remoteWorld = false;
    this.guestRecords = {};
    /** What the page's server offers for multiplayer; see probeTransports. */
    this._netCaps = null;
    this.chat = new Chat(this);
    this.chat.onSend = (text) => this.net?.say(text);
    /** The block entity whose screen is open, so closing it can hand it back. */
    this._openEntity = null;
    // Remembers where settings was opened from, so closing returns there.
    this._settingsReturnState = 'menu';
    this.settings = new SettingsScreen(this.input, () => this._closeSettings());

    this.weather = new Weather();

    /** Moving light: a held torch, glowing mobs. See dynamicLight.js. */
    this.dynamicLight = new DynamicLight();
    /** What you have explored, per dimension, for the map. */
    this.exploration = new Exploration();
    this.worldMap = new WorldMap(this);
    this.captions = new Captions(el('captions'));
    audio.onCaption = (text, position) => this.captions.show(text, position);
    this.difficultyId = 'normal';

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

    /**
     * Structures already stocked — Comb shrines by throne position, dungeons
     * prefixed "d:". Saved with the world so loot is never re-rolled.
     */
    this._shrinesDone = new Set();
    /**
     * Plates currently held down, mapped to the doors each one opened. Not
     * saved: a plate with nobody on it is up, which is what a fresh load
     * produces anyway.
     */
    this._platesDown = new Map();
    /** Where the record currently playing is coming from, for its falloff. */
    this._playingJukebox = null;
    /** Last sampled position, for the distance-travelled counter. */
    this._lastProgressPos = null;
    this._shrineTimer = 0;
    this._dungeonTimer = 0;
    this._hiveTimer = 0;
    this._caveSoundTimer = 20;
    this._travelling = false;
    /**
     * Where chunks stream around while a loading screen waits on somewhere
     * other than where the player stands; null the rest of the time. See
     * _preloadAround.
     */
    this._loadFocus = null;

    this._lastFrameTime = performance.now();
    /** Current FOV multiplier from speed effects, eased toward its target. */
    this._fovKick = 1;

    this._bindUI();
    this._bindGameEvents();

    // Per-browser options. `onChange` also replays the current values, so this
    // one subscription is both the initial setup and every later change.
    prefs.onChange((id, value) => this._applyPreference(id, value));
  }

  /** Push one option into whichever system owns it. */
  _applyPreference(id, value) {
    switch (id) {
      case 'renderDistance':
        Settings.renderDistance = value;
        if (this.world) this.world.renderDistance = value;
        this.renderer.setViewDistance(value);
        break;
      case 'fov':
        this.renderer.setBaseFov(value);
        break;
      case 'masterVolume':
        audio.setVolume(value);
        break;
      case 'musicVolume':
        audio.setMusicVolume(value);
        break;
      case 'effectsVolume':
        audio.setEffectsVolume(value);
        break;
      case 'guiScale':
        document.documentElement.style.setProperty('--gui-scale', String(value));
        break;
      case 'showCoords':
        Settings.showLocator = value;
        break;
      case 'graphics':
        // Auto starts from wherever it last settled on this machine.
        this._autoQuality = { total: 0, frames: 0 };
        this.renderer.setQuality(value === 'auto' ? loadAutoQuality() : value);
        this.world?.setFastLeaves(this.renderer.quality === 'low');
        this._applyFarTerrain();
        break;
      case 'farTerrain':
        this._applyFarTerrain();
        break;
      case 'clouds':
        this.sky.atmosphere.cloudsEnabled = value;
        break;
      case 'foliageSway':
        terrainUniforms.uSway.value = value ? 1 : 0;
        break;
      case 'brightness':
        // A floor under the darkest shade: caves go from black to very dark.
        terrainUniforms.uMinLight.value = 0.006 + value * 0.09;
        break;
    }
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
    for (const id of Object.keys(DIFFICULTIES)) {
      el(`diff-${id}`)?.addEventListener('click', () => this._setCreateDifficulty(id));
    }
    el('difficultyButton').addEventListener('click', () => {
      this.setDifficulty(nextDifficulty(this.difficultyId));
    });
    el('newWorldName').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._createWorld(); });
    el('newWorldSeed').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._createWorld(); });

    // Multiplayer: joining from the title screen, hosting from the pause menu.
    el('joinWorldButton').addEventListener('click', () => this._showJoinForm(true));
    el('joinCancelButton').addEventListener('click', () => this._showJoinForm(false));
    el('joinConfirmButton').addEventListener('click', () => this._joinGame());
    for (const id of ['joinName', 'joinCode']) {
      el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') this._joinGame(); });
    }
    el('hostButton').addEventListener('click', () => this._startHosting());
    el('stopHostButton').addEventListener('click', () => this._endNet());
    el('hostName').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._startHosting(); });
    probeTransports().then((caps) => {
      this._netCaps = caps;
      this._refreshNetUi();
    });

    el('importWorldButton').addEventListener('click', () => el('importFileInput').click());
    el('importFileInput').addEventListener('change', (e) => this._importWorld(e));

    // Browsers refuse to start audio before a user gesture, so every button
    // and the canvas double as the unlock. The recordings download now, so
    // they are ready the moment it happens.
    audio.preload();
    const unlockAudio = () => audio.init();
    document.addEventListener('click', (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('button')) audio.uiClick();
    });
    document.addEventListener('mousedown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    // Clicking the dimmed area outside a container panel throws the held stack
    // into the world, mirroring Minecraft.
    for (const screen of ['inventoryScreen', 'craftingScreen', 'furnaceScreen', 'chestScreen']) {
      el(screen).addEventListener('mousedown', (e) => {
        // Only when the click misses the panel itself.
        if (e.target !== e.currentTarget) return;
        if (!this.hud.cursorStack) return;
        const stack = this.hud.cursorStack;
        this.hud.cursorStack = null;
        this.player.throwItem(stack.id, stack.count, this.entities, stack.durability, stack);
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
    this.player.onIgnitePortal = (x, y, z, igniter) => this._ignitePortal(x, y, z, igniter);
    this.player.onPortalTravel = (surface) => this._travelDimension(surface);

    // Decayed leaves scatter their drops on the ground rather than vanishing,
    // so a canopy you cut the trunk out of still gives you the saplings.
    this.world_onLeafDecayed = (x, y, z, block) => {
      if (this.particles) this.particles.blockBreak(x, y, z, block.id, 6);
      for (const bonus of block.bonusDrops ?? []) {
        if (Math.random() > bonus.chance) continue;
        const n = bonus.min + Math.floor(Math.random() * (bonus.max - bonus.min + 1));
        if (n > 0) this.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, bonus.id, n);
      }
    };

    // --- Effects ------------------------------------------------------------
    this.player.onLand = (fallDistance) => {
      if (!this.particles) return;
      const p = this.player.position;
      const ground = this.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
      // Harder landings kick up more, up to a cap so a long drop is not a cloud.
      const count = Math.min(14, 3 + Math.round(fallDistance * 1.6));
      this.particles.footDust(p.x, p.y, p.z, ground, count, 0.6);
    };

    this.player.onSplash = () => {
      const p = this.player.position;
      if (this.particles) this.particles.splash(p.x, p.y, p.z);
    };

    // Stepping on or off the board. The run total is only banked on dismount,
    // so this is also where a finished run gets announced.
    this.player.onBoardChanged = (riding, banked = 0) => {
      const p = this.player.position;
      const ground = this.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
      if (this.particles) this.particles.footDust(p.x, p.y, p.z, ground, 8, 0.5);
      if (riding) {
        this.hud.showToast('Rolling — jump and steer for tricks');
        this.achievements.unlock('skater');
      } else if (banked > 0) {
        this.hud.showToast(`Run banked: ${banked} style`);
      }
    };

    // Watched rather than pushed: the board is a scoring machine that reports
    // what happened, and this is the one place that turns that into progress.
    this.player.onTrickLanded = (tricks) => {
      for (const trick of tricks) {
        if (trick.name === '720 Spin') this.achievements.unlock('sevenTwenty');
        if (trick.name.includes('Grind')) this.achievements.unlock('grinder');
      }
    };

    // Feeding one is the whole interaction, so it gets a line of its own.
    this.player.onSustingusAttuned = (mob) => {
      this.hud.showToast('The sustingus is attuned to you');
      if (this.particles) {
        this.particles.sustain(mob.position.x, mob.position.y + 0.8, mob.position.z, 18);
      }
    };

    this.player.survival.onDamage((amount) => {
      if (amount <= 0) return;
      if (this.particles) {
        const p = this.player.eyePosition;
        this.particles.damage(p.x, p.y - 0.4, p.z, 6);
      }
      // Your wolves go for whatever just hit you. Set here rather than in the
      // wolf's own AI because this is the only place that knows who it was.
      const attacker = this.player.survival.lastDamageSource;
      if (!attacker || !this.entities) return;
      for (const mob of this.entities.mobs) {
        if (!mob.tamed || mob.sitting || mob.dead) continue;
        if (mob.horizontalDistanceTo(this.player.position) > mob.type.followRadius) continue;
        // `lastDamageSource` is a mob *type*; find the nearest one of them.
        mob.memory.target = this._nearestMobOfType(attacker, this.player.position, 12);
      }
    });

    this.player.onMobTamed = (mob) => {
      this.hud.showToast(`${mob.type.displayName} tamed — right click to sit or follow`);
      this.achievements.unlock('tamer');
      if (this.particles) {
        this.particles.sustain(mob.position.x, mob.position.y + 0.9, mob.position.z, 14);
      }
    };

    this.player.onMobSit = (mob) => {
      this.hud.showToast(mob.sitting ? 'Staying' : 'Following');
    };

    this.player.onBlockPlaced = () => this.stats.record('blocksPlaced');

    this.player.onFishCaught = (spot) => {
      // A catch pays a little experience, as in Minecraft.
      const eye = this.player.eyePosition;
      this.entities.spawnXp(eye.x, eye.y - 0.5, eye.z, xpBetween(1, 6));
      this.stats.record('fishCaught');
      this.achievements.unlock('angler');
      if (this.particles && spot) this.particles.splash(spot.x, spot.y, spot.z);
    };

    this.player.onSheared = () => this.achievements.unlock('shepherd');

    this.player.onBoatChanged = (aboard) => {
      const p = this.player.position;
      if (this.particles) this.particles.splash(p.x, p.y, p.z);
      if (aboard) {
        this.hud.showToast('Aboard — Space to step out');
        this.achievements.unlock('sailor');
      }
    };

    // The entity manager already rolled the boss loot table; this is just the
    // fanfare, and it retires the shrine so the Warden does not come back.
    this.entities.onBossDefeated = (mob) => {
      this.hud.showToast(`${mob.type.displayName} falls`);
      audio.explosion(mob.distanceTo(this.player.eyePosition), mob.position);
      if (mob.memory.shrineKey) this._shrinesDone.add(mob.memory.shrineKey);
      this.achievements.unlock('warden');
    };

    this.entities.onMobKilled = () => {
      this.stats.record('mobsDefeated');
      this.achievements.checkAll();
    };

    // Walking away must not cost you the boss: releasing the shrine key lets
    // `_maintainShrines` post a new guardian when you come back. The chest is
    // not refilled — that is tracked by the chest's own block entity.
    this.entities.onMobDespawn = (mob) => {
      if (mob.type.boss && mob.memory.shrineKey) this._shrinesDone.delete(mob.memory.shrineKey);
    };

    // Experience: orbs the player absorbs, and what levelling up sounds like.
    this.entities.onXpCollected = (points) => {
      this.player.gainXp(points);
      audio.xpOrb();
    };
    this.player.experience.onLevelUp = (level) => {
      audio.levelUp(level);
      this.achievements.notify('level', level);
    };
    // The enchanting table and the anvil report back for the advancements.
    this.onEnchanted = () => this.achievements.notify('enchanted', this.hud.enchantState.shelves);
    this.onAnvilUsed = () => this.achievements.notify('event', 'anvil');

    // Right-clicking a station opens its interface instead of placing a block.
    this.player.onUseStation = (blockId, x, y, z) => {
      if (blockId === CRAFTING_TABLE.id) {
        this._openContainer(() => this.hud.openCraftingTable());
        return true;
      }

      // --- Enchanting table and anvil ------------------------------------------
      if (blockId === ENCHANTING_TABLE.id) {
        const shelves = countBookshelves((bx, by, bz) => this.world.getBlock(bx, by, bz), x, y, z, BOOKSHELF.id);
        this._openContainer(() => this.hud.openEnchanting(shelves));
        return true;
      }
      if (blockId === ANVIL.id) {
        this._openContainer(() => this.hud.openAnvil());
        return true;
      }

      // --- The throne -------------------------------------------------------
      if (blockId === THRONE.id || blockId === THRONE_AWAKENED.id) {
        return this._useThrone(blockId, x, y, z);
      }

      // --- Doors: toggle open/closed ---------------------------------------
      if (isDoor(blockId)) {
        this._setDoorOpen(x, y, z, !isDoorOpen(blockId));
        return true;
      }

      // --- Beds -------------------------------------------------------------
      // Either half works; sleeping is anchored on the head end so you always
      // wake up at the same place whichever side you climbed in from.
      if (isBed(blockId)) {
        const head = this._bedHead(x, y, z);
        this._useBed(head.x, head.y, head.z);
        return true;
      }

      // --- Signs: read, or edit if it is still blank ------------------------
      if (blockId === SIGN.id) {
        this._openShared(x, y, z, () => ({
          type: 'sign',
          state: { lines: ['', '', '', ''] },
        }), (entity) => this.hud.openSign(entity.state));
        return true;
      }

      // --- Jukebox: put a record in, or take one out ------------------------
      if (blockId === JUKEBOX.id) return this._useJukebox(x, y, z);

      // --- Gravestones: take back what you died with ----------------------
      if (blockId === GRAVESTONE.id) return this._recoverGrave(x, y, z);

      // --- Chests -----------------------------------------------------------
      if (blockId === CHEST.id) {
        this._openShared(x, y, z, () => ({
          type: 'chest',
          state: { slots: new Array(27).fill(null) },
        }), (entity) => {
          audio.chest(true, { x: x + 0.5, y, z: z + 0.5 });
          this.hud.openChest(entity.state);
        });
        return true;
      }

      if (isFurnaceBlock(blockId)) {
        this._openShared(x, y, z, () => ({
          type: 'furnace',
          state: makeFurnaceState(),
          wasLit: false,
        }), (entity) => this.hud.openFurnace(entity.state));
        return true;
      }
      return false;
    };

    // Breaking a container spills its contents rather than deleting them. The
    // entity is handed in by the break itself — clearing the block drops it, so
    // it can no longer be looked up by position at this point.
    this.player.onBlockBroken = (blockId, target, entity, yielded = null) => {
      if (!target) return;
      if (this.particles) this.particles.blockBreak(target.x, target.y, target.z, blockId);

      // Ores that give up an item pay experience, unless taken whole.
      if (yielded?.harvested && !yielded.silked) {
        const range = MINING_XP.get(blockId);
        if (range) {
          this.entities.spawnXp(target.x + 0.5, target.y + 0.5, target.z + 0.5, xpBetween(range[0], range[1]));
        }
      }
      // A furnace spills the experience it was holding for you.
      if (entity && isFurnaceBlock(blockId) && entity.state.xp > 0) {
        this.entities.spawnXp(target.x + 0.5, target.y + 0.5, target.z + 0.5, roundXp(entity.state.xp));
      }
      // Cane comes down with whatever was holding it up, the broken block
      // included when that was cane.
      this._dropUnsupportedCane(target.x, target.y + 1, target.z);

      this.stats.record('blocksMined');
      this._notePlayerMilestone('mined', blockId, target);

      // Whatever will not fit falls on the floor instead of evaporating.
      // `addExisting` reports the leftover count, and ignoring it meant breaking
      // a full furnace or chest with a full inventory destroyed the difference.
      const recover = (stack) => {
        if (!stack) return;
        const leftover = this.player.inventory.addExisting(stack);
        if (leftover > 0) {
          this.entities.dropItem(
            target.x + 0.5, target.y + 0.5, target.z + 0.5,
            stack.id, leftover, stack.durability, stack
          );
        }
      };

      if (entity && isFurnaceBlock(blockId)) {
        for (const field of ['input', 'fuel', 'output']) recover(entity.state[field]);
      } else if (entity && blockId === CHEST.id) {
        for (const stack of entity.state.slots) recover(stack);
      } else if (entity && blockId === GRAVESTONE.id) {
        for (const stack of entity.state.slots) recover(stack);
        if (entity.state.xp > 0) {
          this.entities.spawnXp(target.x + 0.5, target.y + 0.5, target.z + 0.5, entity.state.xp);
        }
        this._forgetGrave(target.x, target.y, target.z);
      } else if (entity && blockId === JUKEBOX.id && entity.state.disc) {
        // Breaking a loaded jukebox gives the record back and stops the music.
        recover({ id: entity.state.disc, count: 1 });
        audio.stopMusic();
        this._playingJukebox = null;
      }

      // Breaking part of a frame collapses the whole portal, so a portal can
      // never outlive its ring. Matched against the kind whose frame this is,
      // so knocking a hole in an obsidian wall cannot put out an Aether portal
      // that happens to be next to it.
      const frameKind = portalKindForFrame(blockId);
      if (frameKind) {
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          const nx = target.x + dx, ny = target.y + dy, nz = target.z + dz;
          if (this.world.getBlock(nx, ny, nz) === frameKind.surface) {
            extinguishPortal(this.world, nx, ny, nz);
          }
        }
      }

      // A door is two blocks; breaking either half removes both. Matched on
      // facing so a door does not take a different door stacked above it.
      if (isDoor(blockId)) {
        const facing = getBlock(blockId).doorFacing;
        for (const dy of [-1, 1]) {
          const other = this.world.getBlock(target.x, target.y + dy, target.z);
          if (isDoor(other) && getBlock(other).doorFacing === facing) {
            this.world.setBlock(target.x, target.y + dy, target.z, 0);
          }
        }
      }

      // And a bed is two blocks laid end to end.
      if (isBed(blockId)) this._clearBedPair(target.x, target.y, target.z, blockId);
    };
  }

  /**
   * Light a combium portal with a bucket of milk.
   * @returns {boolean} whether a valid frame was found and filled
   */
  _ignitePortal(x, y, z, igniter) {
    const kind = portalKindForIgniter(igniter);
    if (!kind) return false;

    const result = ignitePortal(this.world, x, y, z, kind);
    if (!result) {
      // Silent when the thing you clicked is not that kind's frame at all —
      // otherwise every splash of water on stone would complain about frames.
      // Only a *frame block* that failed to form a portal is worth a message.
      if (this.world.getBlock(x, y, z) === kind.frame) {
        this.hud.showToast('The frame is not complete');
      }
      return false;
    }
    audio.ignite();
    this.hud.showToast(`${kind.name} opens`);
    this._rememberPortal(kind.id, x, y, z);
    this.achievements.unlock('portal');
    return true;
  }

  /**
   * Travel through a portal.
   *
   * The arrival position is derived from the departure by a coordinate scale,
   * so the two dimensions stay roughly aligned and a portal built in one place
   * always lands you near the same spot in the other.
   */
  async _travelDimension(surfaceId = null) {
    if (this._travelling) return;
    this._travelling = true;

    const from = this.world.dimension;
    // Where you go is read off the portal you stepped into, not off where you
    // are — with three destinations "the other one" is no longer a question
    // with an answer.
    const to = destinationOf(from, surfaceId);
    // The kind to build on the far side is the one that gets you *back*: from
    // the Overworld that is the portal you came through, and from anywhere else
    // it is that dimension's own.
    const kind = kindForDimension(to === DIMENSIONS.OVERWORLD ? from : to);

    const goingOut = to !== DIMENSIONS.OVERWORLD;
    const scale = goingOut ? 1 / DIMENSION_SCALE : DIMENSION_SCALE;

    const targetX = Math.round(this.player.position.x * scale);
    const targetZ = Math.round(this.player.position.z * scale);

    this._setState('loading');
    el('loadingFill').style.width = '0%';
    this.entities.clear();

    await this.world.setDimension(to);
    this.dimension = to;
    this.dynamicLight.clear();
    this._applyFarTerrain();

    // Stream the arrival area before deciding where the ground is.
    await this._preloadAround(targetX, targetZ);

    // Land on solid ground, then build a return portal around it.
    const landingY = this._findLanding(to, targetX, targetZ);
    const built = buildReturnPortal(this.world, targetX, landingY, targetZ, kind);

    this.player.position.set(built.stand.x, built.stand.y, built.stand.z);
    this._rememberPortal(kind.id, built.stand.x, built.stand.y, built.stand.z);
    this.player.velocity.set(0, 0, 0);
    this.player.fallDistance = 0;
    // Do not immediately bounce back through the portal we just arrived in.
    this.player._portalCooldown = 4;
    this.player.portalCharge = 0;
    this.player._portalArmed = true;

    this._applyDimensionLook();
    // Signs belong to the dimension they are in; the other world's meshes must
    // not be left hanging in this one.
    if (this.signRenderer) this.signRenderer.clear();
    this._setState('playing');
    this.input.requestLock();
    this.hud.showToast(dimensionInfo(to).name);
    if (to === DIMENSIONS.COMB) this.achievements.unlock('comb');
    if (to === DIMENSIONS.NETHER) this.achievements.unlock('nether');
    if (to === DIMENSIONS.AETHER) this.achievements.unlock('aether');
    // A teleport is not a walk, so the distance counter must not bank it.
    this._lastProgressPos = null;
    this._travelling = false;
    this.saveWorld();
  }

  /**
   * Where to put a return portal in the dimension being arrived in.
   *
   * `getSurfaceY` finds the topmost solid block in a column, which is the right
   * answer in a world with sky above it and the wrong one anywhere else. The
   * Nether has a *bedrock roof*, so the topmost solid block is the ceiling and
   * a portal built on it lands you on top of the world. The Aether is mostly
   * open air, so a column often has no solid block at all.
   *
   * Each dimension therefore searches its own way down through its own volume.
   */
  _findLanding(dimension, x, z) {
    const fits = (y) =>
      getBlock(this.world.getBlock(x, y, z)).solid &&
      this.world.getBlock(x, y + 1, z) === 0 &&
      this.world.getBlock(x, y + 2, z) === 0;

    if (dimension === DIMENSIONS.NETHER) {
      // Down from just under the roof, and never below the lava.
      for (let y = NETHER_CEILING - 3; y > NETHER_LAVA_LEVEL; y--) {
        if (fits(y)) return y + 1;
      }
      // Nothing open in this column: carve in above the lava. `buildReturnPortal`
      // clears its own pocket and lays footing, so this is always survivable.
      return NETHER_LAVA_LEVEL + 8;
    }

    if (dimension === DIMENSIONS.AETHER) {
      for (let y = ISLAND_BAND + ISLAND_SPREAD; y > AETHER_VOID; y--) {
        if (fits(y)) return y + 1;
      }
      // Open sky. The portal builds its own floor, so this hangs an island.
      return ISLAND_BAND;
    }

    const surface = this.world.getSurfaceY(x, z);
    return surface >= 1 ? surface + 1 : 64;
  }

  /**
   * Populate any shrine near the player that has not been stocked yet.
   *
   * The generator builds the structure; this fills its chest and posts the
   * Warden. Doing it here rather than in the worker keeps loot rolls and mob
   * spawning on the thread that owns entities, and `_shrinesDone` (saved with
   * the world) means a shrine is only ever stocked once.
   */
  _maintainShrines(dt) {
    if (this.world.dimension !== DIMENSIONS.COMB) return;

    this._shrineTimer -= dt;
    if (this._shrineTimer > 0) return;
    this._shrineTimer = 2;

    // Shrine placement is a pure function of the seed, so their positions can be
    // asked for directly instead of hunting for thrones block by block. This
    // generator is only ever used for `shrineAt` — it never generates a chunk.
    if (!this._shrineOracle) this._shrineOracle = new CombTerrainGenerator(this.world.seed);

    const pcx = Math.floor(this.player.position.x / 16);
    const pcz = Math.floor(this.player.position.z / 16);
    // Anchors are SHRINE_SPACING chunks apart on a grid offset from the origin,
    // so ask the generator where the nearest one is rather than assuming they
    // land on multiples. One grid step either way covers render range.
    const step = SHRINE_SPACING;
    const [originX, originZ] = nearestShrineAnchor(pcx, pcz);

    for (let gz = -1; gz <= 1; gz++) {
      for (let gx = -1; gx <= 1; gx++) {
        const shrine = this._shrineOracle.shrineAt(originX + gx * step, originZ + gz * step);
        if (!shrine) continue;

        const key = `${shrine.wx},${shrine.wz}`;
        if (this._shrinesDone.has(key)) continue;

        // Only act once the structure is actually streamed in, or the throne
        // check below reads unloaded air and the shrine is skipped forever.
        const t = SHRINE_LAYOUT.throne;
        const tx = shrine.wx + t.dx, ty = shrine.y + t.dy, tz = shrine.wz + t.dz;
        if (!this.world.isChunkLoaded(tx, tz)) continue;
        if (this.world.getBlock(tx, ty, tz) !== THRONE.id) continue;

        this._shrinesDone.add(key);
        this._stockShrine(shrine, key);
      }
    }
  }

  /**
   * Stock any dungeon chest near the player that has not been filled yet.
   *
   * Same shape as `_maintainShrines`: the generator builds the room, this fills
   * it, and `_shrinesDone` (saved with the world) makes sure a chest is only
   * ever rolled once. Positions come straight from the seeded generator, so no
   * searching is needed.
   */
  _maintainDungeons(dt) {
    if (this.world.dimension !== DIMENSIONS.OVERWORLD || !this.terrainInfo) return;
    if (!this.terrainInfo.dungeonAt) return;

    this._dungeonTimer -= dt;
    if (this._dungeonTimer > 0) return;
    this._dungeonTimer = 2;

    const pcx = Math.floor(this.player.position.x / 16);
    const pcz = Math.floor(this.player.position.z / 16);
    const step = DUNGEON_SPACING;
    const originX = Math.floor(pcx / step) * step;
    const originZ = Math.floor(pcz / step) * step;

    for (let gz = -1; gz <= 1; gz++) {
      for (let gx = -1; gx <= 1; gx++) {
        const room = this.terrainInfo.dungeonAt(originX + gx * step, originZ + gz * step);
        if (!room) continue;

        const key = `d:${room.wx},${room.wz}`;
        if (this._shrinesDone.has(key)) continue;
        if (!this.world.isChunkLoaded(room.wx, room.wz)) continue;

        // Only once the room is actually streamed in — otherwise the chest
        // lookup reads unloaded air and the dungeon is skipped for good.
        const stocked = this._stockDungeon(room);
        if (stocked) this._shrinesDone.add(key);
      }
    }
  }

  /**
   * The throne. This is what the Comb is *for*.
   *
   * Setting a Comb Heart into it — and the only Hearts come off the Warden that
   * guards the shrine — awakens the throne permanently: it lights up, hands over
   * the Crown, and raises your maximum health for good. One per throne, and
   * thrones are hundreds of blocks apart, so each one is an event.
   */
  /**
   * Open or close a door, both halves together.
   *
   * The facing is preserved and only the open bit changes, so a door swings
   * back to exactly where it was rather than snapping to a fixed orientation.
   * @returns true if anything moved
   */
  _setDoorOpen(x, y, z, open) {
    const here = this.world.getBlock(x, y, z);
    if (!isDoor(here)) return false;
    if (isDoorOpen(here) === open) return false;

    const facing = getBlock(here).doorFacing;
    const want = doorBlock(facing, open).id;
    this.world.setBlock(x, y, z, want);

    // Doors are two blocks tall; keep both halves in step. Only a half with the
    // *same* facing counts, so two doors stacked in a doorway stay independent.
    for (const dy of [-1, 1]) {
      const other = this.world.getBlock(x, y + dy, z);
      if (!isDoor(other) || getBlock(other).doorFacing !== facing) continue;
      this.world.setBlock(x, y + dy, z, want);
    }

    audio.door(open, { x: x + 0.5, y, z: z + 0.5 });
    return true;
  }

  /**
   * The head end of the bed one of whose halves is at (x, y, z).
   *
   * Sleeping, breaking and the spawn point all key off the head, so there is
   * one answer no matter which half you interacted with.
   */
  _bedHead(x, y, z) {
    const id = this.world.getBlock(x, y, z);
    const block = getBlock(id);
    if (!isBed(id) || block.bedHead) return { x, y, z };
    const { dx, dz } = FACINGS[block.bedFacing];
    // Only if the neighbour really is this bed's other half.
    const other = this.world.getBlock(x + dx, y, z + dz);
    if (isBed(other) && getBlock(other).bedHead) return { x: x + dx, y, z: z + dz };
    return { x, y, z };
  }

  /** Remove whichever half of a bed is left after the other was broken. */
  _clearBedPair(x, y, z, brokenId) {
    const block = getBlock(brokenId);
    if (!isBed(brokenId)) return;
    const { dx, dz } = FACINGS[block.bedFacing];
    // The foot's partner is one step along the facing; the head's is one back.
    const px = x + (block.bedHead ? -dx : dx);
    const pz = z + (block.bedHead ? -dz : dz);
    const partner = this.world.getBlock(px, y, pz);
    if (!isBed(partner)) return;
    if (getBlock(partner).bedFacing !== block.bedFacing) return;
    if (getBlock(partner).bedHead === block.bedHead) return;
    this.world.setBlock(px, y, pz, 0);
  }

  /**
   * A jukebox holds exactly one record.
   *
   * Empty and holding a record: it goes in and starts playing. Loaded: the
   * record pops out and the music stops. One button, both directions — the same
   * shape as every other right-click interaction in the game.
   */
  _useJukebox(x, y, z) {
    const entity = this.world.getBlockEntity(x, y, z, () => ({
      type: 'jukebox',
      state: { disc: 0 },
    }));

    if (entity.state.disc) {
      // Eject. Whatever will not fit lands on the floor rather than vanishing.
      const id = entity.state.disc;
      entity.state.disc = 0;
      this.world.touchBlockEntity(x, y, z);
      audio.stopMusic();
      this._playingJukebox = null;
      const left = this.player.inventory.add(id, 1);
      if (left > 0) this.player.throwItem(id, left, this.entities);
      this.hud.showToast(`${getDisplayName(id)} ejected`);
      return true;
    }

    const slot = this.player.inventory.getSelected();
    const item = slot ? getItem(slot.id) : null;
    if (!item || !item.disc) {
      this.hud.showToast('The jukebox is empty');
      return true;
    }

    entity.state.disc = slot.id;
    this.world.touchBlockEntity(x, y, z);
    this.player.inventory.consumeSelected(1);
    audio.playMusic(item.disc);
    this._playingJukebox = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    this.hud.showToast(`Now playing: ${item.displayName}`);
    this.stats.record('discsPlayed');
    this.achievements.unlock('dj');
    return true;
  }

  _useThrone(blockId, x, y, z) {
    if (blockId === THRONE_AWAKENED.id) {
      this.hud.showToast('The throne is already awake');
      return true;
    }

    const held = this.player.inventory.getSelected();
    if (!held || held.id !== ITEM_ID.COMB_HEART) {
      this.hud.showToast('The throne is cold. Something is missing.');
      return true;
    }

    this.world.setBlock(x, y, z, THRONE_AWAKENED.id);
    if (!this.player.creative) this.player.inventory.consumeSelected(1);

    // The permanent reward. Recorded on the player so it saves and survives
    // death, and applied additively so a second throne stacks.
    this.player.survival.maxHealth += THRONE_HEALTH_BONUS;
    this.player.survival.health = this.player.survival.maxHealth;

    this.player.inventory.add(ITEM_ID.CROWN, 1);

    audio.ignite();
    audio.mobSound({ name: 'throne', voice: 'hum', pitch: 120, duration: 1.4 }, 'idle', 0);
    this.hud.showToast('The throne awakens. You are crowned.');
    this.achievements.unlock('throne');

    if (this.particles) {
      for (let i = 0; i < 5; i++) this.particles.portalMotes(x, y + 1, z, 6);
      this.particles.explosion(x + 0.5, y + 1.5, z + 0.5, 24);
    }

    this.saveWorld();
    return true;
  }

  /**
   * Stock any hive cache near the player.
   *
   * Same pattern as shrines and dungeons: the generator builds it, this fills
   * it once, and `_shrinesDone` (saved with the world) remembers which.
   */
  _maintainHives(dt) {
    if (this.world.dimension !== DIMENSIONS.COMB || !this._shrineOracle) return;

    this._hiveTimer -= dt;
    if (this._hiveTimer > 0) return;
    this._hiveTimer = 2.5;

    const pcx = Math.floor(this.player.position.x / 16);
    const pcz = Math.floor(this.player.position.z / 16);
    const step = HIVE_SPACING;
    const originX = Math.round(pcx / step) * step;
    const originZ = Math.round(pcz / step) * step;

    for (let gz = -1; gz <= 1; gz++) {
      for (let gx = -1; gx <= 1; gx++) {
        const hive = this._shrineOracle.hiveAt(originX + gx * step, originZ + gz * step);
        if (!hive) continue;

        const key = `h:${hive.wx},${hive.wz}`;
        if (this._shrinesDone.has(key)) continue;
        if (!this.world.isChunkLoaded(hive.wx, hive.wz)) continue;
        if (this.world.getBlock(hive.wx, hive.y, hive.wz) !== CHEST.id) continue;

        this._shrinesDone.add(key);
        if (this.world.getBlockEntity(hive.wx, hive.y, hive.wz)) continue;
        const entity = this.world.getBlockEntity(hive.wx, hive.y, hive.wz, () => ({
          type: 'chest',
          state: { slots: new Array(27).fill(null) },
        }));
        fillChest(entity.state.slots, HIVE_LOOT);
      }
    }
  }

  /** Fill a dungeon's chests. Returns false if the room has not loaded yet. */
  _stockDungeon(room) {
    const { wx, wz, y, halfX, halfZ } = room;
    const spots = [
      [wx - halfX, y, wz - halfZ + 1],
      [wx + halfX, y, wz + halfZ - 1],
    ];

    let found = 0;
    for (const [x, cy, z] of spots) {
      if (this.world.getBlock(x, cy, z) !== CHEST.id) continue;
      found++;
      if (this.world.getBlockEntity(x, cy, z)) continue; // already looted
      const entity = this.world.getBlockEntity(x, cy, z, () => ({
        type: 'chest',
        state: { slots: new Array(27).fill(null) },
      }));
      fillChest(entity.state.slots, DUNGEON_LOOT);
    }
    return found > 0;
  }

  /**
   * The nearest Comb shrine to the player, or null.
   *
   * Shrine placement is a pure function of the seed, so this walks the anchor
   * grid outward and asks — no chunk needs to be loaded, and the answer is exact
   * rather than "somewhere over there". The search widens until it finds one, so
   * the compass works from anywhere including the overworld.
   *
   * Cached per position, because the HUD asks several times a second and the
   * answer only changes when you move to a different grid cell.
   */
  nearestShrine() {
    if (!this._shrineOracle) {
      if (!this.world) return null;
      this._shrineOracle = new CombTerrainGenerator(this.world.seed);
    }

    const pcx = Math.floor(this.player.position.x / 16);
    const pcz = Math.floor(this.player.position.z / 16);
    const cacheKey = `${Math.floor(pcx / SHRINE_SPACING)},${Math.floor(pcz / SHRINE_SPACING)}`;
    if (this._shrineCacheKey === cacheKey) return this._shrineCache;

    const [ax, az] = nearestShrineAnchor(pcx, pcz);
    let best = null;
    let bestDistance = Infinity;

    // Ring search outward from the player's own anchor. Six rings covers about
    // 3000 blocks, which is far beyond any gap between shrines.
    for (let ring = 0; ring <= 6 && !best; ring++) {
      for (let gz = -ring; gz <= ring; gz++) {
        for (let gx = -ring; gx <= ring; gx++) {
          // Only the perimeter of each ring; the interior was covered already.
          if (ring > 0 && Math.abs(gx) !== ring && Math.abs(gz) !== ring) continue;

          const shrine = this._shrineOracle.shrineAt(
            ax + gx * SHRINE_SPACING, az + gz * SHRINE_SPACING
          );
          if (!shrine) continue;

          const distance = Math.hypot(
            shrine.wx - this.player.position.x, shrine.wz - this.player.position.z
          );
          if (distance < bestDistance) { best = shrine; bestDistance = distance; }
        }
      }
    }

    this._shrineCacheKey = cacheKey;
    this._shrineCache = best;
    return best;
  }

  /** Fill a shrine's chest and post its guardian. */
  _stockShrine(shrine, key) {
    const { wx, wz, y } = shrine;

    const c = SHRINE_LAYOUT.chest;
    const cx = wx + c.dx, cy = y + c.dy, cz = wz + c.dz;
    if (this.world.getBlock(cx, cy, cz) === CHEST.id) {
      // Only stock a chest that has never had state. A chest the player already
      // opened has one, so leaving and returning cannot farm the shrine.
      if (!this.world.getBlockEntity(cx, cy, cz)) {
        const entity = this.world.getBlockEntity(cx, cy, cz, () => ({
          type: 'chest',
          state: { slots: new Array(27).fill(null) },
        }));
        fillChest(entity.state.slots, THRONE_LOOT);
      }
    }

    // One Warden per shrine, standing in front of the throne.
    const g = SHRINE_LAYOUT.guardian;
    const warden = this.entities.spawnMob(WARDEN, wx + g.dx, y + g.dy, wz + g.dz);
    warden.memory.home = { x: wx + 0.5, y: y + 1, z: wz + 0.5 };
    warden.memory.shrineKey = key;
    this.hud.showToast('Something guards this place');
  }

  /** Nearest living mob of a given type within `radius`, or null. */
  _nearestMobOfType(type, point, radius) {
    let best = null;
    let bestDistance = radius;
    for (const mob of this.entities.mobs) {
      if (mob.dead || mob.type !== type) continue;
      const distance = mob.horizontalDistanceTo(point);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = mob;
    }
    return best;
  }

  /**
   * The counters that only a running frame can see: how far you have walked,
   * how many days you have lasted, and how loud the jukebox should be.
   */
  _updateProgress(dt) {
    const p = this.player.position;
    if (this._lastProgressPos) {
      // Horizontal only, so standing in a lift does not count as a journey.
      const moved = Math.hypot(p.x - this._lastProgressPos.x, p.z - this._lastProgressPos.z);
      // Ignore teleports (portals, respawns) — they are not travel.
      if (moved < 4) this.stats.record('distance', moved);
      this._lastProgressPos.set(p.x, p.y, p.z);
    } else {
      this._lastProgressPos = p.clone();
    }

    this.stats.recordBest('days', Math.floor(this.sky.dayCount ?? 0));
    this.stats.recordBest('bestCombo', this.player.board.lastBanked ?? 0);
    this.stats.values.style = this.player.board.totalStyle;
    this.achievements.checkAll();

    // The record fades with distance from the box that is playing it.
    if (audio.musicPlaying) {
      if (this._playingJukebox) {
        const j = this._playingJukebox;
        audio.setMusicDistance(Math.hypot(p.x - j.x, p.y - j.y, p.z - j.z));
      }
    }
  }

  /**
   * Turn a game event into whatever achievements it implies.
   *
   * Collected here rather than scattered through the handlers so the list of
   * "what counts" is one thing to read, and so adding an achievement does not
   * mean hunting through main.js for the right call site.
   */
  _notePlayerMilestone(kind, id, target) {
    if (kind === 'mined') {
      if (id === LOG.id || id === ACACIA_LOG.id || id === SPRUCE_LOG.id) {
        this.achievements.unlock('wood');
      }
      if (id === DIAMOND_ORE.id) this.achievements.unlock('diamonds');
      if (id === OBSIDIAN.id) this.achievements.unlock('obsidian');
      if (id === GLOWSTONE.id) this.achievements.unlock('glowstone');
      if (target && target.y <= 5) this.achievements.unlock('deep');
    } else if (kind === 'crafted') {
      this.stats.record('itemsCrafted');
      if (id === CRAFTING_TABLE.id) this.achievements.unlock('bench');
      if (id === FURNACE.id) this.achievements.unlock('furnace');
      if (id === ITEM_ID.BREAD) this.achievements.unlock('farmer');
      const item = getItem(id);
      if (item && item.tool && item.tool.kind === 'pickaxe') this.achievements.unlock('pickaxe');
    } else if (kind === 'smelted') {
      if (id === ITEM_ID.IRON_INGOT) this.achievements.unlock('iron');
      if (id === ITEM_ID.COMBIUM_INGOT) this.achievements.unlock('combium');
    }
    // Advancements that describe their own trigger (content packs) hear it too.
    const thing = getThing(id);
    if (thing) this.achievements.notify(kind, thing.name);
    this.achievements.checkAll();
  }

  /**
   * Pressure plates.
   *
   * A plate remembers the doors *it* opened and closes exactly those, so a door
   * you opened by hand is not slammed shut when someone steps off a plate three
   * blocks away. Mobs press plates too — a wandering pig letting itself in is
   * the sort of thing worth keeping.
   */
  _updatePressurePlates() {
    const pressed = new Set();
    // The cell the feet are *in*, not the one below them: a plate is a thin
    // non-solid block you stand inside, so you rest on whatever is under it and
    // occupy the plate's own cell.
    const feet = (pos) => `${Math.floor(pos.x)},${Math.floor(pos.y + 0.01)},${Math.floor(pos.z)}`;

    const standers = [this.player.position];
    if (this.entities) {
      for (const mob of this.entities.mobs) if (!mob.dead) standers.push(mob.position);
    }
    for (const pos of standers) {
      const key = feet(pos);
      const [x, y, z] = key.split(',').map(Number);
      if (isPlate(this.world.getBlock(x, y, z))) pressed.add(key);
    }

    // Newly stepped on.
    for (const key of pressed) {
      if (this._platesDown.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      this.world.setBlock(x, y, z, PRESSURE_PLATE_PRESSED.id);
      this._platesDown.set(key, this._setNeighbourDoors(x, y, z, true));
      audio.door(true, { x: x + 0.5, y, z: z + 0.5 });
    }

    // Newly stepped off.
    for (const [key, opened] of this._platesDown) {
      if (pressed.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      // Only restore a plate that is still a plate — it may have been mined.
      if (isPlate(this.world.getBlock(x, y, z))) {
        this.world.setBlock(x, y, z, PRESSURE_PLATE.id);
        audio.door(false, { x: x + 0.5, y, z: z + 0.5 });
      }
      for (const [dx, dy, dz] of opened) this._setDoorOpen(dx, dy, dz, false);
      this._platesDown.delete(key);
    }
  }

  /**
   * Open or close every door touching a plate.
   * @returns the positions actually changed, so they can be undone later.
   */
  _setNeighbourDoors(x, y, z, opening) {
    const changed = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // Doors are two tall, and a plate can sit level with either half.
      // `_setDoorOpen` moves both halves, so only the one it reports is
      // recorded — otherwise stepping off would try to close the same door
      // twice and the second call would be a no-op anyway.
      for (const dy of [0, 1, -1]) {
        const bx = x + dx, by = y + dy, bz = z + dz;
        const id = this.world.getBlock(bx, by, bz);
        if (!isDoor(id) || isDoorOpen(id) === opening) continue;
        if (this._setDoorOpen(bx, by, bz, opening)) changed.push([bx, by, bz]);
      }
    }
    return changed;
  }

  /**
   * Continuous effects — the ones that depend on what the player is doing this
   * frame rather than on a discrete event.
   */
  _updateEffects(dt) {
    if (!this.particles) return;
    const player = this.player;

    // Chips fly off the face being mined, paced on a timer so the rate does not
    // scale with framerate.
    this._miningPuffTimer = (this._miningPuffTimer ?? 0) - dt;
    if (player.breakProgress > 0 && player.targetBlock && this._miningPuffTimer <= 0) {
      this._miningPuffTimer = 0.12;
      const t = player.targetBlock;
      this.particles.blockHit(t.x, t.y, t.z, t.block, t.normal);
    }

    // Dust off the heels while sprinting on the ground.
    this._sprintDustTimer = (this._sprintDustTimer ?? 0) - dt;
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.onGround && !player.inLiquid && speed > 5.2 && this._sprintDustTimer <= 0) {
      this._sprintDustTimer = 0.1;
      const p = player.position;
      const ground = this.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
      this.particles.footDust(p.x, p.y, p.z, ground, 2, 0.35);
    }

    // Spore drift: the Comb has no weather, so this is what stops its air
    // reading as completely dead. Gated on the dimension rather than added to
    // the weather system, which is about precipitation you can shelter from.
    if (this.world.dimension === DIMENSIONS.COMB) {
      this._sporeTimer = (this._sporeTimer ?? 0) - dt;
      if (this._sporeTimer <= 0) {
        this._sporeTimer = 0.09;
        const p = player.position;
        for (let n = 0; n < 2; n++) {
          this.particles.spore(
            p.x + (Math.random() - 0.5) * 26,
            p.y + Math.random() * 12 - 2,
            p.z + (Math.random() - 0.5) * 26
          );
        }
      }
    }

    // Leaves, fireflies, ash and sparkles, and bubbles when you are under.
    this.particles.ambient(dt, {
      dimension: this.world.dimension,
      isNight: this.sky.isNight,
      player,
      underwater: player.headUnderwater,
      rain: !!this.weather.falling,
    });

    // Motes drifting off any portal within a few blocks.
    this._portalMoteTimer = (this._portalMoteTimer ?? 0) - dt;
    if (this._portalMoteTimer <= 0) {
      this._portalMoteTimer = 0.18;
      const p = player.position;
      const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
      search:
      for (let dy = -2; dy <= 3; dy++) {
        for (let dz = -4; dz <= 4; dz++) {
          for (let dx = -4; dx <= 4; dx++) {
            if (this.world.getBlock(px + dx, py + dy, pz + dz) !== PORTAL.id) continue;
            this.particles.portalMotes(px + dx, py + dy, pz + dz, 1);
            break search;
          }
        }
      }
    }
  }

  /**
   * Ambient sound bed — wind, cave drone, rain hiss.
   *
   * "Underground" is decided by comparing the player against the surface height
   * of their own column, which is the same test the weather uses for shelter,
   * so stepping under a roof and stepping into a cave behave consistently.
   */
  _updateAmbience(dt) {
    if (dt <= 0) return;

    const p = this.player.position;
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
    const surface = this.world.getSurfaceY(px, pz);

    // A few blocks of tolerance, so standing on the surface is not "indoors".
    const covered = surface > py + 1;
    const underground = covered && py < surface - 4;

    // Tunnels and caves ring; a roof overhead rings a little.
    audio.setEnclosure(underground ? 1 : covered ? 0.35 : 0);

    audio.ambience({
      underground,
      depth: py,
      dimension: this.world.dimension,
      indoors: covered && !underground,
    });

    // Rain is only audible when the sky above you is actually open.
    audio.rain(this.weather.falling && !covered ? this.weather.intensity : 0,
               this.weather.falling === 'snow');

    // Sparse one-shots down in the dark.
    this._caveSoundTimer -= dt;
    if (this._caveSoundTimer <= 0) {
      this._caveSoundTimer = 14 + Math.random() * 34;
      if (underground) audio.caveSound(py);
    }
  }

  /** Sky, fog and ambient light for the current dimension. */
  _applyDimensionLook() {
    const info = dimensionInfo(this.world.dimension);
    this.sky.setDimension(info);
    // The menus take their accent colour from where you are.
    document.documentElement.dataset.dimension = this.world.dimension;
    // Distant terrain is Overworld-only; this catches respawns and the title screen.
    this._applyFarTerrain();
  }

  /**
   * Sleeping. Sets your spawn point, and skips to dawn if it is actually night
   * and nothing hostile is nearby — the same conditions Minecraft imposes, so a
   * bed is not simply a "skip the danger" button.
   */
  _useBed(x, y, z) {
    // Only the Overworld has nights to skip and a spawn point to return to.
    if (this.world.dimension !== DIMENSIONS.OVERWORLD) {
      this.hud.showToast('Beds only work in the Overworld');
      return;
    }
    if (!this.player.bedSpawn) this.player.bedSpawn = this.player.spawnPoint.clone();
    this.player.bedSpawn.set(x + 0.5, y + 1, z + 0.5);

    // In someone else's world the clock is theirs (net/session.js).
    if (this.net?.role === 'guest') {
      this.hud.showToast('Spawn point set. Only the host can sleep the night away');
      return;
    }

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

    // Wind forward to just after sunrise and restore a little health. Routed
    // through `skipToNextPhase` rather than setting the clock directly, so a
    // night slept through still counts toward the days-survived statistic.
    this.sky.skipToNextPhase();
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
    // An invite link (?join=CODE) opens the join form with the code filled in.
    const invite = normalizeCode(new URLSearchParams(location.search).get('join'));
    if (isCode(invite)) {
      this._showJoinForm(true);
      el('joinCode').value = formatCode(invite);
      (el('joinName').value ? el('joinConfirmButton') : el('joinName')).focus();
    }
  }

  async _showWorldScreen() {
    this._startPanorama();
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
      const thumb = document.createElement('div');
      thumb.className = 'wthumb';
      if (world.thumbnail) thumb.style.backgroundImage = `url(${world.thumbnail})`;
      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML =
        `<div class="wname">${escapeHtml(world.name)}` +
        (world.allowCreative ? '<span class="badge">Creative</span>' : '') +
        (world.tooNew ? '<span class="badge warn">Newer version</span>' : '') +
        '</div>' +
        `<div class="wmeta">Day ${world.dayCount + 1} &middot; ${DIFFICULTIES[world.difficulty]?.label ?? 'Normal'} &middot; ${played}m played &middot; seed ${world.seed} &middot; ` +
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

      row.append(thumb, info, play, exportBtn, del);
      if (!world.tooNew) row.addEventListener('click', () => this._openWorld(world.id));
      list.appendChild(row);
    }
  }

  _showCreateForm(show) {
    el('newWorldForm').style.display = show ? '' : 'none';
    el('joinForm').style.display = 'none';
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

  _setCreateDifficulty(id) {
    this._createDifficulty = id;
    for (const key of Object.keys(DIFFICULTIES)) el(`diff-${key}`)?.classList.toggle('selected', key === id);
    el('difficultyNote').textContent = DIFFICULTIES[id].blurb;
  }

  /**
   * Change the world's difficulty. Peaceful sends the monsters away at once,
   * rather than as they happen to wander off.
   */
  setDifficulty(id, announce = true) {
    this.difficultyId = applyDifficulty(id);
    el('difficultyButton').textContent = `Difficulty: ${difficulty.rules.label}`;
    if (!difficulty.rules.hostiles) this.entities.clearHostiles();
    if (announce) this.hud.showToast(`Difficulty: ${difficulty.rules.label}`);
  }

  async _createWorld() {
    const name = el('newWorldName').value.trim() || 'New World';
    const seed = this._parseSeed(el('newWorldSeed').value);
    const save = SaveManager.createNew(name, seed, this._createCreative === true);
    save.difficulty = this._createDifficulty ?? 'normal';
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
  async _startSession(save, isNew, options = {}) {
    this._setState('loading');
    el('loadingFill').style.width = '0%';

    // Someone else's world (multiplayer) arrives as a save too, but is never
    // written to this browser; opening one of your own ends any game with others.
    const remote = options.remote === true;
    if (!remote) this._endNet();
    this.remoteWorld = remote;
    this.guestRecords = {};
    this._openEntity = null;

    // Tear down any previous session, including its worker, and the title
    // screen's world if that is what was loaded.
    if (this.world) this.world.dispose();
    this._panorama = null;
    this._panoramaWorld = false;
    this.entities.clear();

    this.world = new World(this.renderer.scene, {
      seed: save.seed,
      terrainVersion: save.terrainVersion,
    });
    this.world.setFastLeaves(this.renderer.quality === 'low');
    this.farTerrain.start(save.seed, save.terrainVersion);
    this._applyFarTerrain();
    this.player.world = this.world;
    this.entities.world = this.world;
    this.terrainInfo = new TerrainGenerator(save.seed, save.terrainVersion);

    // Effects are tied to the world they collide against, so they are rebuilt
    // with it rather than carried over.
    if (this.particles) this.particles.dispose();
    this.particles = new ParticleSystem(this.renderer.scene, this.world);
    if (this.signRenderer) this.signRenderer.dispose();
    this.signRenderer = new SignRenderer(this.renderer.scene, this.world);
    this.entities.particles = this.particles;
    this.world.onLeafDecayed = this.world_onLeafDecayed;
    // The map records chunks as they stream in, and follows edits.
    this.world.onChunkVoxels = (chunk) => this.exploration.record(this.world.dimension, chunk);
    this.world.onColumnChanged = (wx, wz, chunk, wy) => {
      this.exploration.updateColumn(this.world.dimension, chunk, wx, wz);
      this.dynamicLight.markDirty(wx, wy, wz);
    };
    this.dynamicLight.clear();
    this.captions.clear();
    this._netherInfo = null;
    this.world.onSmelted = (itemId) => this._notePlayerMilestone('smelted', itemId, null);
    // Multiplayer hears about every change this game makes; see net/session.js.
    this.world.onEdit = (dimension, x, y, z, id) => this.net?.localEdit(dimension, x, y, z, id);
    this.world.onEntityChanged = (key, created) => this.net?.localEntity(key, created);
    this.world.onEntityRemoved = (key) => {
      if (this._openEntity?.key === key && this.state === 'container') this._closeContainer();
    };

    // Per-world state that must not leak across sessions. The shrine oracle is
    // seeded, so a stale one would point at the previous world's shrines.
    this._shrineOracle = null;
    this._shrineCacheKey = null;
    this._shrineCache = null;
    this._shrinesDone = new Set();
    this._platesDown = new Map();
    this._lastProgressPos = null;
    this._playingJukebox = null;
    audio.stopMusic();
    // Progress is per-world. `applyState` fills these back in for a saved
    // world; a new one starts blank rather than inheriting the last one's.
    this.stats = new Statistics();
    this.achievements.stats = this.stats;
    this.achievements.earned = new Set();
    this.player.board.totalStyle = 0;
    this.player.board.lastBanked = 0;
    this.sky.dayCount = 0;
    this._shrineTimer = 0;
    this._dungeonTimer = 0;
    this._hiveTimer = 0;
    this._travelling = false;
    this._loadFocus = null;
    this._applyDimensionLook();

    // Whether this world may use creative at all, fixed when it was created.
    this.allowCreative = save.allowCreative === true;

    this.saveMeta = remote ? null : {
      id: save.id,
      name: save.name,
      createdAt: save.createdAt,
      playTimeSeconds: save.playTimeSeconds ?? 0,
      allowCreative: this.allowCreative,
    };
    this.worldName = save.name;
    this._playTime = save.playTimeSeconds ?? 0;
    this._autosaveTimer = 0;
    this._thumbnail = save.thumbnail ?? null;
    // First grab a few seconds in, once the view has settled.
    this._thumbTimer = 4;

    if (isNew) {
      this.exploration.load(null);
      this.setDifficulty(save.difficulty ?? 'normal', false);
      this.player.waypoints = [];
      this.player.portals = [];
      this.player.deathLog = [];
      this.player.discovered = [];
      this.player.lastDeath = null;
      this.player.bedSpawn = null;
      this.player.survival.respawn();
      this.player.inventory.clear();
      this.player.inventory.armor.fill(null);
      this.player.experience.setTotal(0);
      this.player.enchantSeed = (Math.random() * 0x7fffffff) | 0;
      this.discovery.reset();
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
      // A world from before recipe discovery knows whatever its things teach:
      // everything carried, worn, or kept in its chests and furnaces.
      if (!this.discovery.load(save.player?.knownRecipes)) this._seedDiscovery();
      await this._preloadAround(this.player.position.x, this.player.position.z);
    }

    el('startWorldName').textContent = save.name;

    // Dying saves the world, so quitting from the death screen saves you at
    // zero health. That used to load back as a living player with no hearts,
    // killed outright by the next scratch. Load back onto the death screen.
    if (!isNew && this.player.survival.health <= 0) {
      this.player.survival.dead = true;
      el('deathCause').textContent = 'You died.';
      this._setState('dead');
      return;
    }
    this._setState('menu');
  }

  /**
   * Wait for the 3x3 chunk area around a position to finish generating.
   *
   * Until it has, the whole world streams around that position, not around
   * the player. The main loop streams every frame too, and during a load the
   * player is still standing somewhere else: in the previous world, on the
   * other side of a portal (eight times further out, or in), or where they
   * died. Each call unloaded the other's chunks, so once the two were a couple
   * of hundred blocks apart the load never finished and the loading screen
   * sat at 0% for good.
   */
  _preloadAround(worldX, worldZ) {
    const REQUIRED = 9;
    const fill = el('loadingFill');
    const centerCX = Math.floor(worldX / 16);
    const centerCZ = Math.floor(worldZ / 16);
    const probe = { x: worldX, y: 0, z: worldZ };
    this._loadFocus = probe;

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
        if (ready >= REQUIRED) {
          // Every caller moves the player here as soon as this resolves, in the
          // same task, so the main loop can go back to following the player.
          if (this._loadFocus === probe) this._loadFocus = null;
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
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
    // In someone else's world your things are kept by the host, under your name.
    if (this.remoteWorld) {
      this.net?.sendState();
      return;
    }
    if (!this.saveMeta || !this.world || this._saving || !SaveManager.available) return;
    this._saving = true;
    try {
      const save = await captureState(this, {
        ...this.saveMeta,
        playTimeSeconds: this._playTime,
        thumbnail: this._thumbnail,
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

  // -------------------------------------------------------------------------
  // Title screen
  // -------------------------------------------------------------------------

  /**
   * The title screen's backdrop: a camera slowly circling a real world.
   *
   * Before any world has been opened that is a scenic seed of its own, with a
   * short render distance so it costs little. After you quit to the menu it is
   * the world you were just in, circling the spot where you stood.
   */
  _startPanorama() {
    if (!this.world) {
      this.world = new World(this.renderer.scene, { seed: PANORAMA_SEED, renderDistance: 6 });
      this._panoramaWorld = true;
      const terrain = new TerrainGenerator(PANORAMA_SEED);
      const ground = Math.max(terrain.columnHeight(0, 0), Settings.seaLevel);
      this._panorama = { t: 0, x: 0.5, y: ground, z: 0.5 };
      // Mid-morning: long enough shadows to show the shapes, and a bright sky.
      this.sky.setTime(0.12);
    } else {
      const p = this.player.position;
      this._panorama = { t: 0, x: p.x, y: p.y, z: p.z };
    }
    this._applyDimensionLook();
  }

  _updatePanorama(dt) {
    const pan = this._panorama;
    pan.t += dt * 0.035;
    const camera = this.renderer.camera;
    const radius = 34;
    camera.position.set(
      pan.x + Math.cos(pan.t) * radius,
      pan.y + 20,
      pan.z + Math.sin(pan.t) * radius
    );
    camera.lookAt(pan.x, pan.y + 4, pan.z);
    this.world.update(camera.position, 0);
    // The clock stands still behind the menu; only the clouds and water move.
    this.sky.update(0, this.world, dt);
    this.renderer.setSelection(null);
    this.renderer.render();
  }

  /** A small JPEG of the current view, kept for the next save. */
  _captureThumbnail() {
    this._thumbTimer = THUMBNAIL_INTERVAL;
    if (!this._thumbCanvas) {
      this._thumbCanvas = document.createElement('canvas');
      this._thumbCanvas.width = 192;
      this._thumbCanvas.height = 108;
    }
    const source = this.canvas;
    // A hidden or collapsed window can leave the canvas with no size at all.
    if (!source.width || !source.height) return;
    const cropH = Math.min(source.height, (source.width * 9) / 16);
    const cropW = (cropH * 16) / 9;
    const ctx = this._thumbCanvas.getContext('2d');
    ctx.drawImage(source, (source.width - cropW) / 2, (source.height - cropH) / 2, cropW, cropH, 0, 0, 192, 108);
    try {
      this._thumbnail = this._thumbCanvas.toDataURL('image/jpeg', 0.72);
    } catch {
      // A tainted or lost canvas just means no new thumbnail this time.
    }
  }

  /**
   * Graphics "auto": watch the frame rate while playing and step the quality
   * down if it stays under about 45 fps. Never back up, so it cannot flicker
   * between levels; the level it settles on is remembered per browser.
   */
  _tuneQuality(dt) {
    if (prefs.get('graphics') !== 'auto') return;
    const q = this._autoQuality ?? (this._autoQuality = { total: 0, frames: 0 });
    // A stall (a chunk burst, a tab switch) says nothing about steady speed.
    if (dt > 0.12) return;
    q.total += dt;
    q.frames++;
    if (q.total < 4) return;
    const average = q.total / q.frames;
    q.total = 0;
    q.frames = 0;
    if (average <= 1 / 45) return;
    const next = { high: 'medium', medium: 'low' }[this.renderer.quality];
    if (!next) return;
    this.renderer.setQuality(next);
    this.world?.setFastLeaves(next === 'low');
    this._applyFarTerrain();
    saveAutoQuality(next);
    this.hud.showSaveToast(`Graphics: ${next}`);
  }

  // -------------------------------------------------------------------------
  // Compass markers
  // -------------------------------------------------------------------------

  /** Remember a portal for the compass, once per portal. */
  _rememberPortal(kind, x, y, z) {
    const dimension = this.world.dimension;
    const known = this.player.portals.some(
      (p) => p.dimension === dimension && Math.abs(p.x - x) < 5 && Math.abs(p.z - z) < 5
    );
    if (!known) this.player.portals.push({ kind, dimension, x, y, z });
  }

  /** Waypoint key: drop a named mark here, or with Sprint held remove the nearest. */
  _markWaypoint(remove) {
    const p = this.player.position;
    const dimension = this.world.dimension;
    const list = this.player.waypoints;
    if (remove) {
      let nearest = -1;
      let best = 12;
      list.forEach((w, i) => {
        if (w.dimension !== dimension) return;
        const d = Math.hypot(w.x - p.x, w.z - p.z);
        if (d < best) { best = d; nearest = i; }
      });
      if (nearest < 0) {
        this.hud.showToast('No waypoint nearby');
        return;
      }
      const [gone] = list.splice(nearest, 1);
      this.hud.showToast(`Removed ${gone.name}`);
      return;
    }
    const w = this.addWaypoint(p.x, p.z, p.y);
    if (w) this.hud.showToast(`Waypoint: ${w.name}`);
  }

  /**
   * Add a waypoint, named after the biome it is in, so a list of them still
   * means something. Used by the Waypoint key and by the map.
   * @returns the new waypoint, or null if there are too many
   */
  addWaypoint(x, z, y = null) {
    const dimension = this.world.dimension;
    const list = this.player.waypoints;
    if (list.length >= 48) {
      this.hud.showToast('Too many waypoints: remove one first');
      audio.uiError();
      return null;
    }
    let place = dimensionInfo(dimension).name.replace(/^The /, '');
    if (dimension === DIMENSIONS.OVERWORLD && this.terrainInfo) {
      const biome = this.terrainInfo.biomeAt?.(Math.floor(x), Math.floor(z));
      if (biome !== undefined && BIOME_NAMES[biome]) place = BIOME_NAMES[biome];
    }
    const number = list.filter((w) => w.name.startsWith(place)).length + 1;
    const w = {
      name: `${place} ${number}`, dimension,
      x: Math.round(x), y: Math.round(y ?? this.player.position.y), z: Math.round(z),
    };
    list.push(w);
    audio.uiConfirm();
    this.achievements.notify('event', 'waypoint');
    return w;
  }

  /** Everything the compass strip should show, in the current dimension. */
  compassMarkers() {
    const dimension = this.world.dimension;
    const player = this.player;
    const marks = [];
    if (dimension === DIMENSIONS.OVERWORLD && player.bedSpawn) {
      marks.push({ label: 'Bed', kind: 'bed', x: player.bedSpawn.x, z: player.bedSpawn.z, icon: this._markerIcon('bed') });
    }
    const death = player.lastDeath;
    if (death && death.dimension === dimension) {
      marks.push({ label: 'Grave', kind: 'grave', x: death.x + 0.5, z: death.z + 0.5, icon: this._markerIcon('grave') });
    }
    for (const portal of player.portals) {
      if (portal.dimension !== dimension) continue;
      marks.push({ label: 'Portal', kind: 'portal', x: portal.x, z: portal.z, icon: this._markerIcon(portal.kind) });
    }
    for (const w of player.waypoints) {
      if (w.dimension === dimension) marks.push({ label: w.name, kind: 'waypoint', x: w.x + 0.5, z: w.z + 0.5 });
    }
    // Structures you have found, while they are close enough to matter.
    const p = player.position;
    for (const s of player.discovered) {
      if (s.dimension !== dimension || Math.hypot(s.x - p.x, s.z - p.z) > 400) continue;
      marks.push({ label: STRUCTURE_NAMES[s.kind] ?? 'Structure', kind: 'structure', x: s.x, z: s.z, icon: this._markerIcon(s.kind) });
    }
    return marks;
  }

  /** Everything the world map draws, in the current dimension. */
  mapMarkers() {
    const dimension = this.world.dimension;
    const player = this.player;
    const marks = [];
    for (const d of player.deathLog) {
      if (d.dimension === dimension) marks.push({ kind: 'death', x: d.x, z: d.z });
    }
    for (const s of player.discovered) {
      if (s.dimension === dimension) marks.push({ kind: 'structure', x: s.x, z: s.z, label: STRUCTURE_NAMES[s.kind], icon: this._markerIcon(s.kind) });
    }
    for (const portal of player.portals) {
      if (portal.dimension === dimension) marks.push({ kind: 'portal', x: portal.x, z: portal.z, label: 'Portal', icon: this._markerIcon(portal.kind) });
    }
    if (dimension === DIMENSIONS.OVERWORLD && player.bedSpawn) {
      marks.push({ kind: 'bed', x: player.bedSpawn.x, z: player.bedSpawn.z, label: 'Bed', icon: this._markerIcon('bed') });
    }
    const grave = player.lastDeath;
    if (grave && grave.dimension === dimension) {
      marks.push({ kind: 'grave', x: grave.x + 0.5, z: grave.z + 0.5, label: 'Grave', icon: this._markerIcon('grave') });
    }
    for (const w of player.waypoints) {
      if (w.dimension === dimension) marks.push({ kind: 'waypoint', x: w.x + 0.5, z: w.z + 0.5, label: w.name, colour: w.colour });
    }
    return marks;
  }

  /** Name of the dimension you are in, for the map's title. */
  dimensionName() {
    return dimensionInfo(this.world.dimension).name;
  }

  /**
   * Mark structures you come near: dungeons and skate parks in the
   * Overworld, shrines in the Comb, fortresses in the Nether. Every one of
   * them is a pure function of the seed, so this only asks the same
   * questions the generators answer, a few times a second.
   */
  _discoverStructures(dt) {
    this._discoverClock = (this._discoverClock ?? 0) - dt;
    if (this._discoverClock > 0) return;
    this._discoverClock = 1.5;
    const p = this.player.position;
    const dimension = this.world.dimension;
    const pcx = Math.floor(p.x / 16), pcz = Math.floor(p.z / 16);
    const found = (kind, x, z, range) => {
      if (Math.hypot(x - p.x, z - p.z) > range) return;
      const known = this.player.discovered.some((d) => d.kind === kind && d.dimension === dimension && Math.abs(d.x - x) < 8 && Math.abs(d.z - z) < 8);
      if (known) return;
      this.player.discovered.push({ kind, dimension, x: Math.round(x), z: Math.round(z) });
      this.achievements.notify('discovered', kind);
      this.hud.showToast(`Discovered: ${STRUCTURE_NAMES[kind]}`);
      audio.uiConfirm();
    };
    const around = (spacing, visit) => {
      const ox = Math.floor(pcx / spacing) * spacing, oz = Math.floor(pcz / spacing) * spacing;
      for (let gz = -1; gz <= 1; gz++) for (let gx = -1; gx <= 1; gx++) visit(ox + gx * spacing, oz + gz * spacing);
    };
    if (dimension === DIMENSIONS.OVERWORLD && this.terrainInfo) {
      around(DUNGEON_SPACING, (cx, cz) => {
        const room = this.terrainInfo.dungeonAt?.(cx, cz);
        // A dungeon is underground: found when you are close to it in all three axes.
        if (room && Math.abs(room.y - p.y) < 14) found('dungeon', room.wx, room.wz, 20);
      });
      around(SKATEPARK_SPACING, (cx, cz) => {
        const park = this.terrainInfo.skateparkAt?.(cx, cz);
        if (park) found('skatepark', park.wx, park.wz, 48);
      });
    } else if (dimension === DIMENSIONS.NETHER) {
      this._netherInfo ??= new NetherTerrainGenerator(this.world.seed);
      around(FORTRESS_SPACING, (cx, cz) => {
        const fort = this._netherInfo.fortressAt(cx, cz);
        if (fort) found('fortress', fort.wx, fort.wz, 56);
      });
    } else if (dimension === DIMENSIONS.COMB) {
      const shrine = this.nearestShrine();
      if (shrine) found('shrine', shrine.wx, shrine.wz, 40);
    }
  }

  /**
   * Moving light and the shading that follows it: gather what glows (the
   * block in your hand, glowing mobs), refill the light volume if anything
   * moved, then shade mobs, items and your hand by where they are.
   */
  _updateLighting(dt) {
    const player = this.player;
    const sources = this._lightSources ?? (this._lightSources = []);
    sources.length = 0;
    const held = player.inventory.getSelected();
    const glow = held && Blocks.isBlockId(held.id) ? getBlock(held.id)?.lightEmission ?? 0 : 0;
    if (glow > 0 && !player.survival.dead) {
      const eye = player.eyePosition;
      sources.push({ x: eye.x, y: eye.y - 0.4, z: eye.z, level: Math.min(15, glow) });
    }
    this.entities.lightSources(sources);
    this.dynamicLight.update(dt, this.world, this.renderer.camera.position, sources);
    this.entities.applyLighting(dt, this.dynamicLight);

    this._handLightClock = (this._handLightClock ?? 0) - dt;
    if (this._handLightClock <= 0) {
      this._handLightClock = 0.1;
      const eye = player.eyePosition;
      const { k, warm } = sampleLocalLight(this.world, this.dynamicLight, eye.x, eye.y, eye.z);
      this.viewModel.setLight(k, warm);
    }
  }

  /** A block picture for a marker, cached. */
  _markerIcon(kind) {
    this._markerIcons ??= {};
    if (!(kind in this._markerIcons)) {
      const ids = {
        bed: BED.id, grave: GRAVESTONE.id, comb: PORTAL.id,
        nether: Blocks.PORTAL_NETHER.id, aether: Blocks.PORTAL_AETHER.id,
        dungeon: Blocks.CHEST.id, skatepark: Blocks.RAIL.id,
        fortress: Blocks.NETHER_BRICK.id, shrine: Blocks.THRONE.id,
      };
      const id = ids[kind];
      this._markerIcons[kind] = id ? getTileDataURL(Blocks.getIconTile(id)) : null;
    }
    return this._markerIcons[kind];
  }

  /** Save and return to the world list. */
  async exitToMenu() {
    await this.saveWorld();
    this._endNet();
    this.hud.closeAllContainers();
    this.input.releaseLock();
    // The world stays loaded: the title screen circles the spot you left.
    this.entities.clear();
    // The ambience bed is held open indefinitely; leaving the world must close
    // it or the menu keeps whistling.
    audio.stopAmbience();
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
    el('ui').classList.toggle('offstage', next === 'worlds' || next === 'loading');
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

  /**
   * Open a block entity's screen: a chest, a furnace, a sign. In multiplayer
   * only one player at a time may have each open, so this asks first (see
   * net/session.js), and a guest is sent the host's copy of what is inside,
   * the only one that counts.
   */
  _openShared(x, y, z, factory, open) {
    const key = this.world.blockEntityKey(x, y, z);
    const show = () => {
      const entity = this.world.getBlockEntity(x, y, z, factory);
      this._openEntity = { key, x, y, z };
      this._openContainer(() => open(entity));
    };
    const net = this.net;
    if (!net) {
      show();
      return;
    }
    net.lock(key, this.world.blockEntities.get(key) ?? factory()).then((reply) => {
      if (!reply.ok) {
        this.hud.showToast(reply.holder ? `${reply.holder} is using that` : 'The host did not answer');
        return;
      }
      // Something else happened while we asked; give it straight back.
      if (this.net !== net || this.state !== 'playing' || !this.world) {
        net.unlock(key);
        return;
      }
      show();
    });
  }

  /** Called by the HUD whenever its screens close: hand back an open block entity. */
  _onContainersClosed() {
    const open = this._openEntity;
    if (!open) return;
    this._openEntity = null;
    this.world?.touchBlockEntity(open.x, open.y, open.z);
    this.net?.unlock(open.key);
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
    this.stats.record('deaths');
    // Every death leaves a cross on the map, whether or not there was a grave.
    const p = this.player.position;
    this.player.deathLog.push({ dimension: this.world.dimension, x: Math.round(p.x), z: Math.round(p.z) });
    if (this.player.deathLog.length > 30) this.player.deathLog.shift();
    const messages = {
      fall: 'You hit the ground too hard.',
      mob: 'You were slain.',
      starve: 'You starved to death.',
      void: 'You fell out of the world.',
      lava: 'You tried to swim in lava.',
      spine: 'The Comb drank you dry.',
      explosion: 'A creeper got too close.',
      drown: 'You drowned.',
    };

    // Name the actual killer. This used to read "slain by a zombie" whatever hit
    // you, which is a strange thing to be told by a skeleton or the Warden.
    let text = messages[cause] ?? 'You died.';
    const killer = this.player.survival.lastDamageSource;
    if (cause === 'mob' && killer) {
      const name = killer.displayName ?? killer.name;
      text = killer.boss ? `The ${name} destroyed you.` : `You were slain by a ${name.toLowerCase()}.`;
    }
    // Close menus first, so a stack on the cursor or in a crafting grid goes
    // back into the inventory and from there into the grave.
    this.hud.closeAllContainers();
    const grave = this._buryInventory(cause);
    if (grave) text += ` Your things are in a gravestone at ${grave.x}, ${grave.y}, ${grave.z}.`;
    el('deathCause').textContent = text;
    this._setState('dead');
    this.input.releaseLock();
    this.saveWorld();
  }

  /**
   * Respawn at your bed, or the world spawn if the bed is gone.
   *
   * Spawn points only exist in the Overworld. This used to respawn you in
   * whatever dimension you died in, at Overworld coordinates: in the Nether
   * that is inside the rock, and in the Aether it is open void, so you fell out
   * of the world and died again, over and over.
   */
  async _respawn() {
    if (this._respawning) return;
    this._respawning = true;

    const player = this.player;
    if (this.world.dimension !== DIMENSIONS.OVERWORLD) {
      this._setState('loading');
      el('loadingFill').style.width = '0%';
      this.entities.clear();
      await this.world.setDimension(DIMENSIONS.OVERWORLD);
      this.dimension = DIMENSIONS.OVERWORLD;
      if (this.signRenderer) this.signRenderer.clear();
      this._applyDimensionLook();
    }

    let point = player.bedSpawn ?? player.spawnPoint;
    await this._preloadAround(point.x, point.z);
    if (player.bedSpawn && !isBed(this.world.getBlock(point.x, point.y - 1, point.z))) {
      player.bedSpawn = null;
      point = player.spawnPoint;
      await this._preloadAround(point.x, point.z);
      this.hud.showToast('Your bed was missing, so you woke at spawn');
    }

    player.respawn(point);
    this._lastProgressPos = null;
    this._setState('playing');
    this.input.requestLock();
    this._respawning = false;
  }

  /**
   * Put everything the player carried into a gravestone where they fell.
   *
   * The death penalty used to be deleting all of it, which turned every death
   * into a disaster and made long trips into the Nether or the Comb not worth
   * the risk. A grave keeps the sting (you still have to get back there) without
   * the robbery. Jev's pick; see JEV_DECISIONS.md.
   *
   * @returns the grave's position, or null if there was nothing to bury
   */
  _buryInventory(cause) {
    const player = this.player;
    if (player.creative) return null;
    const inv = player.inventory;

    const stacks = [];
    for (let i = 0; i < inv.slots.length; i++) {
      if (inv.slots[i]) stacks.push(inv.slots[i]);
    }
    for (let i = 0; i < inv.armor.length; i++) {
      if (inv.armor[i]) stacks.push(inv.armor[i]);
    }
    // Experience goes in the grave too: the cost of dying is the walk back.
    const xp = player.experience.total;
    if (stacks.length === 0 && xp === 0) return null;

    const spot = this._graveSpot(cause);
    if (!spot) {
      // Nowhere loaded to put it. Keeping the items is the lesser evil.
      console.warn('[death] no room for a gravestone; inventory kept');
      return null;
    }

    inv.slots.fill(null);
    inv.armor.fill(null);
    inv.touch();

    this.world.setBlock(spot.x, spot.y, spot.z, GRAVESTONE.id);
    const entity = this.world.getBlockEntity(spot.x, spot.y, spot.z, () => ({
      type: 'grave',
      state: { slots: [], cause },
    }));
    // Dying twice on the same spot adds to the same grave.
    entity.state.slots.push(...stacks);
    entity.state.xp = (entity.state.xp ?? 0) + xp;
    player.experience.setTotal(0);

    player.lastDeath = { dimension: this.world.dimension, x: spot.x, y: spot.y, z: spot.z };
    if (this.particles) this.particles.blockBreak(spot.x, spot.y, spot.z, GRAVESTONE.id, 10);
    return spot;
  }

  /**
   * Where to put a grave: where you fell, unless that was the void or a lava
   * lake, in which case the last solid ground you stood on.
   */
  _graveSpot(cause) {
    const player = this.player;
    const candidates = [];
    if (cause !== 'void' && cause !== 'lava') candidates.push(player.position);
    candidates.push(player.lastSafe);

    for (const c of candidates) {
      const spot = this._findGraveCell(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z));
      if (spot) return spot;
    }
    return null;
  }

  /** The nearest cell a gravestone can go in: air or water, never lava. */
  _findGraveCell(x, y, z) {
    const fits = (cx, cy, cz) => {
      if (cy < 1 || cy >= CHUNK_SY - 1) return false;
      const chunk = this.world.getChunk(Math.floor(cx / CHUNK_SX), Math.floor(cz / CHUNK_SZ));
      if (!chunk || !chunk.voxels) return false;
      const id = this.world.getBlock(cx, cy, cz);
      return id === 0 || isFluidFamily(id, 'water');
    };
    for (let r = 0; r <= 2; r++) {
      for (let dy = 0; dy <= 3; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            if (fits(x + dx, y + dy, z + dz)) return { x: x + dx, y: y + dy, z: z + dz };
          }
        }
      }
    }
    return null;
  }

  /** Right-click a gravestone: everything that fits comes back. */
  _recoverGrave(x, y, z) {
    const entity = this.world.getBlockEntity(x, y, z);
    const inv = this.player.inventory;
    const left = [];

    for (const stack of entity?.state.slots ?? []) {
      if (!stack) continue;
      // Armour goes straight back on, if that slot is free.
      const piece = Inventory.armorSlotFor(stack.id);
      if (piece >= 0 && !inv.armor[piece]) {
        inv.armor[piece] = stack;
        continue;
      }
      const leftover = inv.addExisting(stack);
      if (leftover > 0) left.push({ ...stack, count: leftover });
    }
    inv.touch();
    audio.chest(true);
    this.achievements.notify('event', 'grave');
    // Experience comes back whole, and first, so Mending does not eat it.
    if (entity?.state.xp > 0) {
      this.player.experience.add(entity.state.xp);
      entity.state.xp = 0;
    }

    if (left.length > 0) {
      entity.state.slots = left;
      this.world.touchBlockEntity(x, y, z);
      this.hud.showToast('Your inventory is full; the rest is still in the grave');
    } else {
      if (this.particles) this.particles.blockBreak(x, y, z, GRAVESTONE.id, 16);
      this.world.setBlock(x, y, z, 0);
      this._forgetGrave(x, y, z);
      this.hud.showToast('You got everything back');
    }
    this.hud.refreshAll();
    return true;
  }

  /**
   * Bring down any sugar cane at (x, y, z) and above that can no longer stand
   * (see sugarCane.js), as items, the way Minecraft's cane falls apart.
   */
  _dropUnsupportedCane(x, y, z) {
    const getBlock = (bx, by, bz) => this.world.getBlock(bx, by, bz);
    while (this.world.getBlock(x, y, z) === SUGAR_CANE.id && !caneCanStand(getBlock, x, y, z)) {
      this.world.setBlock(x, y, z, 0);
      this.entities.dropItem(x + 0.5, y + 0.5, z + 0.5, SUGAR_CANE.id, 1);
      y++;
    }
  }

  // -------------------------------------------------------------------------
  // Multiplayer
  // -------------------------------------------------------------------------

  /** Open this world to others (the pause menu's button). */
  async _startHosting() {
    if (this.net || this.remoteWorld || !this.world || this._panoramaWorld) return;
    const name = cleanName(el('hostName').value) || 'Host';
    rememberPlayerName(name);
    el('mpError').textContent = '';
    el('hostButton').disabled = true;
    const session = new HostSession(this, name);
    try {
      await session.open();
      this.net = session;
      this.chat.setVisible(true);
      this.chat.add('Your world is open. Friends join with the code in the pause menu; T to chat.', { kind: 'sys' });
    } catch (error) {
      session.close();
      el('mpError').textContent = error.message;
    } finally {
      el('hostButton').disabled = false;
      this._refreshNetUi();
    }
  }

  /** Stop playing with others: close the world to them, or leave theirs. */
  _endNet() {
    const net = this.net;
    if (!net) return;
    this.net = null;
    if (net.role === 'guest') net.leave();
    else net.close();
    this.chat.setVisible(false);
    if (this.remoteWorld) {
      // What is left on screen is theirs; nothing may save it here.
      this.remoteWorld = false;
      this.saveMeta = null;
    }
    this._refreshNetUi();
  }

  _showJoinForm(show) {
    el('joinForm').style.display = show ? '' : 'none';
    el('newWorldForm').style.display = 'none';
    el('worldActions').style.display = show ? 'none' : '';
    el('joinStatus').textContent = '';
    el('worldError').textContent = '';
    if (show) {
      el('joinName').value ||= loadPlayerName();
      (el('joinName').value ? el('joinCode') : el('joinName')).focus();
    }
  }

  /** The join form's button: reach the host, then load their world. */
  async _joinGame() {
    if (this._joining) return;
    const status = (text, error = false) => {
      el('joinStatus').textContent = text;
      el('joinStatus').classList.toggle('error', error);
    };
    const name = cleanName(el('joinName').value);
    const code = normalizeCode(el('joinCode').value);
    if (!name) { status('Pick a name to go by.', true); return; }
    if (!isCode(code)) { status('A join code is six letters and numbers, like K7Q-Z4P.', true); return; }
    rememberPlayerName(name);

    this._joining = true;
    el('joinConfirmButton').disabled = true;
    const session = new GuestSession(this, name);
    try {
      const welcome = await session.connect(code, (text) => status(text));
      status('Loading the world…');
      this.net = session;
      await this._startGuestWorld(welcome);
      this._showJoinForm(false);
    } catch (error) {
      session.close();
      if (this.net === session) this.net = null;
      this.remoteWorld = false;
      this.saveMeta = null;
      if (this.state !== 'worlds') await this._showWorldScreen();
      this._showJoinForm(true);
      status(error.message, true);
    } finally {
      this._joining = false;
      el('joinConfirmButton').disabled = false;
    }
  }

  /** Load the world a host sent (see HostSession._welcome) and join the others in it. */
  async _startGuestWorld(welcome) {
    const save = { ...welcome.save, edits: decodeEdits(welcome.save.edits) };
    await this._startSession(save, false, { remote: true });
    if (welcome.fresh) {
      // First time here: the kit every new player starts with.
      const inventory = this.player.inventory;
      inventory.clear();
      inventory.armor.fill(null);
      inventory.giveStarterItems();
      inventory.selectSlot(0);
      this.discovery.reset();
      this._seedDiscovery();
    }
    // Out of anything built where you stood since you were last here.
    this.player.teleportTo(this.player.position.clone());
    // The host's weather; this game only eases between the states it is sent.
    this.weather.timer = Infinity;
    this.worldName = welcome.world ?? 'World';
    el('startWorldName').textContent = this.worldName;
    this.net.begin(welcome);
    this.chat.setVisible(true);
    this.chat.add(`You joined ${welcome.host}'s world. Press T to chat.`, { kind: 'sys' });
    this._refreshNetUi();
  }

  /** The host went away, or sent us off. Back to the title screen, saying why. */
  onNetClosed(reason) {
    if (!this.net) return;
    this.net = null;
    this.chat.setVisible(false);
    this.remoteWorld = false;
    this.saveMeta = null;
    this.hud.closeAllContainers();
    this.input.releaseLock();
    this.entities.clear();
    audio.stopAmbience();
    this._refreshNetUi();
    this._showWorldScreen().then(() => { el('worldError').textContent = reason; });
  }

  onNetPlayersChanged() {
    this._refreshNetUi();
  }

  /** The pause menu's multiplayer panel and the title screen's join button. */
  _refreshNetUi() {
    const caps = this._netCaps;
    const available = !!caps && (!!caps.relay || caps.direct);
    const net = this.net;
    el('joinWorldButton').style.display = available ? '' : 'none';

    el('mpPanel').style.display = available || net ? '' : 'none';
    el('mpIdle').style.display = net ? 'none' : '';
    el('mpLive').style.display = net ? '' : 'none';
    el('quitButton').textContent = this.remoteWorld ? 'Leave' : 'Save & Quit';
    if (!net) {
      el('hostName').value ||= loadPlayerName();
      el('mpNote').textContent = caps?.direct
        ? 'Anyone with the code can join from the title screen, over the internet.'
        : 'Anyone on your network can join from the title screen.';
      return;
    }

    const hosting = net.role === 'host';
    el('mpTitle').textContent = hosting ? 'Open to friends' : `In ${net.hostName}'s world`;
    el('mpCodeBox').style.display = hosting ? '' : 'none';
    el('stopHostButton').style.display = hosting ? '' : 'none';
    const links = el('mpLinks');
    links.innerHTML = '';
    if (hosting && net.info) {
      el('mpCode').textContent = formatCode(net.info.code);
      const invite = (label, url) => {
        const row = document.createElement('div');
        row.className = 'mpLink';
        const text = document.createElement('code');
        text.textContent = url;
        const copy = document.createElement('button');
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => {
          navigator.clipboard?.writeText(url).then(() => this.hud.showSaveToast('Link copied'), () => {});
        });
        row.append(Object.assign(document.createElement('span'), { textContent: label }), text, copy);
        links.append(row);
      };
      const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
      if (net.info.direct && !local) invite('Invite', `${location.origin}${location.pathname}?join=${net.info.code}`);
      for (const address of net.info.relay?.lan ?? []) invite('Same Wi-Fi', `http://${address}/?join=${net.info.code}`);
    }
    const list = el('mpPlayers');
    list.innerHTML = '';
    for (const player of net.players()) {
      const item = document.createElement('li');
      item.textContent = player.you ? `${player.name} (you)` : player.name;
      list.append(item);
    }
  }

  /**
   * Distant terrain shows in the Overworld only (the Nether and the Comb have
   * roofs, the Aether is mostly sky), above Low graphics, with its option on.
   * The fog follows it out when it is showing.
   */
  _applyFarTerrain() {
    const on = !!this.world && !this._panoramaWorld &&
      this.world.dimension === DIMENSIONS.OVERWORLD &&
      this.renderer.quality !== 'low' && prefs.get('farTerrain');
    this.farTerrain.setActive(on);
    this.renderer.fogReach = this.farTerrain.active ? FAR_REACH : null;
  }

  /** Teach an older world every recipe its belongings point to, quietly. */
  _seedDiscovery() {
    const ids = [];
    const take = (stack) => { if (stack) ids.push(stack.id); };
    this.player.inventory.slots.forEach(take);
    this.player.inventory.armor.forEach(take);
    for (const entity of this.world.blockEntities.values()) {
      const state = entity.state ?? {};
      if (Array.isArray(state.slots)) state.slots.forEach(take);
      for (const field of ['input', 'fuel', 'output']) take(state[field]);
    }
    this.discovery.learnFrom(ids, true);
    this._discoveryVersion = this.player.inventory.version;
  }

  /**
   * Whenever the inventory changes, learn what it teaches (see discovery.js),
   * and notice a Mending find for its advancement.
   */
  _updateDiscovery() {
    const inv = this.player.inventory;
    this.discovery.everything = this.player.creative;
    if (inv.version === this._discoveryVersion) return;
    this._discoveryVersion = inv.version;
    const ids = [];
    for (const stack of [...inv.slots, ...inv.armor]) {
      if (!stack) continue;
      ids.push(stack.id);
      if (stack.ench?.mending) this.achievements.notify('event', 'mending');
    }
    if (!this.player.creative) this.discovery.learnFrom(ids);
  }

  /** Stop the compass pointing at a grave that has been emptied or broken. */
  _forgetGrave(x, y, z) {
    const d = this.player.lastDeath;
    if (d && d.dimension === this.world.dimension && d.x === x && d.y === y && d.z === z) {
      this.player.lastDeath = null;
    }
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

    // The title screen draws the panorama and nothing else.
    if (this.state === 'worlds' && this._panorama) {
      this._updatePanorama(dt);
      input.endFrame();
      return;
    }

    const playing = this.state === 'playing';

    // Other players: their changes and figures in, this game's out.
    this.net?.update(dt);
    this.chat.update(dt);

    // --- Global hotkeys ----------------------------------------------------
    // Typing in the sign editor must not also fire hotkeys: every letter of it
    // is somebody's keybind. Escape still closes, because otherwise a text
    // field would be a trap.
    if (input.textFieldFocused && this.state === 'container') {
      if (input.wasPressed('Escape')) this._closeContainer();
    } else if (playing || this.state === 'container') {
      if (input.actionWasPressed('debug')) this.hud.toggleDebug();

      if (input.actionWasPressed('mute')) {
        this.hud.showToast(audio.toggleMute() ? 'Sound off' : 'Sound on');
      }

      if (input.actionWasPressed('settings')) this._openSettings();

      if (playing && input.actionWasPressed('waypoint')) this._markWaypoint(input.isActionDown('sprint'));

      if (playing && this.net && input.actionWasPressed('chat')) this._openContainer(() => this.chat.open());

      if (input.actionWasPressed('map')) {
        if (this.state === 'container' && this.worldMap.isOpen) this._closeContainer();
        else if (playing) {
          this._openContainer(() => this.worldMap.open());
          this.achievements.notify('event', 'map');
        }
      }

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

      if (input.actionWasPressed('progress')) {
        if (this.state === 'container') this._closeContainer();
        else this._openContainer(() => this.hud.openProgress());
      } else if (input.actionWasPressed('inventory')) {
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
        dimension: this.world.dimension,
      });
      this._maintainShrines(dt);
      this._maintainHives(dt);
      this._maintainDungeons(dt);
      this._updatePressurePlates();
      this._updateEffects(dt);
      this._updateProgress(dt);
      this._discoverStructures(dt);
      if (this.signRenderer) this.signRenderer.update(dt, this.player.position, SIGN.id);

      this._autosaveTimer += dt;
      if (this._autosaveTimer >= AUTOSAVE_INTERVAL) {
        this._autosaveTimer = 0;
        this.saveWorld('Saved');
      }
    }

    // The world keeps streaming even while paused, so resuming is seamless.
    // Fluids and furnaces still tick while a container is open, as in Minecraft,
    // and a host's menus never stop the world for the players in it.
    const shared = this.net?.keepsRunning === true && ['paused', 'dead', 'settings'].includes(this.state);
    const simDt = playing || this.state === 'container' || shared ? dt : 0;
    this.world.update(this._loadFocus ?? this.player.position, simDt);

    // Weather runs before the sky, which reads its overcast and flash values.
    this.weather.update(simDt, {
      player: this.player,
      world: this.world,
      terrain: this.terrainInfo,
      particles: this.particles,
      hasWeather: dimensionInfo(this.world.dimension).hasWeather === true,
      onLightning: () => audio.thunder(),
    });
    this.sky.overcast = this.weather.overcast;
    this.sky.flash = this.weather.flash;
    this._updateAmbience(simDt);

    if (this.particles) this.particles.update(simDt);
    // Real time as well as clock time, so water and clouds keep moving behind menus.
    this.sky.update(playing || shared ? dt : 0, this.world, dt);

    // --- Presentation ------------------------------------------------------
    this.renderer.setSelection(playing ? this.player.targetBlock : null);
    this.renderer.setBreakProgress(playing ? this.player.targetBlock : null, this.player.breakProgress);

    // Speed widens the view a touch; drawing a bow narrows it to aim.
    let kick = 1;
    if (playing && prefs.get('fovEffects')) {
      const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
      kick += Math.min(0.16, Math.max(0, (speed - Settings.player.walkSpeed) / 22));
      kick -= this.player.drawProgress * 0.12;
    }
    this._fovKick += (kick - this._fovKick) * (1 - Math.exp(-7 * dt));
    this.renderer.setFovScale(this._fovKick);

    const camera = this.renderer.camera.position;
    this.cameraInWater = this.world.isWater(camera.x, camera.y, camera.z);
    this.cameraInLava = this.world.isLava(camera.x, camera.y, camera.z);

    if (playing || this.state === 'container') this._updateLighting(dt);
    if (playing || this.state === 'container') this._updateDiscovery();
    // The ring follows whatever the chunks are following, loading screens included.
    if (this.farTerrain.active) this.farTerrain.update(this._loadFocus ?? this.player.position, this.world);
    this.captions.update(dt, this.player);
    this.worldMap.updateMinimap(dt, playing);
    if (this.worldMap.isOpen) this.worldMap.draw();

    this.hud.update(dt);
    this.renderer.render();

    if (playing) this._tuneQuality(dt);

    // Grabbed straight after the world is drawn and before the hand is, so
    // the thumbnail shows the view and not your arm.
    if (playing) {
      this._thumbTimer -= dt;
      if (this._thumbTimer <= 0) this._captureThumbnail();
    }

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

/** How structures are named on the map, the compass and when found. */
const STRUCTURE_NAMES = {
  dungeon: 'Dungeon', skatepark: 'Skate park', fortress: 'Fortress', shrine: 'Shrine',
};

/** Where Graphics "auto" last settled on this machine. */
const AUTO_QUALITY_KEY = 'voxelcraft.autoQuality';

function loadAutoQuality() {
  try {
    const stored = localStorage.getItem(AUTO_QUALITY_KEY);
    return ['high', 'medium', 'low'].includes(stored) ? stored : 'high';
  } catch {
    return 'high';
  }
}

function saveAutoQuality(level) {
  try {
    localStorage.setItem(AUTO_QUALITY_KEY, level);
  } catch {
    // Not remembered: auto just re-measures next time.
  }
}

/** The name you last played under with others, for the join and host forms. */
const PLAYER_NAME_KEY = 'voxelcraft.playerName';

function loadPlayerName() {
  try {
    return localStorage.getItem(PLAYER_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberPlayerName(name) {
  try {
    localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch {
    // Not remembered; the form just starts empty next time.
  }
}

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
  // Say goodbye: a guest hands back its things, a host closes the door.
  game._endNet();
});

// Handy for poking at the world from the browser console:
//   game.world.setBlock(x, y, z, VoxelCraft.blocks.DIAMOND_BLOCK.id)
//   game.player.inventory.add(VoxelCraft.blocks.toolItemId('pickaxe', 'diamond'))
window.game = game;
window.VoxelCraft = {
  blocks: Blocks, crafting: Crafting, save: Save, Inventory,
  mobTypes: MobTypes, settings: Settings, audio,
};
