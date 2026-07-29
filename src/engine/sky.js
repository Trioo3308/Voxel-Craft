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

  update(dt, world) {
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

    this.renderer.scene.background = this._skyColor;
    if (this.renderer.scene.fog) this.renderer.scene.fog.color.copy(this._skyColor);

    // --- Global tint on the unlit chunk material ---------------------------
    this._tint.copy(NIGHT_TINT).lerp(DAY_TINT, dayAmount);
    this._tint.lerp(SUNSET_TINT, horizonAmount * 0.45);
    if (world) world.setLightTint(this._tint);

    // --- Entity lighting ---------------------------------------------------
    this.renderer.sunLight.intensity = 0.25 + dayAmount * 1.25;
    this.renderer.sunLight.color.copy(DAY_TINT).lerp(SUNSET_TINT, horizonAmount * 0.6);
    this.renderer.hemiLight.intensity = 0.22 + dayAmount * 0.75;
    this.renderer.ambientLight.intensity = 0.18 + dayAmount * 0.30;

    // Move the sun across the sky so entity shading direction changes.
    const angle = this.time * Math.PI * 2;
    this.renderer.sunLight.position.set(
      Math.cos(angle) * 100,
      Math.sin(angle) * 100,
      35
    );
  }
}
