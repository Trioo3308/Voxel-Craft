/**
 * dimensions.js — Dimension registry.
 *
 * Kept tiny and dependency-free so both the worker and the main thread can
 * import it without dragging in generators or Three.js.
 */

export const DIMENSIONS = {
  OVERWORLD: 'overworld',
  COMB: 'comb',
};

/** Presentation and rules per dimension. */
export const DIMENSION_INFO = {
  [DIMENSIONS.OVERWORLD]: {
    id: DIMENSIONS.OVERWORLD,
    name: 'Overworld',
    /** Day/night runs normally here. */
    hasDayCycle: true,
    /** Sky and fog when the cycle is bypassed. */
    skyColor: 0x87ceeb,
    fogColor: 0x87ceeb,
    /** Ambient floor applied to the world material. */
    ambient: 1.0,
    /** Ordinary overworld mobs spawn. */
    spawnsOverworldMobs: true,
    /** Rain and snow fall here. */
    hasWeather: true,
  },

  [DIMENSIONS.COMB]: {
    id: DIMENSIONS.COMB,
    name: 'The Comb',
    // No sun here — a fixed bone-white haze instead, so torches still matter
    // and the red accents read against it.
    hasDayCycle: false,
    skyColor: 0xe8e3dc,
    fogColor: 0xe8e3dc,
    ambient: 0.92,
    spawnsOverworldMobs: false,
    /** Nothing falls in a dimension with no sky. */
    hasWeather: false,
    /** Fog closes in, which sells the enclosed feeling. */
    fogScale: 0.55,
  },
};

export function dimensionInfo(id) {
  return DIMENSION_INFO[id] ?? DIMENSION_INFO[DIMENSIONS.OVERWORLD];
}
