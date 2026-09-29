/**
 * localLight.js — How lit a point in the world is, for things that are not terrain.
 *
 * Mobs, dropped items and your own hand are drawn with Three's Lambert lamps,
 * which know nothing about caves: a zombie deep underground used to be lit as
 * if it stood under open sky. This evaluates the same rule the terrain shader
 * uses (sky exposure squared, torchlight squared, the flat ambient) at a point,
 * and returns it relative to what the lamps already give in the open, as a
 * multiplier to put on a material's colour.
 */

import { terrainUniforms } from './terrainMaterial.js';

const luminance = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

/**
 * @returns {{k: number, warm: number}} k scales the colour (1 = as lit as open
 *   ground; below 1 darker, above brighter from torches); warm is how much of
 *   that light is torchlight, for tinting it.
 */
export function sampleLocalLight(world, dynamic, x, y, z) {
  const u = terrainUniforms;
  const sky = world.skyExposure(x, y, z);
  const torch = Math.max(world.getBlockLight(x, y, z), dynamic ? dynamic.levelAt(x, y, z) : 0) / 15;

  const skyAmbient = luminance(u.uSkyAmbient.value);
  const flat = luminance(u.uFlatAmbient.value) + u.uMinLight.value;
  const torchLight = luminance(u.uTorchColor.value) * 0.6;

  const skyPart = sky * sky * skyAmbient;
  const torchPart = torch * torch * torchLight;
  const open = skyAmbient + flat;
  const k = Math.min(1.7, Math.max(0.05, (skyPart + flat + torchPart) / Math.max(0.02, open)));
  const warm = torchPart / (skyPart + flat + torchPart + 1e-4);
  return { k, warm };
}
