/**
 * renderer.js — Three.js setup: renderer, scene, camera, lights, selection box.
 *
 * Chunk geometry is unlit (its shading is baked in by the mesher), so the
 * lights here exist for entities — mobs and dropped items — which use Lambert
 * materials and need to visibly darken at night.
 */

import * as THREE from 'three';
import Settings from '../settings.js';
import { CHUNK_SX } from '../world/chunk.js';

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // crisp pixel-art edges, and noticeably cheaper
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Settings.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      Settings.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );

    // Fog is doubling as the render-distance horizon: it hides chunks popping
    // in at the edge of the loaded area.
    const far = Settings.renderDistance * CHUNK_SX;
    this.scene.fog = new THREE.Fog(0x87ceeb, far * Settings.fogStart, far);
    this.scene.background = new THREE.Color(0x87ceeb);

    this._initLights();
    this._initSelectionBox();

    window.addEventListener('resize', () => this.resize());
  }

  _initLights() {
    // Sky/ground hemisphere gives entities soft ambient fill.
    this.hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x4a4335, 0.9);
    this.scene.add(this.hemiLight);

    // Sun. Shadows are intentionally off — they are the single most expensive
    // feature to enable and the baked chunk AO already conveys depth.
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sunLight.position.set(60, 100, 30);
    this.scene.add(this.sunLight);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambientLight);
  }

  /** Wireframe cube drawn around the block under the crosshair. */
  _initSelectionBox() {
    const geometry = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const edges = new THREE.EdgesGeometry(geometry);
    this.selectionBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.5,
        depthTest: true,
      })
    );
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);
  }

  /** Position (or hide) the block highlight. */
  setSelection(target) {
    if (!target) {
      this.selectionBox.visible = false;
      return;
    }
    this.selectionBox.visible = true;
    this.selectionBox.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Settings.maxPixelRatio));
    this.renderer.setSize(width, height);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  get drawCalls() {
    return this.renderer.info.render.calls;
  }

  get triangles() {
    return this.renderer.info.render.triangles;
  }
}
