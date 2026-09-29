/**
 * dynamicLight.js — Light that moves: a torch in your hand, a glowing mob.
 *
 * Placed light is flood-filled in the worker and baked into the terrain mesh,
 * which is exactly right for a torch on a wall and useless for one you are
 * carrying: re-meshing every chunk you walk past, every step, is out of the
 * question. So moving light lives here instead, in a small cube of the world
 * around the camera:
 *
 *   - Each source is flood-filled on the CPU with the same rule as block light
 *     (one level lost per step, opaque blocks stop it), so a held torch does
 *     not shine through walls the way a plain point light would.
 *   - The result is uploaded as a 3D texture that the terrain shader samples,
 *     and read directly on the CPU to light mobs and items.
 *
 * The flood is redone only when a source moves to another block, a source
 * appears or goes out, the cube recentres, or a block changes inside it — not
 * every frame. A torch-sized flood touches a few thousand cells, well under a
 * millisecond.
 */

import * as THREE from 'three';
import { BLOCKS } from '../world/blocks.js';
import { terrainUniforms } from './terrainMaterial.js';

/** Cells per side of the lit cube around the camera. */
export const DYN_SIZE = 40;
/** The cube recentres in steps this big, so walking does not refill it constantly. */
const RECENTRE_STEP = 4;
/** At most this many floods per second, however busy things get. */
const MAX_REFRESH_HZ = 15;

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class DynamicLight {
  constructor() {
    const n = DYN_SIZE;
    this.levels = new Uint8Array(n * n * n);
    /** Byte copy scaled to 0-255 for the texture. */
    this.texels = new Uint8Array(n * n * n);
    this.texture = new THREE.Data3DTexture(this.texels, n, n, n);
    this.texture.format = THREE.RedFormat;
    this.texture.type = THREE.UnsignedByteType;
    // Linear filtering smooths the light across cells, the way smooth
    // lighting smooths placed light across vertices.
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this.origin = new THREE.Vector3(1e9, 0, 0);
    this._signature = '';
    this._dirty = true;
    this._cooldown = 0;
    this._queue = new Int32Array(n * n * n);

    terrainUniforms.uDynLight.value = this.texture;
    terrainUniforms.uDynOrigin.value = this.origin;
    terrainUniforms.uDynInvSize.value = 1 / n;
  }

  /** A block changed: refill if it could have moved light inside the cube. */
  markDirty(wx, wy, wz) {
    const n = DYN_SIZE;
    const x = wx - this.origin.x, y = wy - this.origin.y, z = wz - this.origin.z;
    if (x >= 0 && y >= 0 && z >= 0 && x < n && y < n && z < n) this._dirty = true;
  }

  /**
   * @param center where the cube should be centred (the camera)
   * @param sources [{x, y, z, level}] in world coordinates
   */
  update(dt, world, center, sources) {
    this._cooldown -= dt;
    const n = DYN_SIZE;
    const half = n / 2;
    const snap = (v) => Math.floor((v - half) / RECENTRE_STEP) * RECENTRE_STEP;
    const ox = snap(center.x), oy = Math.max(-half, snap(center.y)), oz = snap(center.z);
    if (ox !== this.origin.x || oy !== this.origin.y || oz !== this.origin.z) {
      this.origin.set(ox, oy, oz);
      this._dirty = true;
    }

    // What the sources look like right now, as whole blocks. If that and the
    // cube have not changed, neither has the light.
    let signature = '';
    for (const s of sources) signature += `${Math.floor(s.x)},${Math.floor(s.y)},${Math.floor(s.z)},${s.level};`;
    if (signature !== this._signature) {
      this._signature = signature;
      this._dirty = true;
    }
    if (!this._dirty || this._cooldown > 0) return;
    this._dirty = false;
    this._cooldown = 1 / MAX_REFRESH_HZ;

    this.levels.fill(0);
    for (const s of sources) this._flood(world, s);
    for (let i = 0; i < this.levels.length; i++) this.texels[i] = this.levels[i] * 17; // 15 -> 255
    this.texture.needsUpdate = true;
  }

  /** Breadth-first flood from one source, losing a level per step. */
  _flood(world, source) {
    const n = DYN_SIZE;
    const levels = this.levels;
    const queue = this._queue;
    const sx = Math.floor(source.x) - this.origin.x;
    const sy = Math.floor(source.y) - this.origin.y;
    const sz = Math.floor(source.z) - this.origin.z;
    if (sx < 0 || sy < 0 || sz < 0 || sx >= n || sy >= n || sz >= n) return;

    // x fastest, then y, then z: the layout a 3D texture is uploaded in.
    const index = (x, y, z) => x + n * (y + n * z);
    let head = 0, tail = 0;
    const start = index(sx, sy, sz);
    if (levels[start] >= source.level) return;
    levels[start] = source.level;
    queue[tail++] = start;

    const ox = this.origin.x, oy = this.origin.y, oz = this.origin.z;
    while (head < tail) {
      const i = queue[head++];
      const level = levels[i];
      if (level <= 1) continue;
      const x = i % n, y = Math.floor(i / n) % n, z = Math.floor(i / (n * n));
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) continue;
        const j = index(nx, ny, nz);
        if (levels[j] >= level - 1) continue;
        const def = BLOCKS[world.getBlock(ox + nx, oy + ny, oz + nz)];
        if (def && def.opaque) continue;
        levels[j] = level - 1;
        queue[tail++] = j;
      }
    }
  }

  /** Moving light (0-15) at a world position, for lighting mobs and items. */
  levelAt(wx, wy, wz) {
    const n = DYN_SIZE;
    const x = Math.floor(wx) - this.origin.x;
    const y = Math.floor(wy) - this.origin.y;
    const z = Math.floor(wz) - this.origin.z;
    if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) return 0;
    return this.levels[x + n * (y + n * z)];
  }

  /** Nothing is lit: used when a world unloads or you change dimension. */
  clear() {
    this.levels.fill(0);
    this.texels.fill(0);
    this.texture.needsUpdate = true;
    this._signature = '';
    this._dirty = true;
  }
}
