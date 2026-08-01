/**
 * world.js — Main-thread chunk manager.
 *
 * Owns the streaming lifecycle (request -> upload -> unload) and is the single
 * source of truth for block reads/writes on the render thread.
 *
 * The main thread keeps its own copy of every loaded chunk's voxels. That
 * duplication is deliberate: collision, raycasting and edit feedback all need
 * synchronous answers, and round-tripping to the worker for them would add a
 * frame of latency to every block you place.
 */

import * as THREE from 'three';
import Settings from '../settings.js';
import {
  CHUNK_SX, CHUNK_SY, CHUNK_SZ,
  chunkKey, voxelIndex, toChunkCoord, toLocalCoord,
} from './chunk.js';
import {
  AIR, BLOCKS, isSolid as blockIsSolid, isLiquid as blockIsLiquid, isFluidFamily,
  isFurnaceBlock, FURNACE, FURNACE_LIT,
  isFarmland, FARMLAND_MOIST, WHEAT_STAGES, wheatStage,
  isSapling, isLeaf, LEAF_SUPPORTS, GRASS, DIRT, PODZOL, DRY_GRASS, SWAMP_GRASS, SAND,
} from './blocks.js';
import { growTree } from './treeGrowth.js';
import { getAtlasTexture } from './textures.js';
import { FluidSimulator } from './fluids.js';
import { TERRAIN_VERSION } from './terrain.js';
import { DIMENSIONS } from './dimensions.js';
import { tickFurnace } from '../player/crafting.js';

/**
 * Random-tick tuning.
 *
 * The sample count has to be derived from the volume, not picked by feel. A
 * given crop is hit at `samples / volume` per round, so time-to-ripen is
 *
 *   stages / (roundsPerSecond * samples/volume * growthChance)
 *
 * With a 33 x 33 x 17 window that volume is ~18.5k cells; the first draft
 * sampled 28 of them per round, which works out to roughly fifty minutes to
 * grow a single wheat. Measured with these numbers: 91 seconds irrigated, 299
 * dry, so a channel is worth digging at 3.3x. Sampling is just an array index,
 * so ~1300 lookups a second is far cheaper than the bookkeeping a crop registry
 * would need.
 */
const RANDOM_TICK_INTERVAL = 0.25;   // seconds between rounds
const RANDOM_TICKS_PER_ROUND = 320;
const RANDOM_TICK_RADIUS = 16;       // blocks, horizontally
const RANDOM_TICK_HEIGHT = 8;        // blocks, above and below the player
const GROWTH_CHANCE_DRY = 0.18;
const GROWTH_CHANCE_MOIST = 0.40;

/** Saplings take longer than wheat — a tree should feel like a wait. */
const SAPLING_GROWTH_CHANCE = 0.10;
/** What a sapling will root in. */
const SAPLING_SOIL = new Set([GRASS.id, DIRT.id, PODZOL.id, DRY_GRASS.id, SWAMP_GRASS.id, SAND.id]);

/** Leaf decay: how eagerly an unsupported leaf gives up, and how far it looks. */
const LEAF_DECAY_CHANCE = 0.55;
const LEAF_RANGE = 4;

/** Six-way neighbours, shared by the leaf-support flood. */
const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** Per-chunk render + data record. */
class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    /** @type {Uint8Array|null} */
    this.voxels = null;
    /** @type {THREE.Mesh|null} */
    this.opaqueMesh = null;
    /** @type {THREE.Mesh|null} */
    this.waterMesh = null;
    this.requested = false;
    this.ready = false;
  }
}

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {{seed?: number, renderDistance?: number}} [options]
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    this.seed = options.seed ?? Settings.seed;
    /** Generation rules this world uses — from its save, not from the build. */
    this.terrainVersion = options.terrainVersion ?? TERRAIN_VERSION;
    /** Which dimension is currently streamed. */
    this.dimension = options.dimension ?? DIMENSIONS.OVERWORLD;
    this.renderDistance = options.renderDistance ?? Settings.renderDistance;

    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();

    // Chunks whose geometry has arrived but is not on the GPU yet. Draining
    // this over several frames is what keeps chunk loading from causing hitches.
    this.uploadQueue = [];
    this.pendingRequests = 0;

    this.lastPlayerCX = null;
    this.lastPlayerCZ = null;
    this.queue = [];

    this.stats = { loaded: 0, pending: 0, triangles: 0 };
    this.onFirstChunk = null;

    // Block writes queued for the worker. Batching them means a spreading pool
    // costs one remesh per affected chunk instead of one per changed voxel.
    this._pendingSync = [];

    /**
     * Per-position state for blocks that hold contents — currently furnaces.
     * Keyed "x,y,z". Saved with the world; discarded when the block is broken.
     */
    this.blockEntities = new Map();

    /**
     * Reported when a furnace finishes an item, so the game can count it. The
     * world does not know or care what anything does with that.
     * @type {((itemId: number) => void)|null}
     */
    this.onSmelted = null;

    this.fluids = new FluidSimulator(this);
    this._tickAccumulator = 0;

    this._initMaterials();
    this._initWorker();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  _initMaterials() {
    const map = getAtlasTexture();

    // Unlit material: all shading is already baked into the vertex colours by
    // the mesher, so there is no per-fragment lighting cost. `color` doubles as
    // the global day/night tint.
    this.opaqueMaterial = new THREE.MeshBasicMaterial({
      map,
      vertexColors: true,
      alphaTest: 0.5, // cutout for leaves + glass, still in the opaque pass
      side: THREE.FrontSide,
      fog: true,
    });

    this.waterMaterial = new THREE.MeshBasicMaterial({
      map,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide, // so the surface is visible from underwater too
      fog: true,
    });
  }

  _initWorker() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
    this.worker.postMessage({
      type: 'init',
      seed: this.seed,
      terrainVersion: this.terrainVersion,
      dimension: this.dimension,
    });
  }

  /**
   * Move the world to another dimension.
   *
   * Every loaded chunk is discarded and re-streamed from the new dimension's
   * generator. The worker keeps both dimensions' chunks and edits in memory, so
   * coming back is fast and anything built is still there.
   */
  setDimension(dimension) {
    if (dimension === this.dimension) return Promise.resolve();
    this.dimension = dimension;

    return new Promise((resolve) => {
      this._dimensionResolve = resolve;
      this.unloadAll();
      // Block entities are deliberately NOT cleared: their keys are dimension-
      // scoped, so the other dimension's chests and furnaces must survive the
      // trip. Clearing here emptied every overworld container the moment you
      // stepped through a portal, and wiped what a load had just restored.
      this.worker.postMessage({ type: 'setDimension', dimension });
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Every player edit, as compact per-chunk typed arrays. */
  exportEdits() {
    return new Promise((resolve) => {
      this._editsResolve = resolve;
      this.worker.postMessage({ type: 'exportEdits' });
    });
  }

  /**
   * Replace all edits (loading a save). Every loaded chunk is discarded so the
   * world re-streams with the restored changes applied.
   */
  importEdits(edits) {
    return new Promise((resolve) => {
      this._importResolve = resolve;
      this.unloadAll();
      this.worker.postMessage({ type: 'importEdits', edits });
    });
  }

  /** Tear down every loaded chunk without shutting the worker down. */
  unloadAll() {
    for (const chunk of this.chunks.values()) {
      if (chunk.opaqueMesh) { this.scene.remove(chunk.opaqueMesh); chunk.opaqueMesh.geometry.dispose(); }
      if (chunk.waterMesh) { this.scene.remove(chunk.waterMesh); chunk.waterMesh.geometry.dispose(); }
    }
    this.chunks.clear();
    this.uploadQueue.length = 0;
    this.queue.length = 0;
    this.pendingRequests = 0;
    this.lastPlayerCX = null;
    this.lastPlayerCZ = null;
    this.fluids.clear();
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.workerReady = true;
        break;

      case 'chunk': {
        this.pendingRequests = Math.max(0, this.pendingRequests - 1);
        const chunk = this.chunks.get(chunkKey(msg.cx, msg.cz));
        // The chunk may have been unloaded while the worker was busy.
        if (!chunk) break;
        chunk.voxels = msg.voxels;
        this.uploadQueue.push(msg);
        break;
      }

      case 'remesh': {
        const chunk = this.chunks.get(chunkKey(msg.cx, msg.cz));
        if (!chunk) break;
        // Edits should appear immediately — bypass the frame budget.
        this._uploadMeshes(chunk, msg.opaque, msg.water);
        break;
      }

      case 'edits':
        if (this._editsResolve) { this._editsResolve(msg.edits); this._editsResolve = null; }
        break;

      case 'editsImported':
        if (this._importResolve) { this._importResolve(); this._importResolve = null; }
        break;

      case 'dimensionReady':
        if (this._dimensionResolve) { this._dimensionResolve(); this._dimensionResolve = null; }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Call once per frame.
   * @param {{x:number,z:number}} position player world position
   * @param {number} dt seconds (0 while loading/paused, which freezes fluids)
   */
  update(position, dt = 0) {
    const pcx = toChunkCoord(position.x);
    const pcz = toChunkCoord(position.z);

    if (pcx !== this.lastPlayerCX || pcz !== this.lastPlayerCZ) {
      this.lastPlayerCX = pcx;
      this.lastPlayerCZ = pcz;
      this._rebuildQueue(pcx, pcz);
      this._unloadDistant(pcx, pcz);
    }

    this._issueRequests();
    this._drainUploadQueue();
    this.fluids.update(dt);
    this._tickBlockEntities(dt);
    this._randomTick(position, dt);

    this.stats.loaded = this.chunks.size;
    this.stats.pending = this.pendingRequests + this.queue.length;
  }

  /**
   * Random block ticks near the player — how crops grow.
   *
   * Sampling random cells is Minecraft's own trick, and it is what keeps growth
   * off any per-block bookkeeping: nothing has to remember where the farms are,
   * a planted crop is just a block id that occasionally gets poked. The cost is
   * fixed per frame regardless of how much has been planted.
   */
  _randomTick(position, dt) {
    if (dt <= 0) return;

    this._tickAccumulator += dt;
    if (this._tickAccumulator < RANDOM_TICK_INTERVAL) return;
    this._tickAccumulator = 0;

    const px = Math.floor(position.x);
    const py = Math.floor(position.y);
    const pz = Math.floor(position.z);

    for (let i = 0; i < RANDOM_TICKS_PER_ROUND; i++) {
      const span = RANDOM_TICK_RADIUS * 2 + 1;
      const x = px + ((Math.random() * span) | 0) - RANDOM_TICK_RADIUS;
      const z = pz + ((Math.random() * span) | 0) - RANDOM_TICK_RADIUS;
      const y = py + ((Math.random() * (RANDOM_TICK_HEIGHT * 2 + 1)) | 0) - RANDOM_TICK_HEIGHT;
      if (y < 1 || y >= CHUNK_SY) continue;
      if (!this.isChunkLoaded(x, z)) continue;

      const id = this.getBlock(x, y, z);
      if (wheatStage(id) >= 0) this._tickCrop(x, y, z);
      else if (isSapling(id)) this._tickSapling(x, y, z, id);
      else if (isLeaf(id)) this._tickLeaf(x, y, z, id);
    }
  }

  /** A sapling with room and daylight becomes a tree. */
  _tickSapling(x, y, z, id) {
    if (Math.random() > SAPLING_GROWTH_CHANCE) return;

    const soil = this.getBlock(x, y - 1, z);
    if (!SAPLING_SOIL.has(soil)) return;

    growTree(this, x, y, z, BLOCKS[id].grows);
  }

  /**
   * Leaves cut off from a trunk wither away.
   *
   * The support search is a bounded flood rather than a box scan: a box would
   * count a *different* tree's log four blocks away and keep a floating canopy
   * alive forever, which is exactly the artefact this is meant to clear up.
   */
  _tickLeaf(x, y, z, id) {
    if (Math.random() > LEAF_DECAY_CHANCE) return;
    if (this._leafHasSupport(x, y, z)) return;

    const block = BLOCKS[id];
    this.setBlock(x, y, z, AIR);
    if (this.onLeafDecayed) this.onLeafDecayed(x, y, z, block);
  }

  /** Is this leaf connected to a log through at most LEAF_RANGE leaves? */
  _leafHasSupport(x, y, z) {
    const seen = new Set([`${x},${y},${z}`]);
    let frontier = [[x, y, z, 0]];

    while (frontier.length > 0) {
      const next = [];
      for (const [cx, cy, cz, depth] of frontier) {
        for (const [dx, dy, dz] of NEIGHBOURS) {
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          const key = `${nx},${ny},${nz}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const neighbour = this.getBlock(nx, ny, nz);
          if (LEAF_SUPPORTS.has(neighbour)) return true;
          // Only keep walking through leaves, and only so far.
          if (depth + 1 < LEAF_RANGE && isLeaf(neighbour)) next.push([nx, ny, nz, depth + 1]);
        }
      }
      frontier = next;
    }
    return false;
  }

  /** Advance one crop, if that is what is at these coordinates. */
  _tickCrop(x, y, z) {
    const id = this.getBlock(x, y, z);
    const stage = wheatStage(id);
    if (stage < 0 || stage >= WHEAT_STAGES.length - 1) return;

    const soil = this.getBlock(x, y - 1, z);
    if (!isFarmland(soil)) {
      // Something took the soil away — the crop cannot stand on its own.
      this.setBlock(x, y, z, AIR);
      return;
    }

    // Irrigated soil roughly doubles the growth rate, which is the whole reason
    // to dig a channel rather than plant a field anywhere.
    const chance = soil === FARMLAND_MOIST.id ? GROWTH_CHANCE_MOIST : GROWTH_CHANCE_DRY;
    if (Math.random() > chance) return;

    this.setBlock(x, y, z, WHEAT_STAGES[stage + 1].id);
  }

  /** Rebuild the wanted-chunk list, nearest first. */
  _rebuildQueue(pcx, pcz) {
    const r = this.renderDistance;
    const wanted = [];

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // Circular rather than square load area — fewer chunks for the same
        // visible distance.
        const distSq = dx * dx + dz * dz;
        if (distSq > r * r) continue;

        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = chunkKey(cx, cz);
        if (this.chunks.has(key)) continue;
        wanted.push({ cx, cz, distSq });
      }
    }

    // Nearest chunks first so the world fills in outward from the player.
    wanted.sort((a, b) => a.distSq - b.distSq);
    this.queue = wanted;
  }

  /** Kick off worker jobs, respecting the in-flight cap. */
  _issueRequests() {
    while (this.pendingRequests < Settings.maxPendingChunks && this.queue.length > 0) {
      const { cx, cz } = this.queue.shift();
      const key = chunkKey(cx, cz);
      if (this.chunks.has(key)) continue;

      const chunk = new Chunk(cx, cz);
      chunk.requested = true;
      this.chunks.set(key, chunk);

      this.worker.postMessage({ type: 'request', cx, cz });
      this.pendingRequests++;
    }
  }

  /** Upload at most N chunk meshes per frame to avoid GPU stalls. */
  _drainUploadQueue() {
    let uploads = 0;
    while (this.uploadQueue.length > 0 && uploads < Settings.maxUploadsPerFrame) {
      const msg = this.uploadQueue.shift();
      const chunk = this.chunks.get(chunkKey(msg.cx, msg.cz));
      if (!chunk) continue;

      this._uploadMeshes(chunk, msg.opaque, msg.water);
      const wasReady = chunk.ready;
      chunk.ready = true;
      uploads++;

      if (!wasReady && this.onFirstChunk) {
        this.onFirstChunk(chunk);
        this.onFirstChunk = null;
      }
    }
  }

  /** Replace a chunk's meshes with freshly built geometry. */
  _uploadMeshes(chunk, opaqueData, waterData) {
    chunk.opaqueMesh = this._swapMesh(chunk.opaqueMesh, opaqueData, this.opaqueMaterial, chunk, 0);
    chunk.waterMesh = this._swapMesh(chunk.waterMesh, waterData, this.waterMaterial, chunk, 1);
  }

  _swapMesh(existing, data, material, chunk, renderOrder) {
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
    }
    if (!data) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere(); // required for frustum culling

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.cx * CHUNK_SX, 0, chunk.cz * CHUNK_SZ);
    mesh.renderOrder = renderOrder;
    // Chunks never move, so skip the per-frame matrix recomputation.
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    return mesh;
  }

  /** Drop chunks that have fallen outside the render distance (+ hysteresis). */
  _unloadDistant(pcx, pcz) {
    const limit = this.renderDistance + Settings.unloadPadding;
    const limitSq = limit * limit;

    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - pcx;
      const dz = chunk.cz - pcz;
      if (dx * dx + dz * dz <= limitSq) continue;

      if (chunk.opaqueMesh) {
        this.scene.remove(chunk.opaqueMesh);
        chunk.opaqueMesh.geometry.dispose();
      }
      if (chunk.waterMesh) {
        this.scene.remove(chunk.waterMesh);
        chunk.waterMesh.geometry.dispose();
      }
      if (chunk.requested && !chunk.ready) this.pendingRequests = Math.max(0, this.pendingRequests - 1);

      this.chunks.delete(key);
      this.worker.postMessage({ type: 'unload', cx: chunk.cx, cz: chunk.cz });
    }
  }

  // -------------------------------------------------------------------------
  // Block access
  // -------------------------------------------------------------------------

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /** True once a chunk's voxel data has arrived. */
  isChunkLoaded(wx, wz) {
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    return !!(chunk && chunk.voxels);
  }

  /** Block id at a world position. Unloaded / out-of-range reads give AIR. */
  getBlock(wx, wy, wz) {
    wx = Math.floor(wx); wy = Math.floor(wy); wz = Math.floor(wz);
    if (wy < 0 || wy >= CHUNK_SY) return AIR;
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk || !chunk.voxels) return AIR;
    return chunk.voxels[voxelIndex(toLocalCoord(wx), wy, toLocalCoord(wz))];
  }

  /**
   * Write a block. Applies locally at once (so physics and the next raycast see
   * it immediately) and forwards to the worker, which owns remeshing.
   *
   * @param deferSync batch the worker message instead of sending it now. The
   *   fluid simulator uses this so one tick produces one remesh per chunk;
   *   call `flushBlockChanges()` afterwards.
   * @returns {boolean} whether the write landed
   */
  setBlock(wx, wy, wz, id, deferSync = false) {
    wx = Math.floor(wx); wy = Math.floor(wy); wz = Math.floor(wz);
    if (wy < 0 || wy >= CHUNK_SY) return false;

    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk || !chunk.voxels) return false;

    const previous = chunk.voxels[voxelIndex(toLocalCoord(wx), wy, toLocalCoord(wz))];
    chunk.voxels[voxelIndex(toLocalCoord(wx), wy, toLocalCoord(wz))] = id;

    // Replacing a block discards whatever it was holding — but a furnace
    // lighting up or going out is the *same* furnace, so keep its contents.
    const sameStation = isFurnaceBlock(previous) && isFurnaceBlock(id);
    if (previous !== id && !sameStation) {
      this.blockEntities.delete(this.blockEntityKey(wx, wy, wz));
    }

    if (deferSync) this._pendingSync.push({ x: wx, y: wy, z: wz, id });
    else this.worker.postMessage({ type: 'setBlock', x: wx, y: wy, z: wz, id });

    // Any edit can unbalance neighbouring fluid, including a plain dig.
    this.fluids.onBlockChanged(wx, wy, wz);
    return true;
  }

  // -------------------------------------------------------------------------
  // Block entities
  // -------------------------------------------------------------------------

  /**
   * Key for a block-entity position.
   *
   * Dimension-scoped, because the same coordinates exist in every dimension —
   * without the prefix a shrine chest in the Comb would share state with
   * whatever happens to sit at those coordinates in the overworld.
   */
  blockEntityKey(wx, wy, wz, dimension = this.dimension) {
    return `${dimension}:${Math.floor(wx)},${Math.floor(wy)},${Math.floor(wz)}`;
  }

  /** Fetch (or lazily create) the state attached to a block position. */
  getBlockEntity(wx, wy, wz, factory) {
    const key = this.blockEntityKey(wx, wy, wz);
    let entity = this.blockEntities.get(key);
    if (!entity && factory) {
      entity = factory();
      this.blockEntities.set(key, entity);
    }
    return entity ?? null;
  }

  /** Advance every furnace, whether or not its UI is open. */
  _tickBlockEntities(dt) {
    if (dt <= 0 || this.blockEntities.size === 0) return;

    const prefix = `${this.dimension}:`;

    for (const [key, entity] of this.blockEntities) {
      if (entity.type !== 'furnace') continue;
      tickFurnace(entity.state, dt, this.onSmelted);

      // Swap the block between lit and unlit so the glow shows in the world.
      // Only on an actual transition, since each swap costs a chunk remesh.
      const lit = entity.state.burnRemaining > 0;
      if (lit === entity.wasLit) continue;
      entity.wasLit = lit;

      // Blocks in another dimension are not streamed, so leave them alone —
      // the swap happens when the player returns and the furnace ticks again.
      if (!key.startsWith(prefix)) continue;
      const [x, y, z] = key.slice(prefix.length).split(',').map(Number);
      const current = this.getBlock(x, y, z);
      if (!isFurnaceBlock(current)) continue;
      const wanted = lit ? FURNACE_LIT.id : FURNACE.id;
      if (current !== wanted) this.setBlock(x, y, z, wanted);
    }
  }

  /** Send every deferred block write to the worker as one batch. */
  flushBlockChanges() {
    if (this._pendingSync.length === 0) return;
    this.worker.postMessage({ type: 'setBlocks', changes: this._pendingSync });
    this._pendingSync = [];
  }

  /**
   * Collision test. Unloaded chunks read as solid so entities cannot fall
   * through the world while terrain is still streaming in.
   */
  isSolid(wx, wy, wz) {
    wx = Math.floor(wx); wy = Math.floor(wy); wz = Math.floor(wz);
    if (wy < 0) return true;             // bedrock floor
    if (wy >= CHUNK_SY) return false;    // open sky above the build limit

    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk || !chunk.voxels) return true; // not loaded yet: treat as ground

    const id = chunk.voxels[voxelIndex(toLocalCoord(wx), wy, toLocalCoord(wz))];
    return blockIsSolid(id);
  }

  isLiquid(wx, wy, wz) {
    return blockIsLiquid(this.getBlock(wx, wy, wz));
  }

  /**
   * Collision boxes for a block, or null for a plain full cube.
   * Physics calls this only after `isSolid` says something is there, so the
   * common case costs one array lookup.
   */
  getShape(wx, wy, wz) {
    const block = BLOCKS[this.getBlock(wx, wy, wz)];
    return block ? block.shape : null;
  }

  /** Water specifically (for swimming vs. burning). */
  isWater(wx, wy, wz) {
    return isFluidFamily(this.getBlock(wx, wy, wz), 'water');
  }

  isLava(wx, wy, wz) {
    return isFluidFamily(this.getBlock(wx, wy, wz), 'lava');
  }

  /** Y of the highest non-air block in a column, or -1. Used for mob spawning. */
  getSurfaceY(wx, wz) {
    wx = Math.floor(wx); wz = Math.floor(wz);
    const chunk = this.getChunk(toChunkCoord(wx), toChunkCoord(wz));
    if (!chunk || !chunk.voxels) return -1;

    const lx = toLocalCoord(wx);
    const lz = toLocalCoord(wz);
    for (let y = CHUNK_SY - 1; y >= 0; y--) {
      const id = chunk.voxels[voxelIndex(lx, y, lz)];
      if (id !== AIR && BLOCKS[id] && BLOCKS[id].solid) return y;
    }
    return -1;
  }

  /** Global light tint, driven by the day/night cycle. */
  setLightTint(color) {
    this.opaqueMaterial.color.copy(color);
    this.waterMaterial.color.copy(color);
  }

  dispose() {
    this.worker.terminate();
    for (const chunk of this.chunks.values()) {
      if (chunk.opaqueMesh) { this.scene.remove(chunk.opaqueMesh); chunk.opaqueMesh.geometry.dispose(); }
      if (chunk.waterMesh) { this.scene.remove(chunk.waterMesh); chunk.waterMesh.geometry.dispose(); }
    }
    this.chunks.clear();
  }
}
