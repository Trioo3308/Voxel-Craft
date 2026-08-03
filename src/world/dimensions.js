/**
 * dimensions.js — Dimension registry.
 *
 * Kept tiny and dependency-free so both the worker and the main thread can
 * import it without dragging in generators or Three.js.
 */

export const DIMENSIONS = {
  OVERWORLD: 'overworld',
  COMB: 'comb',
  NETHER: 'nether',
  AETHER: 'aether',
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

  [DIMENSIONS.NETHER]: {
    id: DIMENSIONS.NETHER,
    name: 'The Nether',
    hasDayCycle: false,
    // A low red murk. Dark enough that glowstone and lava are what you navigate
    // by, which is the point of the place.
    skyColor: 0x2a0d0a,
    fogColor: 0x3d1410,
    ambient: 0.55,
    spawnsOverworldMobs: false,
    hasWeather: false,
    /** Thick fog, so you cannot see the far side of a lava sea. */
    fogScale: 0.4,
    /** No sky means no sky light — everything down here is lit by blocks. */
    noSkyLight: true,
  },

  [DIMENSIONS.AETHER]: {
    id: DIMENSIONS.AETHER,
    name: 'The Aether',
    hasDayCycle: false,
    // Pale gold, and deliberately the brightest place in the game — it should
    // read as the opposite of the Nether the instant you step through.
    skyColor: 0xc9e4ff,
    fogColor: 0xdcefff,
    ambient: 1.15,
    spawnsOverworldMobs: false,
    hasWeather: false,
    /** The view opens right out, so the islands read as an archipelago. */
    fogScale: 1.8,
  },
};

/** Every dimension a portal can lead to, in menu order. */
export const TRAVEL_DIMENSIONS = [
  DIMENSIONS.COMB, DIMENSIONS.NETHER, DIMENSIONS.AETHER,
];

export function dimensionInfo(id) {
  return DIMENSION_INFO[id] ?? DIMENSION_INFO[DIMENSIONS.OVERWORLD];
}
