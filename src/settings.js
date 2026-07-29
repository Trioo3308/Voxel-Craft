/**
 * settings.js — Central tunables.
 *
 * This module is imported by BOTH the main thread and the web worker, so it
 * must stay free of any Three.js / DOM references.
 */

export const Settings = {
  // ---- World generation ----------------------------------------------------
  seed: 1337,
  seaLevel: 40,

  // ---- Streaming -----------------------------------------------------------
  /** Radius, in chunks, of terrain kept loaded around the player. */
  renderDistance: 8,
  /** Extra radius kept in memory before a chunk is unloaded (hysteresis). */
  unloadPadding: 2,
  /** Max chunk generation jobs in flight in the worker at once. */
  maxPendingChunks: 6,
  /** Max chunk meshes uploaded to the GPU per frame (prevents hitches). */
  maxUploadsPerFrame: 2,

  // ---- Rendering -----------------------------------------------------------
  fov: 75,
  maxPixelRatio: 2,
  /** Fog starts at this fraction of the render distance. */
  fogStart: 0.55,

  // ---- Player --------------------------------------------------------------
  player: {
    width: 0.6,
    height: 1.8,
    eyeHeight: 1.62,
    reach: 5,
    walkSpeed: 4.3,
    sprintSpeed: 5.8,
    sneakSpeed: 1.4,
    flySpeed: 14,
    jumpVelocity: 8.4,
    gravity: 28,
    terminalVelocity: 60,
    /** Ground friction / air control (0..1, higher = snappier). */
    groundAccel: 0.28,
    airAccel: 0.06,
    /** Player can walk up ledges this tall without jumping. */
    stepHeight: 0.6,
  },

  // ---- Survival ------------------------------------------------------------
  survival: {
    maxHealth: 20,
    maxHunger: 20,
    /** Blocks of free-fall before damage starts. */
    fallDamageThreshold: 3.5,
    /** Seconds of day + night combined. */
    dayLengthSeconds: 900,
  },

  // ---- Mobs ----------------------------------------------------------------
  mobs: {
    /** Attempt a spawn wave this often (seconds). */
    spawnInterval: 3,
    /** Mobs further than this from the player are removed. */
    despawnDistance: 72,
    /** Spawn ring around the player. */
    minSpawnDistance: 14,
    maxSpawnDistance: 44,
  },

  // ---- Debug ---------------------------------------------------------------
  showChunkBorders: false,
};

export default Settings;
