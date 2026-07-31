/**
 * weather.js — Rain, snow and thunderstorms.
 *
 * Weather is a single global state with an intensity that ramps rather than
 * snapping, so a storm rolls in instead of appearing. What *falls* is decided
 * per column from the biome under the player, which is why you can walk out of
 * a snowfall into rain without the state ever changing.
 *
 * Precipitation is drawn by the shared particle system rather than a bespoke
 * renderer, so it costs nothing extra to draw and inherits the same pooling.
 */

import { BIOME } from '../world/terrain.js';

export const WEATHER = {
  CLEAR: 'clear',
  RAIN: 'rain',
  STORM: 'storm',
};

/** Biomes that get snow instead of rain. */
const SNOWY = new Set([BIOME.TUNDRA, BIOME.TAIGA]);
/** Biomes where nothing falls at all. */
const ARID = new Set([BIOME.DESERT, BIOME.SAVANNA]);

/** Seconds a spell of each state lasts, as [min, max]. */
const DURATION = {
  [WEATHER.CLEAR]: [180, 480],
  [WEATHER.RAIN]: [90, 240],
  [WEATHER.STORM]: [60, 140],
};

/** How fast intensity ramps in and out, in units per second. */
const RAMP = 0.22;

/** Particles spawned per second at full intensity. */
const RAIN_RATE = 190;
const SNOW_RATE = 70;

/** How far out precipitation is scattered, and how high above the player. */
const SPREAD = 15;
const CEILING = 13;

export class Weather {
  constructor() {
    this.state = WEATHER.CLEAR;
    /** 0..1, ramps toward 1 while raining and toward 0 while clear. */
    this.intensity = 0;
    this.timer = this._rollDuration(WEATHER.CLEAR);

    this._spawnCarry = 0;
    this._flash = 0;
    this._nextStrike = 0;

    /** Set each frame so the HUD and audio can ask what is actually falling. */
    this.falling = null;
  }

  get isPrecipitating() {
    return this.state !== WEATHER.CLEAR;
  }

  /** 0..1 — how much the sky should be dimmed and desaturated right now. */
  get overcast() {
    return this.intensity * (this.state === WEATHER.STORM ? 1 : 0.75);
  }

  /** A brief white flash, 0..1, when lightning strikes. */
  get flash() {
    return this._flash;
  }

  _rollDuration(state) {
    const [min, max] = DURATION[state];
    return min + Math.random() * (max - min);
  }

  /** Force a state — used by the save loader and by tests. */
  set(state, intensity = null) {
    this.state = state;
    this.intensity = intensity ?? (state === WEATHER.CLEAR ? 0 : 1);
    this.timer = this._rollDuration(state);
  }

  serialize() {
    return { state: this.state, intensity: this.intensity, timer: this.timer };
  }

  restore(data) {
    if (!data || !DURATION[data.state]) return;
    this.state = data.state;
    this.intensity = data.intensity ?? 0;
    this.timer = data.timer ?? this._rollDuration(this.state);
  }

  /**
   * @param dt seconds
   * @param ctx {{player, world, terrain, particles, hasWeather}}
   */
  update(dt, ctx) {
    // A dimension with no sky has no weather; let any leftover storm fade out.
    if (!ctx.hasWeather) {
      this.intensity = Math.max(0, this.intensity - RAMP * 2 * dt);
      this.falling = null;
      this._flash = Math.max(0, this._flash - dt * 6);
      return;
    }

    this._advanceState(dt);
    this._updateLightning(dt, ctx);

    if (this.intensity <= 0.01 || !ctx.particles) {
      this.falling = null;
      return;
    }

    this._spawnPrecipitation(dt, ctx);
  }

  _advanceState(dt) {
    this.timer -= dt;
    if (this.timer <= 0) {
      // Storms decay into rain rather than straight to blue sky, and clear
      // weather is the most likely next state so it is not always wet.
      if (this.state === WEATHER.STORM) this.state = WEATHER.RAIN;
      else if (this.state === WEATHER.RAIN) this.state = WEATHER.CLEAR;
      else this.state = Math.random() < 0.72 ? WEATHER.RAIN : WEATHER.STORM;
      this.timer = this._rollDuration(this.state);
    }

    const target = this.state === WEATHER.CLEAR ? 0 : 1;
    if (this.intensity < target) this.intensity = Math.min(target, this.intensity + RAMP * dt);
    else if (this.intensity > target) this.intensity = Math.max(target, this.intensity - RAMP * dt);
  }

  _updateLightning(dt, ctx) {
    this._flash = Math.max(0, this._flash - dt * 5);

    if (this.state !== WEATHER.STORM || this.intensity < 0.6) return;
    this._nextStrike -= dt;
    if (this._nextStrike > 0) return;

    this._nextStrike = 6 + Math.random() * 22;
    this._flash = 1;
    if (ctx.onLightning) ctx.onLightning();
  }

  /**
   * Scatter falling particles over open sky near the player.
   *
   * Each candidate column is tested against the surface height, so nothing
   * falls through a roof and nothing is spawned underground — which is also
   * what makes standing in a cave feel sheltered.
   */
  _spawnPrecipitation(dt, ctx) {
    const { player, world, terrain, particles } = ctx;

    const px = Math.floor(player.position.x);
    const py = Math.floor(player.position.y);
    const pz = Math.floor(player.position.z);

    const biome = terrain ? terrain.biomeAt(px, pz, world.getSurfaceY(px, pz)) : null;
    if (biome !== null && ARID.has(biome)) {
      this.falling = null;
      return;
    }
    const snow = biome !== null && SNOWY.has(biome);
    this.falling = snow ? 'snow' : 'rain';

    const rate = (snow ? SNOW_RATE : RAIN_RATE) * this.intensity;
    this._spawnCarry += rate * dt;
    let budget = Math.floor(this._spawnCarry);
    this._spawnCarry -= budget;
    // A frame hitch must not dump a thousand drops at once.
    budget = Math.min(budget, 40);

    for (let n = 0; n < budget; n++) {
      const x = px + (Math.random() - 0.5) * 2 * SPREAD;
      const z = pz + (Math.random() - 0.5) * 2 * SPREAD;
      const y = py + CEILING;

      // Open sky only: skip columns whose surface is already above the spawn
      // height. The drop is then told where the ground is, so it stops on a
      // roof instead of falling through it — standing under cover keeps you dry.
      const surface = world.getSurfaceY(Math.floor(x), Math.floor(z));
      if (surface >= y) continue;

      particles.precipitation(x, y, z, snow, surface + 1);
    }
  }
}
