/**
 * audio.js — Procedural sound, synthesised at runtime.
 *
 * Everything here is generated with Web Audio oscillators and noise buffers —
 * no audio files, matching how the textures are painted rather than shipped.
 * That keeps the whole game a handful of source files with zero assets.
 *
 * The vocabulary is deliberately small and reused:
 *   noise()  filtered noise burst  -> footsteps, digging, splashes
 *   tone()   shaped oscillator     -> pickups, UI, mob voices
 *   thud()   pitch-swept sine      -> landings, placing blocks
 *
 * A browser will not let audio start before a user gesture, so the context is
 * created lazily and `resume()` is called on the first click.
 */

/** Per-material voicing for footsteps and mining. */
const MATERIALS = {
  grass:  { freq: 620,  q: 0.9, decay: 0.10, gain: 0.32, noise: 'pink' },
  dirt:   { freq: 420,  q: 0.9, decay: 0.11, gain: 0.34, noise: 'pink' },
  stone:  { freq: 1500, q: 2.2, decay: 0.07, gain: 0.30, noise: 'white' },
  wood:   { freq: 900,  q: 3.0, decay: 0.09, gain: 0.32, noise: 'white' },
  sand:   { freq: 1900, q: 0.7, decay: 0.13, gain: 0.26, noise: 'white' },
  gravel: { freq: 800,  q: 1.4, decay: 0.12, gain: 0.34, noise: 'white' },
  glass:  { freq: 3200, q: 6.0, decay: 0.14, gain: 0.30, noise: 'white' },
  wool:   { freq: 300,  q: 0.6, decay: 0.12, gain: 0.24, noise: 'pink' },
  metal:  { freq: 2400, q: 5.0, decay: 0.12, gain: 0.26, noise: 'white' },
  liquid: { freq: 700,  q: 0.5, decay: 0.22, gain: 0.30, noise: 'pink' },
};

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.7;
    this._noiseBuffers = {};
    this._lastPlay = new Map();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Create the context. Safe to call repeatedly; must follow a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return; // no audio support; every call below becomes a no-op

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    // A gentle limiter stops overlapping sounds from clipping.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    this.master.connect(limiter);
    limiter.connect(this.ctx.destination);
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /** Cached noise buffer. 'white' is flat; 'pink' is softer and duller. */
  _noise(kind) {
    if (this._noiseBuffers[kind]) return this._noiseBuffers[kind];

    const length = Math.floor(this.ctx.sampleRate * 0.5);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (kind === 'pink') {
      // Cheap pink-ish noise: a one-pole lowpass over white noise.
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    } else {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }

    this._noiseBuffers[kind] = buffer;
    return buffer;
  }

  /**
   * Filtered noise burst — the workhorse for anything percussive or gritty.
   */
  noise({ freq = 1000, q = 1, decay = 0.1, gain = 0.3, kind = 'white', type = 'bandpass', delay = 0 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;

    const source = this.ctx.createBufferSource();
    source.buffer = this._noise(kind);
    // Random offset so repeated footsteps are not identical.
    const offset = Math.random() * 0.3;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    source.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    source.start(t, offset, decay + 0.05);
    source.stop(t + decay + 0.05);
  }

  /** Shaped oscillator, optionally sweeping between two pitches. */
  tone({ freq = 440, endFreq = null, duration = 0.15, gain = 0.2, type = 'sine', delay = 0, attack = 0.005 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + duration);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(env);
    env.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** Low pitch-swept sine — landings, block placement. */
  thud({ freq = 150, gain = 0.35, duration = 0.16, delay = 0 } = {}) {
    this.tone({ freq, endFreq: freq * 0.45, duration, gain, type: 'sine', delay });
  }

  /** Rate-limit a repeating sound so it cannot machine-gun. */
  _throttle(key, minInterval) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    const last = this._lastPlay.get(key) ?? -Infinity;
    if (now - last < minInterval) return false;
    this._lastPlay.set(key, now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Game sounds
  // -------------------------------------------------------------------------

  footstep(material = 'grass') {
    if (!this.ready || !this._throttle('step', 0.22)) return;
    const m = MATERIALS[material] ?? MATERIALS.grass;
    const detune = 0.85 + Math.random() * 0.3;
    this.noise({
      freq: m.freq * detune, q: m.q, decay: m.decay * 0.7,
      gain: m.gain * 0.45, kind: m.noise,
    });
  }

  /** Repeated while mining — quieter and shorter than the break itself. */
  dig(material = 'stone') {
    if (!this.ready || !this._throttle('dig', 0.18)) return;
    const m = MATERIALS[material] ?? MATERIALS.stone;
    this.noise({
      freq: m.freq * (0.8 + Math.random() * 0.4), q: m.q,
      decay: m.decay * 0.6, gain: m.gain * 0.35, kind: m.noise,
    });
  }

  blockBreak(material = 'stone') {
    const m = MATERIALS[material] ?? MATERIALS.stone;
    // Two layers: a bright crack plus a body thump.
    this.noise({ freq: m.freq * 1.2, q: m.q, decay: m.decay * 1.6, gain: m.gain, kind: m.noise });
    this.thud({ freq: 120, gain: 0.14, duration: 0.12 });
    if (material === 'glass') {
      // Glass gets a little shatter tail.
      for (let i = 0; i < 4; i++) {
        this.noise({ freq: 2600 + Math.random() * 2200, q: 8, decay: 0.07, gain: 0.10, delay: 0.02 + i * 0.035 });
      }
    }
  }

  blockPlace(material = 'stone') {
    const m = MATERIALS[material] ?? MATERIALS.stone;
    this.noise({ freq: m.freq, q: m.q * 1.5, decay: m.decay * 0.5, gain: m.gain * 0.6, kind: m.noise });
    this.thud({ freq: 170, gain: 0.16, duration: 0.1 });
  }

  playerHurt() {
    // Short strained vocal-ish blip, not a scream.
    this.tone({ freq: 300, endFreq: 190, duration: 0.18, gain: 0.26, type: 'triangle' });
    this.noise({ freq: 500, q: 1.2, decay: 0.12, gain: 0.14, kind: 'pink' });
  }

  playerDeath() {
    this.tone({ freq: 260, endFreq: 90, duration: 0.7, gain: 0.28, type: 'triangle' });
    this.tone({ freq: 130, endFreq: 50, duration: 0.9, gain: 0.2, type: 'sine', delay: 0.06 });
  }

  fall(distance) {
    const strength = Math.min(1, distance / 12);
    this.thud({ freq: 90, gain: 0.2 + strength * 0.3, duration: 0.2 + strength * 0.15 });
  }

  jump() {
    if (!this._throttle('jump', 0.15)) return;
    this.noise({ freq: 500, q: 0.8, decay: 0.06, gain: 0.10, kind: 'pink' });
  }

  splash() {
    this.noise({ freq: 800, q: 0.5, decay: 0.35, gain: 0.3, kind: 'pink', type: 'lowpass' });
    this.noise({ freq: 2200, q: 0.7, decay: 0.18, gain: 0.16, delay: 0.03 });
  }

  pickup() {
    if (!this._throttle('pickup', 0.06)) return;
    this.tone({ freq: 760, endFreq: 1180, duration: 0.1, gain: 0.16, type: 'square' });
  }

  eat() {
    for (let i = 0; i < 3; i++) {
      this.noise({ freq: 420, q: 1.4, decay: 0.08, gain: 0.18, kind: 'pink', delay: i * 0.12 });
    }
  }

  craft() {
    this.tone({ freq: 520, duration: 0.08, gain: 0.16, type: 'square' });
    this.tone({ freq: 780, duration: 0.1, gain: 0.14, type: 'square', delay: 0.07 });
  }

  toolBreak() {
    this.noise({ freq: 1800, q: 4, decay: 0.2, gain: 0.3 });
    this.tone({ freq: 420, endFreq: 140, duration: 0.25, gain: 0.2, type: 'sawtooth' });
  }

  /** Furnace ignition. */
  ignite() {
    this.noise({ freq: 1200, q: 0.6, decay: 0.4, gain: 0.2, kind: 'pink', type: 'lowpass' });
  }

  /** Bowstring release. */
  bow() {
    this.tone({ freq: 240, endFreq: 700, duration: 0.12, gain: 0.18, type: 'triangle' });
    this.noise({ freq: 1800, q: 2, decay: 0.09, gain: 0.12 });
  }

  arrowHit() {
    this.noise({ freq: 1400, q: 3, decay: 0.09, gain: 0.2 });
    this.thud({ freq: 200, gain: 0.12, duration: 0.08 });
  }

  /**
   * Mob voice. `profile` comes from the mob type so each species is distinct
   * without needing its own bespoke code.
   */
  mobSound(profile, kind = 'idle') {
    if (!this.ready || !profile) return;
    if (!this._throttle('mob:' + profile.name + kind, 0.12)) return;

    const base = profile.pitch * (0.88 + Math.random() * 0.24);
    const gain = kind === 'hurt' ? 0.28 : kind === 'death' ? 0.3 : 0.18;
    const duration = kind === 'death' ? profile.duration * 2 : profile.duration;

    switch (profile.voice) {
      case 'groan': // zombie
        this.tone({ freq: base, endFreq: base * 0.7, duration: duration * 1.6, gain, type: 'sawtooth' });
        this.noise({ freq: base * 3, q: 1.2, decay: duration, gain: gain * 0.5, kind: 'pink' });
        break;

      case 'rattle': // skeleton — dry clicks, no voice
        for (let i = 0; i < 4; i++) {
          this.noise({ freq: 2200 + Math.random() * 900, q: 9, decay: 0.05, gain: gain * 0.7, delay: i * 0.055 });
        }
        break;

      case 'hiss': // spider
        this.noise({ freq: 3400, q: 0.9, decay: duration * 1.4, gain: gain * 0.8, type: 'highpass' });
        break;

      case 'oink': // pig
        this.tone({ freq: base, endFreq: base * 1.5, duration: duration * 0.5, gain, type: 'sawtooth' });
        this.tone({ freq: base * 1.2, endFreq: base * 0.8, duration: duration * 0.5, gain: gain * 0.8, type: 'sawtooth', delay: duration * 0.45 });
        break;

      case 'moo': // cow
        this.tone({ freq: base, endFreq: base * 0.85, duration: duration * 2.2, gain, type: 'triangle', attack: 0.06 });
        break;

      case 'baa': // sheep
        this.tone({ freq: base, endFreq: base * 1.1, duration: duration * 1.4, gain, type: 'sawtooth' });
        // Vibrato-ish warble via a couple of quick repeats.
        this.tone({ freq: base * 1.06, duration: duration * 0.5, gain: gain * 0.6, type: 'sawtooth', delay: duration * 0.5 });
        break;

      case 'cluck': // chicken
        this.tone({ freq: base, endFreq: base * 0.6, duration: 0.07, gain, type: 'square' });
        this.tone({ freq: base * 0.9, endFreq: base * 0.5, duration: 0.06, gain: gain * 0.8, type: 'square', delay: 0.1 });
        break;

      default:
        this.tone({ freq: base, duration, gain, type: 'triangle' });
    }
  }
}

export const audio = new AudioEngine();
