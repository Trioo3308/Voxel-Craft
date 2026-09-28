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
 */

import * as THREE from 'three';

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
};

const VERTEX_PARS = /* glsl */ `
#include <common>
attribute vec2 fx;
uniform float uTime;
uniform float uWind;
uniform float uSway;
varying vec2 vFx;
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
varying vec2 vFx;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

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
