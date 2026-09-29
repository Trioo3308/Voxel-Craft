/**
 * sky.js — Day/night cycle, and the lighting it implies.
 *
 * The clock is the authority on `isDay` / `isNight`, which mob spawning and
 * zombie burning both depend on. Each frame it also works out what the world
 * should look like at this moment, in this weather, in this dimension, and
 * pushes that to everything that draws:
 *   - the sky dome, sun, moon, stars and clouds (atmosphere.js)
 *   - the terrain shader's light uniforms (terrainMaterial.js)
 *   - the sun/moon light that casts shadows, and the lamps entities use
 *   - fog, and the colour grade and bloom in the post chain
 *
 * All colours here are linear light, and several are brighter than 1 on
 * purpose: the frame is tone mapped at the end, and bloom picks up anything
 * past white.
 *
 * Time is a fraction of a full cycle:
 *   0.00 sunrise · 0.25 noon · 0.50 sunset · 0.75 midnight
 */

import * as THREE from 'three';
import Settings from '../settings.js';
import { Atmosphere } from './atmosphere.js';
import { terrainUniforms } from './terrainMaterial.js';

const C = (r, g, b) => new THREE.Color(r, g, b);

// ---- Sky dome ---------------------------------------------------------------
const DAY_ZENITH = C(0.16, 0.36, 0.86);
const DAY_HORIZON = C(0.56, 0.74, 0.98);
const SUNSET_ZENITH = C(0.22, 0.2, 0.48);
const SUNSET_HORIZON = C(0.95, 0.55, 0.38);
const NIGHT_ZENITH = C(0.004, 0.007, 0.022);
const NIGHT_HORIZON = C(0.02, 0.03, 0.07);
const GLOW = C(1.25, 0.5, 0.2);
const OVERCAST = C(0.3, 0.33, 0.37);
const LIGHTNING = C(1.4, 1.45, 1.6);

// ---- Light ------------------------------------------------------------------
/** Direct light is divided by pi in the shader (it is a Lambert BRDF). */
const SUN_INTENSITY = 2.3;
const SUN_DAY = C(1.0, 0.96, 0.9);
const SUN_LOW = C(1.0, 0.62, 0.34);
const MOON_INTENSITY = 0.55;
const MOON_LIGHT = C(0.62, 0.72, 1.0);
const AMBIENT_DAY = C(0.42, 0.48, 0.62);
const AMBIENT_SUNSET = C(0.5, 0.4, 0.42);
/** Night is dark, but you can still see the shape of the land. */
const AMBIENT_NIGHT = C(0.07, 0.09, 0.17);

// ---- Grade ------------------------------------------------------------------
const GRADE_DAY = C(1.0, 1.0, 1.0);
const GRADE_GOLDEN = C(1.07, 0.99, 0.9);
const GRADE_NIGHT = C(0.84, 0.92, 1.12);

/**
 * Looks for dimensions with no clock. Each is fixed: a dome gradient, how
 * much direct light there is and from where, the ambient, a flat ambient that
 * does not depend on the sky (the Nether has a rock roof, so it has no sky
 * light at all), and a grade.
 */
const FIXED_LOOKS = {
  comb: {
    zenith: C(0.74, 0.7, 0.66), horizon: C(0.86, 0.83, 0.79), ground: C(0.6, 0.57, 0.53),
    sunDir: new THREE.Vector3(0.35, 0.85, 0.4).normalize(), sun: 0.9, sunColor: C(1, 0.97, 0.93),
    ambient: C(0.78, 0.75, 0.72), flat: C(0.08, 0.075, 0.07),
    grade: C(1.0, 0.99, 0.97), saturation: 0.88, bloom: 0.35, clouds: false, showSun: false,
  },
  nether: {
    zenith: C(0.09, 0.02, 0.015), horizon: C(0.28, 0.06, 0.03), ground: C(0.12, 0.02, 0.01),
    sunDir: new THREE.Vector3(0.2, 1, 0.1).normalize(), sun: 0, sunColor: C(1, 0.5, 0.3),
    ambient: C(0.0, 0.0, 0.0), flat: C(0.2, 0.075, 0.05),
    grade: C(1.08, 0.96, 0.9), saturation: 1.12, bloom: 0.38, clouds: false, showSun: false,
  },
  aether: {
    zenith: C(0.3, 0.52, 0.98), horizon: C(0.78, 0.88, 1.0), ground: C(0.7, 0.8, 0.95),
    sunDir: new THREE.Vector3(0.45, 0.75, 0.35).normalize(), sun: 3.3, sunColor: C(1.0, 0.97, 0.9),
    ambient: C(0.62, 0.68, 0.82), flat: C(0.05, 0.05, 0.06),
    grade: C(1.02, 1.02, 1.06), saturation: 1.05, bloom: 0.6, clouds: true, showSun: true,
  },
};

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class SkyCycle {
  /**
   * @param {import('./renderer.js').Renderer} renderer
   * @param {number} startTime initial cycle fraction (default: morning)
   */
  constructor(renderer, startTime = 0.1) {
    this.renderer = renderer;
    this.time = startTime;
    /** Dawns since the world was made. Saved, so it survives a reload. */
    this.dayCount = 0;
    this.cycleLength = Settings.survival.dayLengthSeconds;
    this.paused = false;

    /**
     * Weather's contribution, pushed in each frame rather than read out of a
     * Weather instance — the sky should not need to know weather exists, and a
     * dimension without any still renders.
     */
    this.overcast = 0;
    this.flash = 0;

    this.atmosphere = new Atmosphere(renderer.scene);
    this._elapsed = 0;
    this._state = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), ground: new THREE.Color(),
      glowColor: new THREE.Color(), glow: 0, night: 0,
      sunDir: new THREE.Vector3(), showSun: true, showMoon: true, moonPhase: 0,
      clouds: true, cloudTop: new THREE.Color(), cloudSide: new THREE.Color(),
      cloudBottom: new THREE.Color(), cloudOpacity: 0.82, time: 0,
    };
    this._light = new THREE.Color();
    this._ambient = new THREE.Color();
    this._grade = new THREE.Color();
    this._tmp = new THREE.Color();
  }

  /** Height of the sun above the horizon, -1..1. */
  get sunHeight() {
    return Math.sin(this.time * Math.PI * 2);
  }

  get isDay() {
    return this.sunHeight > 0.05;
  }

  get isNight() {
    return this.sunHeight < -0.05;
  }

  /** Human-readable clock, mapping the cycle onto 24 hours. */
  get clockText() {
    // time 0 == sunrise == 06:00
    const hours24 = (this.time * 24 + 6) % 24;
    const h = Math.floor(hours24);
    const m = Math.floor((hours24 - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  setTime(fraction) {
    this.time = ((fraction % 1) + 1) % 1;
  }

  /** Jump forward to the next sunrise / sunset. */
  skipToNextPhase() {
    // Sleeping through to dawn is still a day survived.
    if (this.isNight) this.dayCount++;
    this.setTime(this.isNight ? 0.02 : 0.52);
  }

  /** Switch presentation for a dimension. */
  setDimension(info) {
    this.dimensionInfo = info;
    this._fixed = info && !info.hasDayCycle ? FIXED_LOOKS[info.id] ?? FIXED_LOOKS.comb : null;
    // Fixed dimensions rescale the fog every frame; coming back to one with a
    // clock has to put it back, or the Overworld keeps the Nether's murk.
    if (!this._fixed) this.renderer.setViewDistance(Settings.renderDistance);
  }

  /**
   * @param dt clock time to advance (0 while paused)
   * @param world unused; kept for callers
   * @param animDt real time, so water and clouds keep moving behind menus
   */
  update(dt, world, animDt = dt) {
    this._elapsed += animDt;
    if (!this._fixed && !this.paused) {
      const advanced = this.time + dt / this.cycleLength;
      // Every wrap past 1 is another dawn. Counted here rather than derived
      // from elapsed time, so sleeping through a night still counts as a day.
      if (advanced >= 1) this.dayCount++;
      this.time = advanced % 1;
    }

    if (this._fixed) this._fixedLook(this._fixed);
    else this._cycleLook();

    const state = this._state;
    state.time = this._elapsed;
    this.atmosphere.update(animDt, this.renderer.camera, state);
    terrainUniforms.uTime.value = this._elapsed;
    this.renderer.updateShadowFocus(this.renderer.camera.position);
  }

  // -------------------------------------------------------------------------

  _cycleLook() {
    const s = this._state;
    const r = this.renderer;
    const angle = this.time * Math.PI * 2;
    s.sunDir.set(Math.cos(angle), Math.sin(angle), 0.35).normalize();
    const h = this.sunHeight;

    const day = smoothstep(-0.08, 0.3, h);
    const horizon = Math.max(0, 1 - Math.abs(h) / 0.28);
    const night = 1 - smoothstep(-0.25, 0.02, h);
    const overcast = this.overcast ?? 0;
    const flash = this.flash ?? 0;

    // ---- Dome --------------------------------------------------------------
    s.zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, day).lerp(SUNSET_ZENITH, horizon * 0.55);
    s.horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day).lerp(SUNSET_HORIZON, horizon * 0.6);
    if (overcast > 0) {
      this._tmp.copy(OVERCAST).multiplyScalar(0.15 + day * 0.85);
      s.zenith.lerp(this._tmp, overcast * 0.85);
      s.horizon.lerp(this._tmp, overcast * 0.8);
    }
    if (flash > 0) {
      s.zenith.lerp(LIGHTNING, flash * 0.7);
      s.horizon.lerp(LIGHTNING, flash * 0.7);
    }
    s.ground.copy(s.horizon).multiplyScalar(0.45);
    s.glowColor.copy(GLOW);
    s.glow = horizon * (1 - overcast * 0.9);
    s.night = night * (1 - overcast);
    s.showSun = h > -0.2 && overcast < 0.95;
    s.showMoon = h < 0.2 && overcast < 0.95;
    s.moonPhase = this.dayCount % 8;
    s.clouds = true;

    // ---- Clouds: white by day, grey in a storm, lit from below at sunset ----
    s.cloudTop.setRGB(0.05, 0.06, 0.09).lerp(this._tmp.setRGB(1.15, 1.15, 1.18), day);
    if (overcast > 0) s.cloudTop.lerp(this._tmp.copy(OVERCAST).multiplyScalar(0.3 + day), overcast * 0.7);
    s.cloudSide.copy(s.cloudTop).multiplyScalar(0.84);
    s.cloudBottom.copy(s.cloudTop).multiplyScalar(0.68).lerp(this._tmp.copy(GLOW).multiplyScalar(0.8), horizon * 0.55 * (1 - overcast));
    s.cloudOpacity = 0.8 + overcast * 0.15;

    // ---- The one shadow-casting light: the sun by day, the moon by night ----
    // Both fade to nothing at the horizon, which hides the moment the light
    // swaps from one to the other.
    const sunUp = smoothstep(-0.04, 0.16, h);
    const moonUp = smoothstep(0.04, -0.16, h);
    const gloom = 1 - overcast * 0.78;
    if (sunUp > 0) {
      r.sunDirection.copy(s.sunDir);
      this._light.copy(SUN_LOW).lerp(SUN_DAY, smoothstep(0.02, 0.4, h));
      r.sunLight.intensity = SUN_INTENSITY * sunUp * gloom;
    } else {
      r.sunDirection.copy(s.sunDir).negate();
      this._light.copy(MOON_LIGHT);
      r.sunLight.intensity = MOON_INTENSITY * moonUp * gloom;
    }
    r.sunLight.color.copy(this._light);

    this._ambient.copy(AMBIENT_NIGHT).lerp(AMBIENT_DAY, day).lerp(AMBIENT_SUNSET, horizon * 0.35);
    this._ambient.multiplyScalar(1 - overcast * 0.25);
    if (flash > 0) this._ambient.lerp(LIGHTNING, flash * 0.6);

    // ---- Grade --------------------------------------------------------------
    this._grade.copy(GRADE_NIGHT).lerp(GRADE_DAY, day).lerp(GRADE_GOLDEN, horizon * 0.8);
    const saturation = (0.84 + day * 0.16 + horizon * 0.12) * (1 - overcast * 0.22);

    this._apply({
      ambient: this._ambient,
      flat: this._tmp.setRGB(0.012, 0.013, 0.02),
      emissive: 2.4,
      sunFog: s.glow * 0.85 + 0.08,
      caustics: 0.55 * sunUp * gloom,
      wind: 1 + overcast * 1.3,
      grade: this._grade,
      saturation,
      bloom: 0.45 + night * 0.25,
    });
  }

  _fixedLook(look) {
    const s = this._state;
    const r = this.renderer;
    s.zenith.copy(look.zenith);
    s.horizon.copy(look.horizon);
    s.ground.copy(look.ground);
    s.glowColor.copy(look.horizon);
    s.glow = 0;
    s.night = 0;
    s.sunDir.copy(look.sunDir);
    s.showSun = look.showSun;
    s.showMoon = false;
    s.clouds = look.clouds;
    s.cloudTop.setRGB(1.2, 1.2, 1.25);
    s.cloudSide.setRGB(1.0, 1.02, 1.08);
    s.cloudBottom.setRGB(0.85, 0.88, 0.98);
    s.cloudOpacity = 0.75;

    r.sunDirection.copy(look.sunDir);
    r.sunLight.color.copy(look.sunColor);
    r.sunLight.intensity = look.sun;


    this._apply({
      ambient: look.ambient,
      flat: look.flat,
      emissive: 2.3,
      sunFog: 0,
      caustics: look.sun > 0 ? 0.45 : 0,
      wind: 1,
      grade: look.grade,
      saturation: look.saturation,
      bloom: look.bloom,
    });
  }

  /**
   * Where the fog starts and ends: scaled per dimension (the Nether closes in,
   * the Aether opens out), and pushed out to the far edge of the distant
   * terrain when that is showing (farTerrain.js), so the haze starts where
   * the real chunks end.
   */
  _applyFogDistance() {
    const r = this.renderer;
    const info = this.dimensionInfo;
    if (!r.scene.fog || !info) return;
    const scale = info.fogScale ?? 1;
    const far = Settings.renderDistance * 16;
    if (r.fogReach) {
      r.scene.fog.near = far * 0.8 * scale;
      r.scene.fog.far = r.fogReach * scale;
    } else {
      r.scene.fog.near = far * Settings.fogStart * scale;
      r.scene.fog.far = far * scale;
    }
  }

  /** Push the frame's light to terrain, entities, fog and the post chain. */
  _apply(look) {
    this._applyFogDistance();
    const r = this.renderer;
    const s = this._state;
    const u = terrainUniforms;

    u.uSkyAmbient.value.copy(look.ambient);
    u.uFlatAmbient.value.copy(look.flat);
    u.uEmissive.value = look.emissive;
    u.uSunDir.value.copy(r.sunDirection);
    u.uSunColor.value.copy(r.sunLight.color).multiplyScalar(r.sunLight.intensity / SUN_INTENSITY);
    u.uSunFogColor.value.copy(s.glowColor).multiplyScalar(0.9);
    u.uSunFogStrength.value = look.sunFog;
    u.uCaustics.value = look.caustics;
    u.uWind.value = look.wind;

    // Fog fades distant terrain into the sky's horizon colour.
    if (r.scene.fog) r.scene.fog.color.copy(s.horizon);
    r.scene.background = s.horizon;

    // Entities use Lambert lamps; match them to the terrain's ambient. Lambert
    // divides by pi, so the lamp intensity carries a pi to cancel it.
    r.hemiLight.color.copy(look.ambient).add(look.flat).multiplyScalar(1.15);
    r.hemiLight.groundColor.copy(look.ambient).add(look.flat).multiplyScalar(0.55);
    r.hemiLight.intensity = Math.PI;
    r.ambientLight.intensity = 0;

    r.setGrade(look.grade, look.saturation, look.bloom);
  }
}
