/**
 * signRenderer.js — Draws the text on signs in the world.
 *
 * Signs are block entities, not meshes, so their text cannot go through the
 * chunk mesher: it changes without the block changing, and re-meshing a chunk
 * every time somebody edits a sign would be absurd. Instead each visible sign
 * gets one textured quad, built from a canvas.
 *
 * Two things keep that cheap:
 *   - only signs within `VISIBLE_RANGE` have a mesh at all, and the set is
 *     rebuilt on a slow timer rather than every frame;
 *   - the canvas is only redrawn when the text actually changes, tracked by
 *     comparing the joined lines against what was last drawn.
 */

import * as THREE from 'three';

/** Signs further than this get no mesh. */
const VISIBLE_RANGE = 32;

/** Seconds between rebuilds of the visible set. */
const REFRESH_INTERVAL = 0.5;

/** Canvas resolution. Four lines of fifteen characters, at a legible size. */
const CANVAS_W = 256;
const CANVAS_H = 128;
const LINES = 4;

export class SignRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./world.js').World} world
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    /** @type {Map<string, {mesh: THREE.Mesh, canvas: HTMLCanvasElement, texture: THREE.Texture, drawn: string}>} */
    this.signs = new Map();
    this._timer = 0;
  }

  /**
   * @param dt seconds
   * @param {THREE.Vector3} viewer where the player is
   * @param signBlockId the id a sign block has, so this module needs no import
   */
  update(dt, viewer, signBlockId) {
    this._timer -= dt;
    if (this._timer > 0) return;
    this._timer = REFRESH_INTERVAL;

    const wanted = new Set();

    for (const [key, entity] of this.world.blockEntities) {
      if (entity.type !== 'sign') continue;
      // Keys are "dimension:x,y,z"; only this dimension's signs are in the
      // scene, and the rest must not be drawn floating in the wrong world.
      const [dimension, coords] = splitKey(key);
      if (dimension !== this.world.dimension) continue;

      const [x, y, z] = coords.split(',').map(Number);
      if (Math.hypot(x + 0.5 - viewer.x, y + 0.5 - viewer.y, z + 0.5 - viewer.z) > VISIBLE_RANGE) {
        continue;
      }
      // The block may have been mined without the entity being cleaned up yet.
      if (this.world.getBlock(x, y, z) !== signBlockId) continue;

      wanted.add(key);
      this._sync(key, x, y, z, entity.state.lines ?? []);
    }

    // Drop anything that has gone out of range or stopped being a sign.
    for (const key of [...this.signs.keys()]) {
      if (!wanted.has(key)) this._remove(key);
    }
  }

  /** Create or refresh one sign's quad. */
  _sync(key, x, y, z, lines) {
    const text = lines.join('\n');
    let entry = this.signs.get(key);

    if (!entry) {
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const texture = new THREE.CanvasTexture(canvas);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;

      // Slightly proud of the plank so it never z-fights with it, and drawn on
      // both sides so a sign is readable from behind rather than invisible.
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.86, 0.43),
        new THREE.MeshBasicMaterial({
          map: texture, transparent: true, side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      // Matches SHAPES.SIGN: the board spans y 0.5..1 and sits at z ~0.5.
      mesh.position.set(x + 0.5, y + 0.75, z + 0.5 - 0.0662);
      this.scene.add(mesh);

      entry = { mesh, canvas, texture, drawn: null };
      this.signs.set(key, entry);
    }

    if (entry.drawn === text) return;
    entry.drawn = text;
    this._paint(entry, lines);
    entry.texture.needsUpdate = true;
  }

  _paint(entry, lines) {
    const ctx = entry.canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#241705';
    ctx.font = '600 22px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lineHeight = CANVAS_H / LINES;
    for (let i = 0; i < LINES; i++) {
      const line = lines[i];
      if (!line) continue;
      ctx.fillText(line, CANVAS_W / 2, lineHeight * (i + 0.5), CANVAS_W - 12);
    }
  }

  _remove(key) {
    const entry = this.signs.get(key);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
    entry.texture.dispose();
    this.signs.delete(key);
  }

  /** Drop everything — called when the world or dimension changes. */
  clear() {
    for (const key of [...this.signs.keys()]) this._remove(key);
    this._timer = 0;
  }

  dispose() {
    this.clear();
  }
}

/** Split a "dimension:x,y,z" block-entity key. */
function splitKey(key) {
  const at = key.indexOf(':');
  return at === -1 ? ['overworld', key] : [key.slice(0, at), key.slice(at + 1)];
}
