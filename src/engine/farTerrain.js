/**
 * farTerrain.js — The ring of distant land past the render distance.
 *
 * Jev's pick for Phase 3 (JEV_DECISIONS.md): instead of stopping at the edge
 * of the loaded chunks, the Overworld carries on as low-detail tiles out to
 * FAR_REACH blocks, so a mountain range or a coastline shows long before you
 * reach it. Tiles are heightfields built off the main thread by
 * world/farWorker.js from the same terrain generator the chunks come from, so
 * the silhouette is the real one; they just have no caves, no blocks and no
 * per-block light.
 *
 * Within FINE_RANGE tiles sample every 4 blocks, further out every 8. Tiles
 * cover the loaded area too, but the material throws away anything over a
 * chunk that is on screen (a mask with one texel per chunk), so the two never
 * draw over each other and a chunk that has not loaded yet shows distant land
 * instead of a hole into the sky.
 */

import * as THREE from 'three';
import { BLOCKS, WATER } from '../world/blocks.js';
import { CHUNK_SX } from '../world/chunk.js';
import { getTilePalette } from '../world/textures.js';
import { createFarTerrainMaterial, farUniforms, FAR_MASK_SIZE } from './terrainMaterial.js';

const TILE = 64;
/** How far the distant land reaches, in blocks. */
export const FAR_REACH = 512;
/** Within this distance tiles are sampled every 4 blocks; beyond, every 8. */
const FINE_RANGE = 256;
/** Tiles being built at once; more would only delay the nearest. */
const MAX_IN_FLIGHT = 3;

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** A tile's average colour in linear light, which is how the GPU blends it into mipmaps. */
function averageColor(tile) {
  const palette = getTilePalette(tile);
  let r = 0, g = 0, b = 0;
  for (const c of palette) {
    r += toLinear((c >> 16) & 255);
    g += toLinear((c >> 8) & 255);
    b += toLinear(c & 255);
  }
  const n = palette.length || 1;
  return [r / n, g / n, b / n];
}

/** Every block's colour from above: the average of its top texture. */
function colorTable() {
  const table = {};
  for (const block of BLOCKS) {
    if (block?.tiles) table[block.id] = averageColor(block.tiles[2]);
  }
  // Water as its surface is drawn: the texture through the shader's blue tint
  // (FRAGMENT_LIGHT_WATER). The worker lets some of the floor show through.
  const [r, g, b] = table[WATER.id];
  table[WATER.id] = [r * 0.5, g * 0.66, b * 0.84];
  return table;
}

export class FarTerrain {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'farTerrain';
    scene.add(this.group);
    this.material = createFarTerrainMaterial();
    /** One byte per chunk around the centre: 255 where a real chunk is drawn. */
    this.mask = new Uint8Array(FAR_MASK_SIZE * FAR_MASK_SIZE);
    this.maskTexture = new THREE.DataTexture(this.mask, FAR_MASK_SIZE, FAR_MASK_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTexture.magFilter = this.maskTexture.minFilter = THREE.NearestFilter;
    this.maskTexture.needsUpdate = true;
    farUniforms.uChunkMask.value = this.maskTexture;
    /** What the mask was last drawn from: the world's readyEpoch and the corner chunk. */
    this._maskKey = '';
    /** key -> { mesh, step } */
    this.tiles = new Map();
    /** key -> the step being built */
    this.pending = new Map();
    this.worker = null;
    this.active = false;
  }

  /** Begin serving a world. */
  start(seed, terrainVersion) {
    this.stop();
    this.worker = new Worker(new URL('../world/workerEntry.js?far', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => this._onTile(event.data);
    this.worker.postMessage({ type: 'init', seed, terrainVersion, colors: colorTable() });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this._maskKey = '';
    for (const { mesh } of this.tiles.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.tiles.clear();
    this.pending.clear();
  }

  /** Shown only in the Overworld, above Low graphics, with the option on. */
  setActive(active) {
    this.active = active && !!this.worker;
    this.group.visible = this.active;
  }

  /** Keep the land around `center`, and out of the way of `world`'s chunks. */
  update(center, world) {
    if (!this.active) return;
    this._updateMask(center, world);

    const ctx = Math.floor(center.x / TILE);
    const ctz = Math.floor(center.z / TILE);
    const reach = Math.ceil(FAR_REACH / TILE) + 1;
    const wanted = new Map();
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const tx = ctx + dx, tz = ctz + dz;
        const x0 = tx * TILE, z0 = tz * TILE;
        const near = Math.hypot(
          Math.max(x0 - center.x, 0, center.x - (x0 + TILE)),
          Math.max(z0 - center.z, 0, center.z - (z0 + TILE))
        );
        if (near > FAR_REACH) continue;
        wanted.set(`${tx},${tz}`, { tx, tz, near, step: near < FINE_RANGE ? 4 : 8 });
      }
    }

    // Let go of what the ring has moved past.
    for (const [key, tile] of this.tiles) {
      if (wanted.has(key)) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      this.tiles.delete(key);
    }

    // Build what is missing, or at the wrong detail, nearest first.
    const queue = [...wanted]
      .filter(([key, w]) => this.tiles.get(key)?.step !== w.step && this.pending.get(key) !== w.step)
      .sort((a, b) => a[1].near - b[1].near);
    for (const [key, w] of queue) {
      if (this.pending.size >= MAX_IN_FLIGHT) break;
      this.pending.set(key, w.step);
      this.worker.postMessage({ type: 'tile', key, tx: w.tx, tz: w.tz, step: w.step });
    }
  }

  /** Mark the chunks the world is drawing, when that or the centre has changed. */
  _updateMask(center, world) {
    const half = FAR_MASK_SIZE / 2;
    const ocx = Math.floor(center.x / CHUNK_SX) - half;
    const ocz = Math.floor(center.z / CHUNK_SX) - half;
    const key = `${world.readyEpoch},${ocx},${ocz}`;
    if (key === this._maskKey) return;
    this._maskKey = key;

    this.mask.fill(0);
    for (const chunk of world.chunks.values()) {
      if (!chunk.ready) continue;
      const i = chunk.cx - ocx, j = chunk.cz - ocz;
      if (i >= 0 && j >= 0 && i < FAR_MASK_SIZE && j < FAR_MASK_SIZE) this.mask[j * FAR_MASK_SIZE + i] = 255;
    }
    this.maskTexture.needsUpdate = true;
    farUniforms.uMaskOrigin.value.set(ocx * CHUNK_SX, ocz * CHUNK_SX);
  }

  _onTile(msg) {
    if (msg.type !== 'tile') return;
    if (this.pending.get(msg.key) === msg.step) this.pending.delete(msg.key);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(msg.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(msg.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(msg.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.position.set(msg.tx * TILE, 0, msg.tz * TILE);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    // After the chunks, so whatever real terrain hides is rejected by the depth
    // test before it is shaded.
    mesh.renderOrder = 1;

    const old = this.tiles.get(msg.key);
    if (old) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
    }
    this.tiles.set(msg.key, { mesh, step: msg.step });
    this.group.add(mesh);
  }
}
