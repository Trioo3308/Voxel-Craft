/**
 * renderer.js — Three.js setup: renderer, scene, camera, lights, shadows, and
 * the post-processing chain.
 *
 * The world is lit by a real sun: a directional light with a shadow map that
 * follows the player, so trees, overhangs and mobs all throw shadows. The
 * picture is rendered in high dynamic range, then bloomed (glowing blocks write
 * values above 1, and bloom spreads them), colour graded for the time of day,
 * and tone mapped down to the screen.
 *
 * All of that is scaled by the Graphics option: "high" and "medium" differ in
 * shadow resolution and reach, and "low" turns shadows and post-processing off
 * altogether for weaker machines.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import Settings from '../settings.js';
import { CHUNK_SX } from '../world/chunk.js';
import { FarShadow, FAR_SHADOW_LAYER } from './farShadow.js';
import { terrainUniforms } from './terrainMaterial.js';

/**
 * Shadow map settings per Graphics level.
 *   size   shadow map resolution
 *   reach  half-width of the shadowed area, in blocks
 * At "high", 2048 texels over 128 blocks is one texel per pixel of a 16x16
 * block texture, so shadow edges land on the same grid as the art.
 *   far    a second, coarser map over the rest of the loaded area (farShadow.js)
 */
const QUALITY = {
  high: { shadows: true, size: 2048, reach: 64, post: true, soft: true, shadowEvery: 1, far: true },
  // Hard-edged shadows, redrawn every other frame: the sun moves slowly, and
  // half the shadow passes is most of the saving on an integrated GPU.
  medium: { shadows: true, size: 1024, reach: 44, post: true, soft: false, shadowEvery: 2 },
  low: { shadows: false, size: 512, reach: 32, post: false, soft: false, shadowEvery: 1 },
};

/**
 * Colour grade, applied in linear light before tone mapping: a tint that
 * follows the time of day, a saturation control, and a soft vignette.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uSaturation: { value: 1.08 },
    uVignette: { value: 0.22 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uSaturation;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb * uTint;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(luma), col, uSaturation), 0.0);
      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - uVignette * smoothstep(0.3, 0.8, d);
      gl_FragColor = vec4(col, c.a);
    }
  `,
};

/**
 * Ten stages of cracks, side by side in one strip.
 *
 * The cracks are grown, not drawn per stage: a few random walks out from the
 * middle of the face, with every pixel remembering the step it was laid on.
 * Stage n shows the first n tenths of that growth, so each stage contains the
 * one before it and the block visibly splits further as you mine.
 */
function paintCrackStages() {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size * 10;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  let seed = 0x5eed;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const order = new Map();
  let step = 0;
  const lay = (x, y) => {
    const key = x + y * size;
    if (x < 0 || y < 0 || x >= size || y >= size || order.has(key)) return;
    order.set(key, step++);
  };
  for (let branch = 0; branch < 6; branch++) {
    let x = 7 + Math.floor(rnd() * 3), y = 7 + Math.floor(rnd() * 3);
    const angle = (branch / 6) * Math.PI * 2 + rnd() * 0.6;
    let dx = Math.cos(angle), dy = Math.sin(angle);
    for (let n = 0; n < 11; n++) {
      lay(Math.round(x), Math.round(y));
      // Wander, so the cracks look split rather than ruled.
      const turn = (rnd() - 0.5) * 0.9;
      [dx, dy] = [dx * Math.cos(turn) - dy * Math.sin(turn), dx * Math.sin(turn) + dy * Math.cos(turn)];
      x += dx;
      y += dy;
      if (rnd() < 0.25) lay(Math.round(x + dy), Math.round(y - dx));
    }
  }

  for (let stage = 0; stage < 10; stage++) {
    const limit = ((stage + 1) / 10) * step;
    for (const [key, laid] of order) {
      if (laid > limit) continue;
      const x = key % size, y = Math.floor(key / size);
      ctx.fillStyle = laid < limit * 0.6 ? 'rgba(12,10,8,0.8)' : 'rgba(12,10,8,0.55)';
      ctx.fillRect(stage * size + x, y, 1, 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(1 / 10, 1);
  return texture;
}

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
    // Neutral keeps pixel-art colours true where ACES would push them yellow,
    // while still rolling off highlights so lava and the sun can glow.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
    this.farShadow = new FarShadow();
    /** Where the shadow maps are centred; set each frame by updateShadowFocus. */
    this._shadowFocus = new THREE.Vector3();
    this._initSelectionBox();
    this._initCracks();
    this._initPost();
    this.setQuality('high');

    window.addEventListener('resize', () => this.resize());
  }

  _initLights() {
    // Sky/ground hemisphere gives entities soft ambient fill. Terrain computes
    // its own ambient from the mesher's sky channel instead.
    this.hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x4a4335, 0.9);
    this.scene.add(this.hemiLight);

    // The sun (or, at night, the moon). The one light that casts shadows.
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sunLight.position.set(60, 100, 30);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.04;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 420;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    // The terrain shader needs to know where this map ends and the far one takes over.
    terrainUniforms.uNearShadowMatrix.value = this.sunLight.shadow.matrix;
    /** Unit vector toward the light, set by the sky each frame. */
    this.sunDirection = new THREE.Vector3(0.3, 0.9, 0.3).normalize();

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambientLight);

    // The far shadow pass (farShadow.js) has to see the same lights as the main
    // one, or Three rechecks every lit material's program after each pass.
    for (const light of [this.hemiLight, this.sunLight, this.ambientLight]) light.layers.enable(FAR_SHADOW_LAYER);
  }

  _initPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Only light well past white blooms: emissive blocks, the sun, sparkles on
    // water. At a threshold of 1 a white sheep in full sun glowed like a lamp.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.55, 0.35, 1.2
    );
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());
  }

  /** Apply a Graphics level: 'high', 'medium' or 'low'. */
  setQuality(level) {
    const q = QUALITY[level] ?? QUALITY.high;
    this.quality = level;
    this.postEnabled = q.post;

    const type = q.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    const shadowsChanged = this.renderer.shadowMap.enabled !== q.shadows || this.renderer.shadowMap.type !== type;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = type;
    this.shadowEvery = q.shadowEvery;
    this.renderer.shadowMap.autoUpdate = q.shadowEvery <= 1;
    this.sunLight.castShadow = q.shadows;
    this.farShadow.setEnabled(q.shadows && !!q.far);
    this.shadowReach = q.reach;
    const cam = this.sunLight.shadow.camera;
    cam.left = -q.reach;
    cam.right = q.reach;
    cam.top = q.reach;
    cam.bottom = -q.reach;
    cam.updateProjectionMatrix();
    if (this.sunLight.shadow.mapSize.x !== q.size) {
      this.sunLight.shadow.mapSize.set(q.size, q.size);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    // Materials bake the shadow code in when compiled, so a change of shadow
    // state has to recompile them.
    if (shadowsChanged) {
      this.scene.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const m of materials) if (m) m.needsUpdate = true;
      });
    }
  }

  /**
   * Keep the shadowed area centred on the player.
   *
   * The centre is snapped to the shadow map's texel grid in the light's own
   * frame, otherwise every step you took would shift the texels under the
   * shadow edges and they would crawl and shimmer.
   */
  updateShadowFocus(center) {
    const dir = this.sunDirection;
    const light = this.sunLight;
    this._shadowFocus.copy(center);
    if (!light.castShadow) {
      light.position.copy(center).addScaledVector(dir, 200);
      light.target.position.copy(center);
      light.target.updateMatrixWorld();
      return;
    }

    const texel = (this.shadowReach * 2) / light.shadow.mapSize.x;
    // A basis for the light's view: `right` and `up` span the shadow map.
    const up = Math.abs(dir.y) > 0.99 ? _xAxis : _yAxis;
    _right.crossVectors(up, dir).normalize();
    _up.crossVectors(dir, _right).normalize();
    const r = Math.round(center.dot(_right) / texel) * texel;
    const u = Math.round(center.dot(_up) / texel) * texel;
    const d = center.dot(dir);
    _snapped.copy(_right).multiplyScalar(r).addScaledVector(_up, u).addScaledVector(dir, d);

    light.target.position.copy(_snapped);
    light.position.copy(_snapped).addScaledVector(dir, 200);
    light.target.updateMatrixWorld();
  }

  /** Grade and bloom settings for this moment, pushed in by the sky. */
  setGrade(tint, saturation, bloomStrength) {
    this.gradePass.uniforms.uTint.value.copy(tint);
    this.gradePass.uniforms.uSaturation.value = saturation;
    this.bloomPass.strength = bloomStrength;
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

  /** A box just larger than a block, wearing the crack strip. */
  _initCracks() {
    this.crackTexture = paintCrackStages();
    this.crackBox = new THREE.Mesh(
      new THREE.BoxGeometry(1.004, 1.004, 1.004),
      new THREE.MeshBasicMaterial({
        map: this.crackTexture,
        transparent: true,
        depthWrite: false,
        // Pulled toward the camera so it never fights the block's own faces.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    this.crackBox.visible = false;
    this.crackBox.renderOrder = 3;
    this.scene.add(this.crackBox);
  }

  /** Show cracks on the block being mined, `progress` from 0 to 1. */
  setBreakProgress(target, progress) {
    if (!target || progress <= 0.001 || progress >= 1) {
      this.crackBox.visible = false;
      return;
    }
    this.crackBox.visible = true;
    this.crackBox.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    this.crackTexture.offset.x = Math.min(9, Math.floor(progress * 10)) / 10;
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

  /** The FOV chosen in settings; effects scale it with `setFovScale`. */
  setBaseFov(degrees) {
    this.baseFov = degrees;
    this._applyFov();
  }

  /** Multiplier on the base FOV, for sprint and boost effects. */
  setFovScale(scale) {
    if (Math.abs(scale - (this.fovScale ?? 1)) < 1e-4) return;
    this.fovScale = scale;
    this._applyFov();
  }

  _applyFov() {
    this.camera.fov = (this.baseFov ?? Settings.fov) * (this.fovScale ?? 1);
    this.camera.updateProjectionMatrix();
  }

  /** Move the fog horizon to match a new render distance, in chunks. */
  setViewDistance(chunks) {
    const far = chunks * CHUNK_SX;
    if (this.scene.fog) {
      this.scene.fog.near = far * Settings.fogStart;
      this.scene.fog.far = far;
    }
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Settings.maxPixelRatio));
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  render() {
    // The far map covers the loaded area; nothing to draw with the light gone.
    if (this.sunLight.castShadow && this.sunLight.intensity > 0.01) {
      const reach = Math.max(96, Settings.renderDistance * CHUNK_SX + CHUNK_SX);
      this.farShadow.update(this.renderer, this.scene, this._shadowFocus, this.sunDirection, reach);
    }
    if (this.shadowEvery > 1) {
      this._frame = (this._frame ?? 0) + 1;
      if (this._frame % this.shadowEvery === 0) this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.postEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get drawCalls() {
    return this.renderer.info.render.calls;
  }

  get triangles() {
    return this.renderer.info.render.triangles;
  }
}

const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _snapped = new THREE.Vector3();
