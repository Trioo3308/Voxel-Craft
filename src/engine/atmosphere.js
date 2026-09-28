/**
 * atmosphere.js — Everything drawn behind the world: the sky dome, the sun and
 * moon, the stars, and the clouds.
 *
 * The sky was a single flat colour. Jev picked a hybrid look for its
 * replacement (see JEV_DECISIONS.md): pixel-art square sun and moon, with the
 * moon going through its phases day by day, set in painted gradients with a
 * glow along the horizon at dawn and dusk, pixel stars and a faint milky way
 * at night, and 3D blocky clouds whose undersides catch the sunset.
 *
 * Nothing here decides *what* colour anything is. The sky cycle (sky.js)
 * works that out from the time of day, weather and dimension, and pushes it in
 * through `update`.
 */

import * as THREE from 'three';

/** Sky dome radius. Inside the camera's far plane, outside everything else. */
const DOME_RADIUS = 450;
/** How far away the sun and moon sit, and how big they look. */
const SUN_DISTANCE = 400;
const SUN_SIZE = 46;
const MOON_SIZE = 40;

/** Clouds: one cell is 12x12 blocks and four deep, as in Minecraft. */
const CLOUD_CELL = 12;
const CLOUD_HEIGHT = 140;
const CLOUD_THICKNESS = 4;
/** Cells drawn in each direction from the camera. */
const CLOUD_RADIUS = 22;
/** Blocks per second the cloud field drifts. */
const CLOUD_SPEED = 1.2;

// ---------------------------------------------------------------------------
// Pixel art for the sun and moon
// ---------------------------------------------------------------------------

function pixelCanvas(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  paint((x, y, colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, 1, 1);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A square sun, white-hot in the middle, in the Minecraft manner. */
function paintSun() {
  return pixelCanvas(16, 16, (set) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const edge = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (edge < 3) set(x, y, '#fffdf2');
        else if (edge < 5) set(x, y, '#fff1b0');
        else if (edge < 6.5) set(x, y, '#ffd66e');
        else if (edge < 7.5 && (x + y) % 2 === 0) set(x, y, 'rgba(255,190,90,0.55)');
      }
    }
  });
}

/**
 * Eight moon phases side by side, full on the left through to new. Each is a
 * pale square with craters, with the shadow sweeping across it column by
 * column.
 */
function paintMoonPhases() {
  const craters = [[5, 5], [9, 6], [6, 10], [10, 10], [8, 8]];
  return pixelCanvas(16 * 8, 16, (set) => {
    for (let phase = 0; phase < 8; phase++) {
      const ox = phase * 16;
      // 0 full, 4 new; the lit part shrinks from one side then grows back.
      const lit = phase <= 4 ? 1 - phase / 4 : (phase - 4) / 4;
      const waning = phase <= 4;
      for (let y = 2; y < 14; y++) {
        for (let x = 2; x < 14; x++) {
          const t = (x - 2) / 11;
          const inLight = waning ? t <= lit : t >= 1 - lit;
          const crater = craters.some(([cx, cy]) => Math.abs(x - cx) + Math.abs(y - cy) <= 1);
          if (inLight) set(ox + x, y, crater ? '#b7bfcf' : '#eef1f8');
          else set(ox + x, y, 'rgba(40,48,70,0.55)');
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Sky dome shader
// ---------------------------------------------------------------------------

const DOME_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // pinned to the far plane
  }
`;

const DOME_FRAGMENT = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uGlowColor;
  uniform float uGlow;
  uniform vec3 uSunDir;
  uniform float uNight;
  uniform float uTime;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = d.y;

    // Gradient: horizon to zenith above, fading to a darker ground below.
    vec3 col = up >= 0.0
      ? mix(uHorizon, uZenith, pow(up, 0.55))
      : mix(uHorizon, uGround, smoothstep(0.0, 0.25, -up));

    // Dawn and dusk: a warm band hugging the horizon, strongest toward the sun.
    float toward = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
    float band = exp(-abs(up) * 7.0);
    col += uGlowColor * uGlow * band * (0.35 + 0.65 * pow(toward, 3.0));

    // A soft halo around the sun itself, which bloom spreads further.
    col += uGlowColor * pow(max(dot(d, uSunDir), 0.0), 64.0) * 0.6 * (1.0 - uNight);

    // Stars: the view direction snapped to a grid, so each star is one crisp
    // pixel-like point rather than a smooth dot.
    if (uNight > 0.01 && up > -0.05) {
      vec3 cell = floor(d * 170.0);
      float h = hash(cell);
      float star = step(0.9968, h);
      float twinkle = 0.65 + 0.35 * sin(uTime * (1.3 + h * 4.0) + h * 60.0);
      float fade = smoothstep(-0.05, 0.2, up);
      col += vec3(0.9, 0.95, 1.1) * star * twinkle * uNight * fade * 1.4;

      // A faint milky way along a tilted great circle.
      vec3 bandNormal = normalize(vec3(0.35, 0.25, 1.0));
      float along = exp(-pow(dot(d, bandNormal) * 5.5, 2.0));
      float grain = hash(floor(d * 90.0)) * 0.6 + 0.4;
      col += vec3(0.05, 0.06, 0.1) * along * grain * uNight * fade;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

const CLOUD_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vNormal = normal;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uSide;
  uniform vec3 uBottom;
  uniform float uOpacity;
  uniform float uFade;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vec3 col = vNormal.y > 0.5 ? uTop : (vNormal.y < -0.5 ? uBottom : uSide);
    float dist = length(vWorld.xz - cameraPosition.xz);
    float fade = 1.0 - smoothstep(uFade * 0.55, uFade, dist);
    if (fade <= 0.0) discard;
    gl_FragColor = vec4(col, uOpacity * fade);
  }
`;

/** Deterministic cloud cover for one cell. */
function cloudAt(cx, cz) {
  // Two octaves of value noise, cheap enough to rebuild a field on the fly.
  const v = valueNoise(cx * 0.19, cz * 0.19) * 0.7 + valueNoise(cx * 0.53 + 11, cz * 0.53 - 7) * 0.3;
  return v > 0.56;
}

function hash2(x, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0), b = hash2(x0 + 1, z0);
  const c = hash2(x0, z0 + 1), d = hash2(x0 + 1, z0 + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

export class Atmosphere {
  constructor(scene) {
    this.scene = scene;

    // ---- Dome ----------------------------------------------------------------
    this.domeUniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uGlowColor: { value: new THREE.Color() },
      uGlow: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uTime: { value: 0 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_RADIUS, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.domeUniforms,
        vertexShader: DOME_VERTEX,
        fragmentShader: DOME_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    // ---- Sun and moon ----------------------------------------------------------
    // Colours above 1 so bloom gives the sun a halo; sprites always face you.
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: paintSun(), color: new THREE.Color(3.2, 3.0, 2.6), fog: false, depthWrite: false,
    }));
    this.sun.scale.setScalar(SUN_SIZE);
    this.sun.renderOrder = -9;
    this.sun.frustumCulled = false;
    scene.add(this.sun);

    this.moonTexture = paintMoonPhases();
    this.moonTexture.repeat.set(1 / 8, 1);
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.moonTexture, color: new THREE.Color(1.5, 1.55, 1.7), fog: false, depthWrite: false,
    }));
    this.moon.scale.setScalar(MOON_SIZE);
    this.moon.renderOrder = -9;
    this.moon.frustumCulled = false;
    scene.add(this.moon);

    // ---- Clouds ------------------------------------------------------------------
    this.cloudUniforms = {
      uTop: { value: new THREE.Color(1, 1, 1) },
      uSide: { value: new THREE.Color(0.85, 0.87, 0.9) },
      uBottom: { value: new THREE.Color(0.7, 0.72, 0.78) },
      uOpacity: { value: 0.82 },
      uFade: { value: CLOUD_RADIUS * CLOUD_CELL },
    };
    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      transparent: true,
      depthWrite: true,
      // Seen from below and from above (from a mountain or an Aether island).
      side: THREE.DoubleSide,
      fog: false,
    });
    this.clouds = new THREE.Mesh(new THREE.BufferGeometry(), this.cloudMaterial);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 2;
    scene.add(this.clouds);
    this._cloudKey = null;
    this._cloudDrift = 0;
    this.cloudsEnabled = true;
  }

  /**
   * @param state computed by the sky cycle for this frame:
   *   zenith, horizon, ground, glowColor (Colors), glow, night (0..1),
   *   sunDir (toward the sun), showSun, showMoon, moonPhase (0..7),
   *   clouds (bool), cloudTop / cloudSide / cloudBottom (Colors), time
   */
  update(dt, camera, state) {
    const u = this.domeUniforms;
    u.uZenith.value.copy(state.zenith);
    u.uHorizon.value.copy(state.horizon);
    u.uGround.value.copy(state.ground);
    u.uGlowColor.value.copy(state.glowColor);
    u.uGlow.value = state.glow;
    u.uSunDir.value.copy(state.sunDir);
    u.uNight.value = state.night;
    u.uTime.value = state.time;
    this.dome.position.copy(camera.position);

    this.sun.visible = state.showSun;
    this.sun.position.copy(camera.position).addScaledVector(state.sunDir, SUN_DISTANCE);
    this.moon.visible = state.showMoon;
    this.moon.position.copy(camera.position).addScaledVector(state.sunDir, -SUN_DISTANCE);
    this.moonTexture.offset.x = (state.moonPhase % 8) / 8;

    this._updateClouds(dt, camera, state);
  }

  _updateClouds(dt, camera, state) {
    const show = state.clouds && this.cloudsEnabled;
    this.clouds.visible = show;
    if (!show) return;

    this.cloudUniforms.uTop.value.copy(state.cloudTop);
    this.cloudUniforms.uSide.value.copy(state.cloudSide);
    this.cloudUniforms.uBottom.value.copy(state.cloudBottom);
    this.cloudUniforms.uOpacity.value = state.cloudOpacity ?? 0.82;

    // The field drifts east. The mesh slides smoothly and is rebuilt only when
    // the camera or the drift crosses a whole cell.
    this._cloudDrift += dt * CLOUD_SPEED;
    const driftCells = Math.floor(this._cloudDrift / CLOUD_CELL);
    const camCellX = Math.floor(camera.position.x / CLOUD_CELL);
    const camCellZ = Math.floor(camera.position.z / CLOUD_CELL);
    const key = `${camCellX + driftCells},${camCellZ}`;
    if (key !== this._cloudKey) {
      this._cloudKey = key;
      this._buildClouds(camCellX, camCellZ, driftCells);
      this._builtDrift = driftCells;
    }
    // Slide by the part of the drift not yet baked into the geometry.
    this.clouds.position.x = this._cloudDrift - this._builtDrift * CLOUD_CELL;
  }

  /**
   * Build the cloud field around a cell as boxes, with faces between two
   * cloudy cells left out, so neighbouring cells merge into one mass.
   */
  _buildClouds(camCellX, camCellZ, driftCells) {
    const positions = [];
    const normals = [];
    const indices = [];
    const quad = (corners, n) => {
      const base = positions.length / 3;
      for (const c of corners) {
        positions.push(c[0], c[1], c[2]);
        normals.push(n[0], n[1], n[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    const y0 = CLOUD_HEIGHT, y1 = CLOUD_HEIGHT + CLOUD_THICKNESS;
    // The pattern is indexed by cell minus drift, so it moves with the wind.
    const cloudy = (x, z) => cloudAt(x - driftCells, z);

    for (let dz = -CLOUD_RADIUS; dz <= CLOUD_RADIUS; dz++) {
      for (let dx = -CLOUD_RADIUS; dx <= CLOUD_RADIUS; dx++) {
        if (dx * dx + dz * dz > CLOUD_RADIUS * CLOUD_RADIUS) continue;
        const cx = camCellX + dx, cz = camCellZ + dz;
        if (!cloudy(cx, cz)) continue;

        const x0 = cx * CLOUD_CELL, x1 = x0 + CLOUD_CELL;
        const z0 = cz * CLOUD_CELL, z1 = z0 + CLOUD_CELL;
        quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]);
        quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
        if (!cloudy(cx + 1, cz)) quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
        if (!cloudy(cx - 1, cz)) quad([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], [-1, 0, 0]);
        if (!cloudy(cx, cz + 1)) quad([[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], [0, 0, 1]);
        if (!cloudy(cx, cz - 1)) quad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1]);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    this.clouds.geometry.dispose();
    this.clouds.geometry = geometry;
  }
}
