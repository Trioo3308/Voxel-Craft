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
  CRAFTING_TABLE, isFurnaceBlock, isDoor, DOOR_CLOSED, DOOR_OPEN, BED, CHEST,
  isPlate, PRESSURE_PLATE, PRESSURE_PLATE_PRESSED, SIGN, JUKEBOX, MUSIC_DISCS,
  PORTAL, COMBIUM_BLOCK, THRONE, THRONE_AWAKENED, ITEM_ID,
  LOG, ACACIA_LOG, SPRUCE_LOG, DIAMOND_ORE, FURNACE, getItem, getDisplayName,
} from './world/blocks.js';
import { audio } from './engine/audio.js';
import { DIMENSIONS, dimensionInfo } from './world/dimensions.js';
import {
  CombTerrainGenerator, SHRINE_SPACING, SHRINE_LAYOUT, nearestShrineAnchor, HIVE_SPACING,
} from './world/combTerrain.js';
import { DUNGEON_SPACING } from './world/terrain.js';
import { ignitePortal, extinguishPortal, buildReturnPortal, destinationOf } from './world/portal.js';
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
      this.hud.showToast(`Achievement: ${achievement.title}`);
      audio.achievement();
    };

    this.hud = new HUD(this);
    // Remembers where settings was opened from, so closing returns there.
    this._settingsReturnState = 'menu';
    this.settings = new SettingsScreen(this.input, () => this._closeSettings());

    this.weather = new Weather();

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
    this.player.onIgnitePortal = (x, y, z) => this._ignitePortal(x, y, z);
    this.player.onPortalTravel = () => this._travelDimension();

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
      audio.explosion(mob.distanceTo(this.player.eyePosition));
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

    // Right-clicking a station opens its interface instead of placing a block.
    this.player.onUseStation = (blockId, x, y, z) => {
      if (blockId === CRAFTING_TABLE.id) {
        this._openContainer(() => this.hud.openCraftingTable());
        return true;
      }

      // --- The throne -------------------------------------------------------
      if (blockId === THRONE.id || blockId === THRONE_AWAKENED.id) {
        return this._useThrone(blockId, x, y, z);
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

      // --- Signs: read, or edit if it is still blank ------------------------
      if (blockId === SIGN.id) {
        const entity = this.world.getBlockEntity(x, y, z, () => ({
          type: 'sign',
          state: { lines: ['', '', '', ''] },
        }));
        this._openContainer(() => this.hud.openSign(entity.state));
        return true;
      }

      // --- Jukebox: put a record in, or take one out ------------------------
      if (blockId === JUKEBOX.id) return this._useJukebox(x, y, z);

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

    // Breaking a container spills its contents rather than deleting them. The
    // entity is handed in by the break itself — clearing the block drops it, so
    // it can no longer be looked up by position at this point.
    this.player.onBlockBroken = (blockId, target, entity) => {
      if (!target) return;
      if (this.particles) this.particles.blockBreak(target.x, target.y, target.z, blockId);

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
            stack.id, leftover, stack.durability
          );
        }
      };

      if (entity && isFurnaceBlock(blockId)) {
        for (const field of ['input', 'fuel', 'output']) recover(entity.state[field]);
      } else if (entity && blockId === CHEST.id) {
        for (const stack of entity.state.slots) recover(stack);
      } else if (entity && blockId === JUKEBOX.id && entity.state.disc) {
        // Breaking a loaded jukebox gives the record back and stops the music.
        recover({ id: entity.state.disc, count: 1 });
        audio.stopMusic();
        this._playingJukebox = null;
      }

      // Breaking part of a frame collapses the whole portal, so a portal can
      // never outlive its ring.
      if (blockId === COMBIUM_BLOCK.id) {
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          if (this.world.getBlock(target.x + dx, target.y + dy, target.z + dz) === PORTAL.id) {
            extinguishPortal(this.world, target.x + dx, target.y + dy, target.z + dz);
          }
        }
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
   * Light a combium portal with a bucket of milk.
   * @returns {boolean} whether a valid frame was found and filled
   */
  _ignitePortal(x, y, z) {
    const result = ignitePortal(this.world, x, y, z);
    if (!result) {
      this.hud.showToast('The frame is not complete');
      return false;
    }
    audio.ignite();
    this.hud.showToast('The portal opens');
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
  async _travelDimension() {
    if (this._travelling) return;
    this._travelling = true;

    const from = this.world.dimension;
    const to = destinationOf(from);
    const scale = to === DIMENSIONS.COMB ? 1 / DIMENSION_SCALE : DIMENSION_SCALE;

    const targetX = Math.round(this.player.position.x * scale);
    const targetZ = Math.round(this.player.position.z * scale);

    this._setState('loading');
    el('loadingFill').style.width = '0%';
    this.entities.clear();

    await this.world.setDimension(to);
    this.dimension = to;

    // Stream the arrival area before deciding where the ground is.
    await this._preloadAround(targetX, targetZ);

    // Land on solid ground, then build a return portal around it.
    const surface = this.world.getSurfaceY(targetX, targetZ);
    const landingY = surface >= 0 ? surface + 1 : 64;
    const built = buildReturnPortal(this.world, targetX, landingY, targetZ);

    this.player.position.set(built.stand.x, built.stand.y, built.stand.z);
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
    // A teleport is not a walk, so the distance counter must not bank it.
    this._lastProgressPos = null;
    this._travelling = false;
    this.saveWorld();
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
      audio.door(true);
    }

    // Newly stepped off.
    for (const [key, opened] of this._platesDown) {
      if (pressed.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      // Only restore a plate that is still a plate — it may have been mined.
      if (isPlate(this.world.getBlock(x, y, z))) {
        this.world.setBlock(x, y, z, PRESSURE_PLATE.id);
        audio.door(false);
      }
      for (const [dx, dy, dz] of opened) {
        if (this.world.getBlock(dx, dy, dz) === DOOR_OPEN.id) {
          this.world.setBlock(dx, dy, dz, DOOR_CLOSED.id);
        }
      }
      this._platesDown.delete(key);
    }
  }

  /**
   * Open or close every door touching a plate.
   * @returns the positions actually changed, so they can be undone later.
   */
  _setNeighbourDoors(x, y, z, opening) {
    const changed = [];
    const want = opening ? DOOR_OPEN.id : DOOR_CLOSED.id;
    const from = opening ? DOOR_CLOSED.id : DOOR_OPEN.id;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // Doors are two tall, and a plate can sit level with either half.
      for (const dy of [0, 1, -1]) {
        const bx = x + dx, by = y + dy, bz = z + dz;
        if (this.world.getBlock(bx, by, bz) !== from) continue;
        this.world.setBlock(bx, by, bz, want);
        changed.push([bx, by, bz]);
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

    // Effects are tied to the world they collide against, so they are rebuilt
    // with it rather than carried over.
    if (this.particles) this.particles.dispose();
    this.particles = new ParticleSystem(this.renderer.scene, this.world);
    if (this.signRenderer) this.signRenderer.dispose();
    this.signRenderer = new SignRenderer(this.renderer.scene, this.world);
    this.entities.particles = this.particles;
    this.world.onLeafDecayed = this.world_onLeafDecayed;
    this.world.onSmelted = (itemId) => this._notePlayerMilestone('smelted', itemId, null);

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
    this._applyDimensionLook();

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
    this.stats.record('deaths');
    const messages = {
      fall: 'You hit the ground too hard.',
      mob: 'You were slain.',
      starve: 'You starved to death.',
      void: 'You fell out of the world.',
      lava: 'You tried to swim in lava.',
      spine: 'The Comb drank you dry.',
      explosion: 'A creeper got too close.',
    };

    // Name the actual killer. This used to read "slain by a zombie" whatever hit
    // you, which is a strange thing to be told by a skeleton or the Warden.
    let text = messages[cause] ?? 'You died.';
    const killer = this.player.survival.lastDamageSource;
    if (cause === 'mob' && killer) {
      const name = killer.displayName ?? killer.name;
      text = killer.boss ? `The ${name} destroyed you.` : `You were slain by a ${name.toLowerCase()}.`;
    }
    el('deathCause').textContent = text;
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
      if (this.signRenderer) this.signRenderer.update(dt, this.player.position, SIGN.id);

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
