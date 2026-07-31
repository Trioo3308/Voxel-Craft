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

  /**
   * Shaped oscillator, optionally sweeping between two pitches.
   *
   * `lowpass` matters more than it looks: a bare sawtooth or square is all
   * upper harmonics and reads as a harsh electronic beep. Rolling the top off
   * is what makes a synthesised animal call sound like an animal.
   */
  tone({
    freq = 440, endFreq = null, duration = 0.15, gain = 0.2, type = 'sine',
    delay = 0, attack = 0.005, lowpass = null, vibrato = null,
  } = {}) {
    if (!this.ready || gain <= 0.0005) return;
    const t = this.ctx.currentTime + delay;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + duration);

    // Optional warble, which is what sells a bleat or a moo.
    if (vibrato) {
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = vibrato.rate;
      const depth = this.ctx.createGain();
      depth.gain.value = vibrato.depth;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + duration + 0.02);
    }

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    let node = osc;
    if (lowpass !== null) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpass;
      filter.Q.value = 0.7;
      osc.connect(filter);
      node = filter;
    }

    node.connect(env);
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
   *
   * @param distance metres from the listener; used to attenuate and to drop
   *   calls from animals too far away to be worth hearing.
   */
  mobSound(profile, kind = 'idle', distance = 0) {
    if (!this.ready || !profile) return;

    // Distance culling and falloff. Without this, a herd two hundred blocks
    // away is just as loud as the cow next to you.
    if (distance > MOB_AUDIBLE_RANGE) return;
    const falloff = Math.pow(1 - distance / MOB_AUDIBLE_RANGE, 1.7);
    if (falloff <= 0.02) return;

    // Idle chatter also competes for one global slot, so a big herd cannot
    // produce a continuous stream of noise.
    if (kind === 'idle' && !this._throttle('mobIdle', 1.6)) return;
    if (!this._throttle('mob:' + profile.name + kind, 0.25)) return;

    // ±6% pitch jitter: enough to stop repetition sounding mechanical, small
    // enough that a species stays recognisable.
    const base = profile.pitch * (0.94 + Math.random() * 0.12);
    const level = (kind === 'hurt' ? 0.20 : kind === 'death' ? 0.22 : 0.11) * falloff;
    const duration = kind === 'death' ? profile.duration * 1.8 : profile.duration;

    switch (profile.voice) {
      case 'groan': // zombie — low, breathy
        this.tone({ freq: base, endFreq: base * 0.72, duration: duration * 1.7, gain: level, type: 'sawtooth', lowpass: base * 5, attack: 0.05 });
        this.noise({ freq: base * 4, q: 0.8, decay: duration, gain: level * 0.35, kind: 'pink', type: 'lowpass' });
        break;

      case 'rattle': // skeleton — dry bone clicks, no voice at all
        for (let i = 0; i < 3; i++) {
          this.noise({ freq: 900 + Math.random() * 500, q: 5, decay: 0.045, gain: level * 0.55, delay: i * 0.07 });
        }
        break;

      case 'hiss': // spider
        this.noise({ freq: 1500, q: 0.6, decay: duration * 1.3, gain: level * 0.5, kind: 'pink', type: 'bandpass' });
        break;

      case 'fuse': // creeper — sharp intake, unmistakable
        this.noise({ freq: 2000, q: 0.7, decay: 0.5, gain: level * 1.4, kind: 'white', type: 'bandpass' });
        break;

      case 'oink': // pig — two short grunts
        this.tone({ freq: base, endFreq: base * 1.35, duration: duration * 0.45, gain: level, type: 'sawtooth', lowpass: base * 4, attack: 0.015 });
        this.tone({ freq: base * 1.1, endFreq: base * 0.8, duration: duration * 0.45, gain: level * 0.75, type: 'sawtooth', lowpass: base * 4, delay: duration * 0.5, attack: 0.015 });
        break;

      case 'moo': // cow — long, low, slow swell
        this.tone({ freq: base, endFreq: base * 0.8, duration: duration * 2.4, gain: level, type: 'triangle', lowpass: base * 6, attack: 0.14, vibrato: { rate: 5, depth: base * 0.02 } });
        break;

      case 'baa': // sheep — bleat carried by the warble, not by harshness
        this.tone({ freq: base, endFreq: base * 0.94, duration: duration * 1.5, gain: level, type: 'triangle', lowpass: base * 5, attack: 0.04, vibrato: { rate: 17, depth: base * 0.07 } });
        break;

      case 'cluck': // chicken — soft wooden knock, not a beep
        this.tone({ freq: base, endFreq: base * 0.62, duration: 0.09, gain: level * 0.8, type: 'triangle', lowpass: base * 3, attack: 0.008 });
        this.tone({ freq: base * 0.85, endFreq: base * 0.5, duration: 0.08, gain: level * 0.55, type: 'triangle', lowpass: base * 3, delay: 0.13, attack: 0.008 });
        break;

      default:
        this.tone({ freq: base, duration, gain: level, type: 'triangle', lowpass: base * 4 });
    }
  }

  /** Explosion: deep boom plus a long debris tail. */
  explosion(distance = 0) {
    if (!this.ready) return;
    const falloff = Math.max(0, Math.pow(1 - Math.min(1, distance / 42), 1.5));
    if (falloff <= 0.02) return;

    this.tone({ freq: 90, endFreq: 26, duration: 0.85, gain: 0.42 * falloff, type: 'sine' });
    this.noise({ freq: 320, q: 0.4, decay: 0.7, gain: 0.38 * falloff, kind: 'pink', type: 'lowpass' });
    this.noise({ freq: 1500, q: 0.5, decay: 0.35, gain: 0.16 * falloff });
    // Debris settling afterwards.
    for (let i = 0; i < 5; i++) {
      this.noise({ freq: 700 + Math.random() * 900, q: 3, decay: 0.09, gain: 0.09 * falloff, delay: 0.2 + Math.random() * 0.5 });
    }
  }

  /**
   * A thunderclap: a sharp crack, then a long rolling tail.
   *
   * The delay before the roll is what sells distance — a strike that cracks and
   * stops sounds like a firework, not weather.
   */
  thunder() {
    if (!this.ready) return;
    const near = Math.random() < 0.35;
    const gain = near ? 0.5 : 0.28;

    // Initial crack.
    this.noise({ freq: near ? 2200 : 900, q: 0.6, decay: 0.18, gain: gain * 0.6 });
    this.tone({ freq: 70, endFreq: 22, duration: 1.1, gain: gain * 0.5, type: 'sine' });

    // The roll: overlapping low rumbles fading out over a couple of seconds.
    for (let i = 0; i < 6; i++) {
      this.noise({
        freq: 180 + Math.random() * 220,
        q: 0.5,
        decay: 0.5 + Math.random() * 0.8,
        gain: gain * (0.32 - i * 0.04),
        kind: 'pink',
        type: 'lowpass',
        delay: 0.12 + i * 0.22 + Math.random() * 0.18,
      });
    }
  }

  /**
   * The steady hiss of falling rain, held as one looping voice rather than
   * retriggered per drop — a few hundred one-shots a second would be both
   * expensive and audibly granular.
   *
   * @param intensity 0..1; 0 stops it.
   */
  rain(intensity, snow = false) {
    if (!this.ready) return;

    if (intensity <= 0.01) {
      if (this._rainGain) {
        this._rainGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
      }
      return;
    }

    if (!this._rainGain) {
      const source = this.ctx.createBufferSource();
      source.buffer = this._noise('white');
      source.loop = true;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2600;
      filter.Q.value = 0.4;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;

      source.connect(filter).connect(gain).connect(this.master);
      source.start();

      this._rainSource = source;
      this._rainFilter = filter;
      this._rainGain = gain;
    }

    // Snow is near-silent; rain is a wash. Both stay well under the mix so
    // footsteps and mobs are still audible through the weather.
    const target = snow ? intensity * 0.012 : intensity * 0.085;
    this._rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6);
    this._rainFilter.frequency.setTargetAtTime(snow ? 900 : 2600, this.ctx.currentTime, 0.6);
  }

  /** Bowstring being drawn — pitch rises with charge. */
  bowDraw(charge) {
    if (!this._throttle('bowDraw', 0.18)) return;
    this.tone({ freq: 160 + charge * 180, duration: 0.1, gain: 0.06, type: 'triangle', lowpass: 1200 });
  }

  /** Door hinge. */
  door(opening) {
    this.noise({ freq: opening ? 700 : 520, q: 2.5, decay: 0.22, gain: 0.18, kind: 'pink' });
    this.tone({ freq: opening ? 220 : 180, endFreq: opening ? 300 : 140, duration: 0.18, gain: 0.1, type: 'triangle', lowpass: 900 });
  }

  /** Chest lid. */
  chest(opening) {
    this.noise({ freq: 400, q: 1.6, decay: 0.2, gain: 0.16, kind: 'pink', type: 'lowpass' });
    this.tone({ freq: opening ? 180 : 150, endFreq: opening ? 260 : 110, duration: 0.16, gain: 0.09, type: 'triangle', lowpass: 800 });
  }
}

/** Mob calls fade to nothing past this many blocks. */
const MOB_AUDIBLE_RANGE = 24;

export const audio = new AudioEngine();
