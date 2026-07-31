/**
 * sky.js — Day/night cycle.
 *
 * Drives sky colour, fog, light intensity and the global tint multiplied into
 * the (unlit) chunk material. Also the authority on `isDay` / `isNight`, which
 * mob spawning and zombie burning both depend on.
 *
 * Time is a fraction of a full cycle:
 *   0.00 sunrise · 0.25 noon · 0.50 sunset · 0.75 midnight
 */

import * as THREE from 'three';
import Settings from '../settings.js';

const DAY_SKY = new THREE.Color(0x87ceeb);
const SUNSET_SKY = new THREE.Color(0xff8c4a);
const NIGHT_SKY = new THREE.Color(0x080c1e);

const DAY_TINT = new THREE.Color(0xffffff);
const SUNSET_TINT = new THREE.Color(0xffcaa0);
/** Night is dark but never pitch black — you still need to be able to play. */
const NIGHT_TINT = new THREE.Color(0x39406b);

/** Storm grey, and the white a lightning strike washes everything with. */
const OVERCAST_SKY = new THREE.Color(0x5a6068);
const LIGHTNING = new THREE.Color(0xffffff);

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
    this.cycleLength = Settings.survival.dayLengthSeconds;
    this.paused = false;

    this._skyColor = new THREE.Color();
    this._tint = new THREE.Color();

    /**
     * Weather's contribution, pushed in each frame rather than read out of a
     * Weather instance — the sky should not need to know weather exists, and a
     * dimension without any still renders.
     */
    this.overcast = 0;
    this.flash = 0;
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
    this.setTime(this.isNight ? 0.02 : 0.52);
  }

  /**
   * Switch presentation for a dimension.
   * A dimension without a day cycle gets a fixed sky and ambient level instead,
   * so the Comb stays a constant bone-white haze rather than cycling.
   */
  setDimension(info) {
    this.dimensionInfo = info;
    if (!info.hasDayCycle) {
      this._fixedSky = new THREE.Color(info.skyColor);
      this._fixedFog = new THREE.Color(info.fogColor);
    } else {
      this._fixedSky = null;
      this._fixedFog = null;
    }
  }

  update(dt, world) {
    // A dimension with no sun ignores the clock entirely.
    if (this._fixedSky) {
      this.renderer.scene.background = this._fixedSky;
      if (this.renderer.scene.fog) {
        this.renderer.scene.fog.color.copy(this._fixedFog);
        const info = this.dimensionInfo;
        if (info && info.fogScale) {
          const far = Settings.renderDistance * 16;
          this.renderer.scene.fog.near = far * Settings.fogStart * info.fogScale;
          this.renderer.scene.fog.far = far * info.fogScale;
        }
      }
      const ambient = this.dimensionInfo ? this.dimensionInfo.ambient : 1;
      if (world) world.setLightTint(this._tint.setScalar(ambient));

      // Entity lighting has to track the same `ambient` the terrain tint uses.
      // Terrain is unlit geometry multiplied by that tint, while mobs are lit by
      // these lamps — pinning the lamps to fixed values left the Warden reading
      // grey against a shrine that was nearly white.
      this.renderer.sunLight.intensity = 0.45 + ambient * 0.95;
      this.renderer.sunLight.color.setRGB(1, 0.97, 0.95);
      this.renderer.hemiLight.intensity = ambient * 0.95;
      this.renderer.ambientLight.intensity = 0.18 + ambient * 0.34;
      // A dimension with no sun still needs a stable shading direction.
      this.renderer.sunLight.position.set(60, 120, 45);
      return;
    }

    if (!this.paused) {
      this.time = (this.time + dt / this.cycleLength) % 1;
    }

    const h = this.sunHeight;

    // How much daylight there is, and how close we are to the horizon (for the
    // warm sunrise/sunset band).
    const dayAmount = smoothstep(-0.08, 0.30, h);
    const horizonAmount = Math.max(0, 1 - Math.abs(h) / 0.28);

    // --- Sky + fog ---------------------------------------------------------
    this._skyColor.copy(NIGHT_SKY).lerp(DAY_SKY, dayAmount);
    this._skyColor.lerp(SUNSET_SKY, horizonAmount * 0.65);

    // Weather pulls the sky toward flat grey and mutes the sunset band, then a
    // lightning strike blows it briefly white.
    const overcast = this.overcast ?? 0;
    if (overcast > 0) this._skyColor.lerp(OVERCAST_SKY, overcast * 0.85);
    if (this.flash > 0) this._skyColor.lerp(LIGHTNING, this.flash * 0.75);

    this.renderer.scene.background = this._skyColor;
    if (this.renderer.scene.fog) this.renderer.scene.fog.color.copy(this._skyColor);

    // --- Global tint on the unlit chunk material ---------------------------
    this._tint.copy(NIGHT_TINT).lerp(DAY_TINT, dayAmount);
    this._tint.lerp(SUNSET_TINT, horizonAmount * 0.45);
    // Overcast darkens the world without tinting it, then lightning lifts it.
    if (overcast > 0) this._tint.multiplyScalar(1 - overcast * 0.35);
    if (this.flash > 0) this._tint.lerp(LIGHTNING, this.flash * 0.5);
    if (world) world.setLightTint(this._tint);

    // --- Entity lighting ---------------------------------------------------
    const gloom = 1 - overcast * 0.4;
    this.renderer.sunLight.intensity = (0.25 + dayAmount * 1.25) * gloom;
    this.renderer.sunLight.color.copy(DAY_TINT).lerp(SUNSET_TINT, horizonAmount * 0.6);
    this.renderer.hemiLight.intensity = (0.22 + dayAmount * 0.75) * gloom;
    this.renderer.ambientLight.intensity = (0.18 + dayAmount * 0.30) * gloom + this.flash * 0.5;

    // Move the sun across the sky so entity shading direction changes.
    const angle = this.time * Math.PI * 2;
    this.renderer.sunLight.position.set(
      Math.cos(angle) * 100,
      Math.sin(angle) * 100,
      35
    );
  }
}
