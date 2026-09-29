/**
 * terrainMaterial.js — How the voxel world is lit and shaded.
 *
 * The world used to be drawn unlit: the mesher baked one brightness per vertex
 * and a single colour multiply did day and night. That is cheap, but it cannot
 * cast a shadow, cannot make lava glow, and flattens everything to the same
 * grey at dusk. The visual rework (Jev's pick: "modern voxel", see
 * JEV_DECISIONS.md) keeps the pixel textures and replaces the lighting:
 *
 *   - the sun (or moon) is a real directional light with a shadow map, so
 *     trees, overhangs and mobs throw shadows that move through the day;
 *   - sky light, torch light and ambient occlusion arrive as three separate
 *     vertex channels from the mesher, so torchlight can be warm while the sky
 *     is cool, instead of one merged grey;
 *   - emissive blocks write values above 1, which bloom picks up;
 *   - leaves and plants sway, the water surface ripples, and light plays over
 *     the floor of shallow water.
 *
 * Built by patching Three's Lambert shader rather than writing one from
 * scratch, so Three's shadow maps, fog and clipping keep working unchanged.
 *
 * Vertex channels (see mesher.js):
 *   color.r  sky exposure, 0..1        color.g  torch light, 0..1
 *   color.b  ambient occlusion, 0..1, or 3.0 for an emissive block
 *   fx.x     sway weight, 0..1         fx.y     0.5 = under water, 1 = water surface
 *   uv       block-local, repeating    tile     atlas tile index
 *
 * The texture lookup is ours too. The mesher merges runs of identical faces
 * into one quad, so `uv` counts blocks across it (0..5 for five blocks) and
 * the shader wraps it into the tile named by `tile`. The shadow pass needs the
 * same lookup to cut leaves and glass out of their shadows; see
 * createTerrainDepthMaterial.
 */

import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_ROWS, ATLAS_TILE_PX, ALT_TILE_OFFSET, TILE_NATURAL } from '../world/blocks.js';

/**
 * Uniforms shared by every terrain material, driven each frame by the sky.
 * One object, so a colour change is one write however many materials there are.
 */
export const terrainUniforms = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  /** Ambient light from the open sky, already scaled by its intensity. */
  uSkyAmbient: { value: new THREE.Color(0.55, 0.62, 0.78) },
  /**
   * Ambient that does not depend on seeing the sky. Almost nothing in the
   * Overworld, but the Nether has a rock roof and so no sky light at all; this
   * is its dim red glow.
   */
  uFlatAmbient: { value: new THREE.Color(0.012, 0.013, 0.02) },
  /** Torchlight at full strength. Warm, so it reads against a cool night. */
  uTorchColor: { value: new THREE.Color(1.7, 1.15, 0.62) },
  /** Brightness option: a floor under the darkest shade, in linear light. */
  uMinLight: { value: 0.02 },
  /** How far above 1 an emissive block's colour is pushed, for bloom. */
  uEmissive: { value: 2.4 },
  /** Direction toward the sun, for the in-scattered glow in the fog. */
  uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.3).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uSunFogColor: { value: new THREE.Color(1.0, 0.72, 0.45) },
  uSunFogStrength: { value: 0.5 },
  /** Strength of the light patterns on underwater floors. 0 with no sun. */
  uCaustics: { value: 0.6 },
  /** 1 to sway plants, 0 to hold them still (the Swaying plants option). */
  uSway: { value: 1 },
  /** Moving light around the camera; see dynamicLight.js. */
  uDynLight: { value: null },
  uDynOrigin: { value: new THREE.Vector3(1e9, 0, 0) },
  uDynInvSize: { value: 1 / 40 },
  /** Tiles across and down the atlas. */
  uAtlasGrid: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
};

/**
 * Where a point `f` (0..1 across the tile) of tile `t` sits in the atlas.
 * Clamped to the centres of the tile's edge texels, so nearest sampling can
 * never reach a neighbouring tile and every texel is drawn the same width (the
 * old baked UVs squeezed the outermost ones to half size).
 */
const ATLAS_PARS = /* glsl */ `
uniform vec2 uAtlasGrid;
varying float vTile;
vec2 atlasTileUv(float t, vec2 f) {
  float row = floor((t + 0.5) / uAtlasGrid.x);
  float col = t - row * uAtlasGrid.x;
  f = clamp(f, vec2(${(0.5 / ATLAS_TILE_PX).toFixed(6)}), vec2(${(1 - 0.5 / ATLAS_TILE_PX).toFixed(6)}));
  return vec2((col + f.x) / uAtlasGrid.x, 1.0 - (row + 1.0 - f.y) / uAtlasGrid.y);
}
`;

/**
 * Three's map lookup, through the atlas, with per-block variety: `vTile`
 * carries the tile plus two flags from the mesher (blocks.js). NATURAL turns
 * and flips the texture per block (sides only mirror, so a fringe stays on
 * top); VARIED swaps in the tile's second painting for about half the blocks.
 *
 * The block is identified by floor(uv), which is exactly where the texture
 * wraps, so a merged quad changes pattern on the block seams and nowhere else.
 */
const FRAGMENT_MAP = /* glsl */ `
#ifdef USE_MAP
{
  float code = floor(vTile + 0.5);
  float flags = floor(code / ${TILE_NATURAL}.0);
  float t = code - flags * ${TILE_NATURAL}.0;
  vec2 f = fract(vMapUv);
  if (flags > 0.5) {
    float h = blockHash(vec3(floor(vMapUv), 0.0) + vBlockKey);
    float turn = floor(h * 8.0);
    if (mod(flags, 2.0) > 0.5) {
      if (turn > 3.5) f.x = 1.0 - f.x;
      if (abs(vWorldNormal.y) > 0.5) {
        float q = mod(turn, 4.0);
        if (q > 2.5) f = vec2(1.0 - f.y, f.x);
        else if (q > 1.5) f = 1.0 - f;
        else if (q > 0.5) f = vec2(f.y, 1.0 - f.x);
      }
    }
    if (flags > 1.5 && fract(h * 13.0) > 0.5) t += ${ALT_TILE_OFFSET}.0;
  }
  diffuseColor *= texture2D(map, atlasTileUv(t, f));
}
#endif
`;

/** The shadow pass: same tile, no variety (the varied tiles are all opaque). */
const DEPTH_MAP = /* glsl */ `
#ifdef USE_MAP
{
  float code = floor(vTile + 0.5);
  float t = code - floor(code / ${TILE_NATURAL}.0) * ${TILE_NATURAL}.0;
  diffuseColor *= texture2D(map, atlasTileUv(t, fract(vMapUv)));
}
#endif
`;

const VERTEX_PARS = /* glsl */ `
#include <common>
attribute vec2 fx;
attribute float tile;
uniform float uTime;
uniform float uWind;
uniform float uSway;
varying vec2 vFx;
varying float vTile;
varying vec3 vBlockKey;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
`;

const VERTEX_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

/**
 * Wind and waves, applied before projection. Both are functions of world
 * position only, so two vertices at the same place always move together and
 * neither leaves nor water can open cracks between blocks.
 */
const VERTEX_DISPLACE = /* glsl */ `
#include <begin_vertex>
vFx = fx;
vTile = tile;
// Names the face's plane and chunk; floor(uv) names the block within it.
vBlockKey = vec3(modelMatrix[3].x * 1.31, modelMatrix[3].z * 1.71,
  dot(position, normal) * 2.37 + dot(normal, vec3(0.5, 1.0, 1.5)));
{
  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  if (fx.x > 0.0 && uSway > 0.0) {
    float gust = 0.55 + 0.45 * sin(uTime * 0.37 + wp.x * 0.021 + wp.z * 0.017);
    float phase = uTime * 1.7 + wp.x * 0.37 + wp.z * 0.29 + wp.y * 0.11;
    vec2 offset = vec2(sin(phase), cos(phase * 0.83 + 1.3));
    transformed.xz += offset * (0.055 * uWind * gust * fx.x * uSway);
  }
  if (fx.y > 0.9) {
    float wave = sin(uTime * 1.35 + wp.x * 0.9 + wp.z * 0.55)
               + sin(uTime * 1.05 - wp.x * 0.45 + wp.z * 1.1);
    // Always below the rest height, so a ripple never pokes above the shore.
    transformed.y += wave * 0.018 - 0.04;
  }
}
`;

const VERTEX_WORLDPOS = /* glsl */ `
#include <project_vertex>
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAGMENT_PARS = /* glsl */ `
#include <common>
uniform float uTime;
uniform vec3 uSkyAmbient;
uniform vec3 uFlatAmbient;
uniform vec3 uTorchColor;
uniform float uMinLight;
uniform float uEmissive;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSunFogColor;
uniform float uSunFogStrength;
uniform float uCaustics;
uniform highp sampler3D uDynLight;
uniform vec3 uDynOrigin;
uniform float uDynInvSize;
varying vec2 vFx;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vBlockKey;
${ATLAS_PARS}
// Hash of a block key, 0..1 (Dave Hoskins' hash13).
float blockHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Light rippling across a sunlit floor under water. Snapped to the texture's
// sixteenth-of-a-block grid, so it reads as pixel art rather than a smooth
// overlay laid on top of it.
float caustic(vec2 p, float t) {
  p = floor(p * 16.0) / 16.0;
  vec2 q = p * 1.35;
  float a = sin(q.x + sin(q.y * 1.7 + t * 1.2) + t * 0.8);
  float b = sin(q.y + sin(q.x * 1.3 - t * 1.0) - t * 0.6);
  float ridge = 1.0 - abs(a + b) * 0.5;
  return pow(clamp(ridge, 0.0, 1.0), 7.0);
}
`;

/** Albedo stays pure texture: the vertex channels are light, not colour. */
const FRAGMENT_COLOR = /* glsl */ ``;

/**
 * The lighting model, replacing Lambert's sum.
 *
 * `reflectedLight.directDiffuse` is Three's own sun term: N·L, the shadow map
 * and the light's colour are all already in it. Everything else is ours.
 */
const FRAGMENT_LIGHT = /* glsl */ `
  vec3 albedo = diffuseColor.rgb;
  float sky = vColor.r;
  float torch = vColor.g;
  float occ = min(vColor.b, 1.0);
  vec3 n = normalize(vWorldNormal);

  // Moving light (a torch in your hand, a glowing mob), sampled on the air
  // side of the face from the light volume around the camera.
  vec3 dynP = (vWorldPos + n * 0.5 - uDynOrigin) * uDynInvSize;
  if (all(greaterThanEqual(dynP, vec3(0.0))) && all(lessThan(dynP, vec3(1.0)))) {
    torch = max(torch, texture(uDynLight, dynP).r);
  }

  // The sun only reaches places open to the sky. The shadow map handles trees
  // and overhangs; this keeps it out of caves the shadow box does not cover.
  float sunReach = smoothstep(0.35, 0.85, sky);
  vec3 direct = reflectedLight.directDiffuse * sunReach * mix(0.75, 1.0, occ);

  // Sky ambient: strongest from above. The fixed per-face tint keeps the six
  // sides of a block distinct in shade, which is what makes voxels read.
  float faceTint = n.y > 0.5 ? 1.0 : (n.y < -0.5 ? 0.55 : (abs(n.x) > 0.5 ? 0.8 : 0.9));
  vec3 ambient = albedo * (uSkyAmbient * (sky * sky) + uFlatAmbient) * faceTint * occ;

  // Torchlight falls off with the square of the light level, like real light.
  vec3 torchLight = albedo * uTorchColor * (torch * torch) * mix(0.6, 1.0, occ) * faceTint;

  vec3 lit = direct + ambient + torchLight + albedo * uMinLight * faceTint;

  // Shallow water floors catch the light coming through the surface.
  if (vFx.y > 0.4 && vFx.y < 0.6) {
    lit += albedo * uSunColor * caustic(vWorldPos.xz, uTime) * uCaustics * sunReach;
  }

  vec3 outgoingLight = vColor.b > 2.5 ? albedo * uEmissive : lit;
`;

/**
 * Water is darker and clearer than a lit block would be: it mostly shows what
 * is under it and what it reflects, not its own colour. It also sparkles where
 * the sun catches the moving surface.
 */
const FRAGMENT_LIGHT_WATER = FRAGMENT_LIGHT + /* glsl */ `
  // Tinted as well as dimmed: shallow water over bright sand otherwise reads
  // as milky glass rather than water.
  outgoingLight *= vColor.b > 2.5 ? vec3(1.0) : vec3(0.5, 0.66, 0.84);
  if (vFx.y > 0.9) {
    vec3 viewDir = normalize(vWorldPos - cameraPosition);
    vec2 cell = floor(vWorldPos.xz * 16.0) / 16.0;
    vec3 wn = normalize(vec3(
      sin(uTime * 1.3 + cell.x * 2.1 + cell.y * 1.3) * 0.18,
      1.0,
      cos(uTime * 1.1 + cell.y * 1.9 - cell.x * 0.7) * 0.18));
    float glint = pow(max(dot(reflect(viewDir, wn), uSunDir), 0.0), 90.0);
    outgoingLight += uSunColor * glint * 2.5 * sunReach;
  }
`;

/**
 * Fog that glows toward the sun, so a sunset hazes gold on the side it sets on
 * and blue on the other, instead of one flat colour all round.
 */
const FRAGMENT_FOG = /* glsl */ `
#ifdef USE_FOG
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  vec3 toFrag = normalize(vWorldPos - cameraPosition);
  float toward = pow(max(dot(toFrag, uSunDir), 0.0), 6.0);
  vec3 fogTint = mix(fogColor, uSunFogColor, toward * uSunFogStrength);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogTint, fogFactor);
#endif
`;

function patch(material, water) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrainUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERTEX_PARS)
      .replace('#include <beginnormal_vertex>', VERTEX_NORMAL)
      .replace('#include <begin_vertex>', VERTEX_DISPLACE)
      .replace('#include <project_vertex>', VERTEX_WORLDPOS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAGMENT_PARS)
      .replace('#include <map_fragment>', FRAGMENT_MAP)
      .replace('#include <color_fragment>', FRAGMENT_COLOR)
      .replace(
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        water ? FRAGMENT_LIGHT_WATER : FRAGMENT_LIGHT
      )
      .replace('#include <fog_fragment>', FRAGMENT_FOG);
  };
  // Every terrain material shares one program per variant.
  material.customProgramCacheKey = () => (water ? 'terrain-water' : 'terrain');
  return material;
}

/** The solid and cutout pass: everything but water and other see-through blocks. */
export function createTerrainMaterial(map) {
  return patch(new THREE.MeshLambertMaterial({
    map,
    vertexColors: true,
    alphaTest: 0.5, // cutout for leaves and glass, still in the opaque pass
    side: THREE.FrontSide,
    fog: true,
  }), false);
}

/**
 * What chunk meshes cast shadows with. Three's stock depth material would
 * read the atlas at the raw block-local UV, cutting leaves and glass out of
 * the wrong tile; this does the same lookup as the colour pass. It takes map
 * and alphaTest from the mesh's own material when the shadow is drawn.
 */
export function createTerrainDepthMaterial() {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlasGrid = terrainUniforms.uAtlasGrid;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tile;\nvarying float vTile;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTile = tile;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ATLAS_PARS)
      .replace('#include <map_fragment>', DEPTH_MAP);
  };
  material.customProgramCacheKey = () => 'terrain-depth';
  return material;
}

/** The alpha-blended pass: water, and translucent blocks such as portals. */
export function createWaterMaterial(map) {
  return patch(new THREE.MeshLambertMaterial({
    map,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide, // so the surface is visible from underwater too
    fog: true,
  }), true);
}
