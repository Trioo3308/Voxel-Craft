/**
 * farShadow.js — A second, coarser shadow map for the ground past the sun's own.
 *
 * Part of Jev's far-rendering pick for Phase 3 (JEV_DECISIONS.md). The sun's
 * shadow map (renderer.js) covers 64 blocks round the player at pixel-art
 * resolution; past that, a forest stood in full sun however low the sun was,
 * and a mountain threw no shadow across the valley below it. On High this map
 * covers the whole loaded area at a coarser grain, is redrawn every few
 * frames, and holds nothing but chunks. The terrain shader (terrainMaterial.js)
 * reads it where the sun's own map runs out, fading from one to the other.
 *
 * Three.js gives a directional light a single shadow map, so this one is drawn
 * by hand: chunk meshes also sit on FAR_SHADOW_LAYER (world.js), and a camera
 * that sees only that layer draws them into a render target with the terrain's
 * depth material, which cuts leaves out the same way the sun's map does.
 */

import * as THREE from 'three';
import { createTerrainDepthMaterial, terrainUniforms } from './terrainMaterial.js';
import { getAtlasTexture } from '../world/textures.js';

/** The layer chunk meshes add themselves to, so this camera sees only them. */
export const FAR_SHADOW_LAYER = 1;
/** Texels across the map. */
const SIZE = 2048;
/** Frames between redraws: the sun moves slowly and the map is texel-snapped. */
const EVERY = 6;
/** How far back from the centre the light camera stands; it sees twice this deep. */
const STANDOFF = 500;

const BIAS = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1
);

export class FarShadow {
  constructor() {
    /** Set by the Graphics level; see renderer.js. */
    this.enabled = false;
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, STANDOFF * 2);
    this.camera.layers.set(FAR_SHADOW_LAYER);
    this.material = createTerrainDepthMaterial();
    // Back faces, as Three draws the sun's map: a lit face is never compared
    // against itself, so there is no acne to bias away.
    this.material.side = THREE.BackSide;
    this.material.alphaTest = 0.5;
    this._frame = 0;
    this._reach = 0;
    this._clear = new THREE.Color();

    terrainUniforms.uFarShadowMap.value = this.target.texture;
    terrainUniforms.uFarShadowTexel.value = 1 / SIZE;
  }

  setEnabled(on) {
    this.enabled = on;
    terrainUniforms.uFarShadowOn.value = on ? 1 : 0;
  }

  /**
   * Redraw the map every few frames.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} center    what the map is centred on (the camera)
   * @param {THREE.Vector3} direction unit vector toward the light
   * @param {number} reach            half-width of the map, in blocks
   */
  update(renderer, scene, center, direction, reach) {
    if (!this.enabled || this._frame++ % EVERY !== 0) return;
    this.material.map ??= getAtlasTexture();

    const camera = this.camera;
    if (reach !== this._reach) {
      this._reach = reach;
      camera.left = camera.bottom = -reach;
      camera.right = camera.top = reach;
      camera.updateProjectionMatrix();
    }

    // Snap the centre to the texel grid in the light's own frame, as the
    // sun's map does, so shadow edges hold still while you walk.
    const texel = (reach * 2) / SIZE;
    const up = Math.abs(direction.y) > 0.99 ? _xAxis : _yAxis;
    _right.crossVectors(up, direction).normalize();
    _up.crossVectors(direction, _right).normalize();
    const r = Math.round(center.dot(_right) / texel) * texel;
    const u = Math.round(center.dot(_up) / texel) * texel;
    _snapped.copy(_right).multiplyScalar(r).addScaledVector(_up, u).addScaledVector(direction, center.dot(direction));
    camera.position.copy(_snapped).addScaledVector(direction, STANDOFF);
    camera.up.copy(_up);
    camera.lookAt(_snapped);
    camera.updateMatrixWorld();
    terrainUniforms.uFarShadowMatrix.value
      .copy(BIAS).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);

    // Draw only the chunks, as depth, cleared to "nothing in the way". The
    // sun's own map must not be redrawn by this pass.
    const background = scene.background;
    const override = scene.overrideMaterial;
    const target = renderer.getRenderTarget();
    const autoUpdate = renderer.shadowMap.autoUpdate;
    const needsUpdate = renderer.shadowMap.needsUpdate;
    renderer.getClearColor(this._clear);
    const clearAlpha = renderer.getClearAlpha();

    scene.background = null;
    scene.overrideMaterial = this.material;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, camera);

    renderer.setRenderTarget(target);
    renderer.setClearColor(this._clear, clearAlpha);
    renderer.shadowMap.autoUpdate = autoUpdate;
    renderer.shadowMap.needsUpdate = needsUpdate;
    scene.overrideMaterial = override;
    scene.background = background;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}

const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snapped = new THREE.Vector3();
