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

/**
 * The records.
 *
 * A tune is a list of `[semitonesFromRoot, beats]` pairs; `null` is a rest.
 * Writing them as intervals rather than frequencies means a tune can be
 * transposed by changing one number, and it keeps each one down to a few lines
 * — which matters, because there are no audio files anywhere in this project.
 */
const TUNES = {
  // Slow, unhurried, minor pentatonic. Something to build to.
  drift: {
    bpm: 76, root: 220, wave: 'triangle', lowpass: 2200,
    melody: [[0, 2], [3, 1], [5, 1], [7, 2], [5, 2], [3, 1], [0, 1], [3, 4],
             [7, 2], [10, 1], [7, 1], [5, 2], [3, 2], [0, 4], [null, 2]],
    bass: [[-24, 4], [-24, 4], [-17, 4], [-17, 4], [-19, 4], [-19, 4], [-24, 4], [-24, 4]],
  },
  // Sparse and wide. Written for the Comb, and it is shrine loot.
  hollow: {
    bpm: 60, root: 196, wave: 'sine', lowpass: 1400,
    melody: [[0, 3], [null, 1], [7, 2], [10, 2], [null, 2], [5, 3], [null, 1],
             [3, 2], [0, 4], [null, 2], [12, 2], [10, 2], [7, 4]],
    bass: [[-24, 8], [-19, 8], [-22, 8], [-24, 8]],
  },
  // Fast and driving. The one you put on before a run.
  grind: {
    bpm: 132, root: 262, wave: 'square', lowpass: 3000,
    melody: [[0, 1], [0, 0.5], [3, 0.5], [5, 1], [3, 1], [7, 1], [5, 0.5], [3, 0.5],
             [0, 1], [null, 1], [10, 1], [7, 0.5], [5, 0.5], [3, 1], [0, 2],
             [7, 0.5], [8, 0.5], [7, 0.5], [5, 0.5], [3, 2]],
    bass: [[-12, 1], [-12, 1], [-5, 1], [-5, 1], [-7, 1], [-7, 1], [-12, 2]],
  },
};

/** Equal temperament, so a tune only has to name intervals. */
function noteFreq(root, semitones) {
  return root * Math.pow(2, semitones / 12);
}

/** Total length of a note list, in beats. */
function tuneBeats(notes) {
  let beats = 0;
  for (const [, length] of notes) beats += length;
  return beats;
}

/** Past this many blocks a jukebox is inaudible. */
const MUSIC_RANGE = 26;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.7;
    this._noiseBuffers = {};
    this._lastPlay = new Map();

    /** Jukebox playback: the tune, its own gain node, and the loop timer. */
    this._music = null;
    this._musicGain = null;
    this._musicTimer = null;
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

      case 'chitter': // comb mite — dry insect ticking, several in quick succession
        for (let i = 0; i < 4; i++) {
          this.noise({ freq: base * (5 + Math.random() * 3), q: 7, decay: 0.03,
                       gain: level * 0.45, delay: i * 0.045 });
        }
        break;

      case 'hum': // comb drifter — a slow, hollow resonance
        this.tone({ freq: base, endFreq: base * 0.88, duration: duration * 2.6, gain: level * 0.9,
                    type: 'sine', lowpass: base * 3, attack: 0.3,
                    vibrato: { rate: 3.2, depth: base * 0.04 } });
        this.tone({ freq: base * 2.01, duration: duration * 2.2, gain: level * 0.3,
                    type: 'sine', lowpass: base * 4, attack: 0.35 });
        break;

      case 'burble': // sustingus — a wet, uncertain noise from no obvious mouth
        this.tone({ freq: base, endFreq: base * 1.6, duration: duration * 0.5, gain: level * 0.8,
                    type: 'sine', lowpass: base * 4, attack: 0.03 });
        this.tone({ freq: base * 1.4, endFreq: base * 0.7, duration: duration * 0.7, gain: level * 0.6,
                    type: 'sine', lowpass: base * 3, delay: duration * 0.35, attack: 0.05,
                    vibrato: { rate: 9, depth: base * 0.12 } });
        this.noise({ freq: base * 6, q: 1.4, decay: 0.12, gain: level * 0.2, kind: 'pink',
                     type: 'lowpass', delay: duration * 0.2 });
        break;

      case 'crackle': // ember — burning, not a voice at all
        this.noise({ freq: base * 4, q: 1.1, decay: duration, gain: level * 0.7,
                     kind: 'pink', type: 'bandpass' });
        this.tone({ freq: base * 0.6, endFreq: base * 0.35, duration: duration * 1.4,
                    gain: level * 0.35, type: 'sawtooth', lowpass: base * 3 });
        break;

      case 'squeak': // bat — very short, very high, barely there
        this.tone({ freq: base, endFreq: base * 1.6, duration: duration * 0.4,
                    gain: level * 0.35, type: 'triangle', lowpass: base * 3, attack: 0.004 });
        this.tone({ freq: base * 1.5, endFreq: base * 0.9, duration: duration * 0.3,
                    gain: level * 0.22, type: 'sine', delay: duration * 0.35, attack: 0.004 });
        break;

      case 'bark': // wolf — one clipped bark, with the breath after it
        this.tone({ freq: base * 1.3, endFreq: base * 0.7, duration: duration * 0.5, gain: level,
                    type: 'sawtooth', lowpass: base * 6, attack: 0.006 });
        this.noise({ freq: base * 4, q: 1.2, decay: duration * 0.5, gain: level * 0.5, kind: 'pink' });
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

  /**
   * Continuous ambience: wind above ground, a low drone below it.
   *
   * Held as two long-lived voices whose gains are steered toward a target,
   * rather than retriggered sounds. That is what makes walking into a cave a
   * crossfade instead of a cut, and it costs two oscillator chains total no
   * matter how long you play.
   *
   * @param ctx {{underground:boolean, depth:number, dimension:string,
   *              sheltered:boolean, indoors:boolean}}
   */
  ambience(ctx) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;

    if (!this._ambience) {
      const make = (type, freq, q) => {
        const source = this.ctx.createBufferSource();
        source.buffer = this._noise('pink');
        source.loop = true;
        const filter = this.ctx.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = freq;
        filter.Q.value = q;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        source.connect(filter).connect(gain).connect(this.master);
        source.start();
        return { source, filter, gain };
      };

      this._ambience = {
        // Airy hiss for the surface.
        wind: make('bandpass', 620, 0.7),
        // Sub-bass rumble for underground.
        cave: make('lowpass', 120, 1.2),
        caveTimer: 8 + Math.random() * 20,
      };

      // A slow wobble on the wind so it breathes instead of sitting flat.
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const depth = this.ctx.createGain();
      depth.gain.value = 260;
      lfo.connect(depth).connect(this._ambience.wind.filter.frequency);
      lfo.start();
    }

    const amb = this._ambience;
    const comb = ctx.dimension === 'comb';

    // Wind fades out as you go under, and indoors.
    let windTarget = ctx.underground ? 0 : 0.05;
    if (ctx.indoors) windTarget *= 0.35;
    // The Comb has no weather and no open sky; it gets a thinner, higher tone.
    if (comb) windTarget = 0.035;

    // The drone comes up with depth, so a shallow cellar is not the deep dark.
    const depthFactor = Math.min(1, Math.max(0, (60 - ctx.depth) / 45));
    const caveTarget = ctx.underground ? 0.06 * depthFactor : 0;

    amb.wind.gain.gain.setTargetAtTime(windTarget, now, 1.5);
    amb.cave.gain.gain.setTargetAtTime(caveTarget, now, 2.0);
    amb.wind.filter.frequency.setTargetAtTime(comb ? 1500 : 620, now, 2.0);
  }

  /**
   * Occasional one-shot underground: a distant settling, a drip, a far-off
   * groan of rock. Sparse on purpose — the point is to make a cave feel
   * inhabited, and anything frequent becomes wallpaper.
   */
  caveSound(depth) {
    if (!this.ready) return;
    const pick = Math.random();

    if (pick < 0.34) {
      // Water drip.
      this.tone({ freq: 900 + Math.random() * 700, endFreq: 300, duration: 0.12,
                  gain: 0.07, type: 'sine' });
    } else if (pick < 0.68) {
      // Distant rock settling.
      this.noise({ freq: 190 + Math.random() * 120, q: 0.7, decay: 0.7,
                   gain: 0.06, kind: 'pink', type: 'lowpass' });
      this.tone({ freq: 58, endFreq: 34, duration: 0.9, gain: 0.05, type: 'sine', delay: 0.05 });
    } else {
      // A long low groan; deeper down it drops further.
      const base = 70 - Math.min(30, (60 - depth) * 0.5);
      this.tone({ freq: base, endFreq: base * 0.7, duration: 1.6, gain: 0.055,
                  type: 'sine', attack: 0.4 });
    }
  }

  /** Fade every held ambience voice out — leaving a world, or muting. */
  stopAmbience() {
    if (!this._ambience || !this.ctx) return;
    const now = this.ctx.currentTime;
    this._ambience.wind.gain.gain.setTargetAtTime(0, now, 0.3);
    this._ambience.cave.gain.gain.setTargetAtTime(0, now, 0.3);
    if (this._rainGain) this._rainGain.gain.setTargetAtTime(0, now, 0.3);
  }

  /** A rocket leaving the ground: a hiss that climbs. */
  rocketLaunch() {
    if (!this.ready) return;
    this.noise({ freq: 900, q: 0.5, decay: 0.7, gain: 0.16, kind: 'pink', type: 'bandpass' });
    this.tone({ freq: 220, endFreq: 900, duration: 0.7, gain: 0.08, type: 'sawtooth', lowpass: 2200 });
  }

  /**
   * A firework going off. The crack comes first and the crackle after, which is
   * what separates it from an explosion.
   */
  fireworkBurst(distance = 0) {
    if (!this.ready) return;
    const falloff = Math.max(0, Math.pow(1 - Math.min(1, distance / 90), 1.4));
    if (falloff <= 0.02) return;

    this.noise({ freq: 1600, q: 0.5, decay: 0.22, gain: 0.34 * falloff });
    this.tone({ freq: 120, endFreq: 40, duration: 0.5, gain: 0.22 * falloff, type: 'sine' });
    // The crackle: a scatter of tiny pops over the next half second.
    for (let i = 0; i < 14; i++) {
      this.noise({
        freq: 2600 + Math.random() * 2600, q: 8, decay: 0.03,
        gain: 0.1 * falloff, delay: 0.08 + Math.random() * 0.5,
      });
    }
  }

  /** Board wheels on the ground — a continuous roll while you ride. */
  skateRoll(speed) {
    if (!this.ready) return;
    if (!this._throttle('skate', 0.09)) return;
    const level = Math.min(1, speed / 9);
    this.noise({
      freq: 260 + speed * 40, q: 1.6, decay: 0.14,
      gain: 0.05 + level * 0.07, kind: 'pink', type: 'bandpass',
    });
  }

  /** The pop of an ollie. */
  skatePop() {
    if (!this.ready) return;
    this.noise({ freq: 1500, q: 3, decay: 0.07, gain: 0.2 });
    this.tone({ freq: 300, endFreq: 140, duration: 0.1, gain: 0.12, type: 'square', lowpass: 1400 });
  }

  /** Landing a trick cleanly — pitch rises with the combo. */
  skateLand(combo = 1) {
    if (!this.ready) return;
    const base = 420 + Math.min(8, combo) * 90;
    this.noise({ freq: 900, q: 2, decay: 0.09, gain: 0.16, kind: 'pink' });
    this.tone({ freq: base, endFreq: base * 1.5, duration: 0.14, gain: 0.13,
                type: 'triangle', lowpass: base * 5 });
  }

  /**
   * Grinding a rail: metal on metal, brighter and thinner than rolling, with a
   * tone on top so it reads as continuous rather than as rough ground.
   */
  skateGrind(speed) {
    if (!this.ready) return;
    if (!this._throttle('grind', 0.07)) return;
    const level = Math.min(1, speed / 9);
    this.noise({
      freq: 2400 + speed * 90, q: 5, decay: 0.12,
      gain: 0.05 + level * 0.06, kind: 'white', type: 'bandpass',
    });
    this.tone({ freq: 1150 + speed * 30, duration: 0.09, gain: 0.025,
                type: 'sawtooth', lowpass: 4200 });
  }

  /** Bailing. */
  skateBail() {
    if (!this.ready) return;
    this.noise({ freq: 420, q: 0.8, decay: 0.35, gain: 0.24, kind: 'pink', type: 'lowpass' });
    this.tone({ freq: 200, endFreq: 70, duration: 0.4, gain: 0.16, type: 'sawtooth', lowpass: 800 });
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /**
   * Start a record, looping until it is stopped.
   *
   * The whole tune is scheduled up front — the Web Audio clock is sample
   * accurate, whereas a per-note timer would drift audibly within a few bars —
   * and a timer only fires to schedule the next repeat.
   */
  playMusic(name) {
    const tune = TUNES[name];
    if (!tune || !this.ready) return false;

    this.stopMusic();

    this._musicGain = this.ctx.createGain();
    this._musicGain.gain.value = 0.5;
    this._musicGain.connect(this.master);
    this._music = name;

    const beat = 60 / tune.bpm;
    const bars = Math.max(tuneBeats(tune.melody), tuneBeats(tune.bass)) * beat;

    const schedule = () => {
      if (this._music !== name) return;
      this._scheduleTune(tune, beat);
      // Re-arm slightly early so the loop joins without a gap.
      this._musicTimer = setTimeout(schedule, (bars - 0.1) * 1000);
    };
    schedule();
    return true;
  }

  /** Lay one pass of a tune onto the audio clock. */
  _scheduleTune(tune, beat) {
    const voice = (notes, { wave, gain, octave = 0, sustain = 0.9 }) => {
      let at = 0;
      for (const [semi, length] of notes) {
        const seconds = length * beat;
        if (semi !== null) {
          this._musicNote({
            freq: noteFreq(tune.root, semi + octave * 12),
            duration: seconds * sustain,
            delay: at, gain, type: wave, lowpass: tune.lowpass,
          });
        }
        at += seconds;
      }
    };

    voice(tune.melody, { wave: tune.wave, gain: 0.16 });
    voice(tune.bass, { wave: 'triangle', gain: 0.13, sustain: 0.75 });
  }

  /** A tone routed through the music gain rather than straight to master. */
  _musicNote({ freq, duration, delay, gain, type, lowpass }) {
    if (!this.ready || !this._musicGain) return;
    const t = this.ctx.currentTime + delay;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.02);
    env.gain.setValueAtTime(gain, t + duration * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    filter.Q.value = 0.7;

    osc.connect(filter);
    filter.connect(env);
    env.connect(this._musicGain);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** Take the record off. */
  stopMusic() {
    this._music = null;
    if (this._musicTimer !== null) {
      clearTimeout(this._musicTimer);
      this._musicTimer = null;
    }
    if (this._musicGain) {
      // Fade rather than cut, or already-scheduled notes click as they land.
      const g = this._musicGain;
      if (this.ready) {
        g.gain.setValueAtTime(g.gain.value, this.ctx.currentTime);
        g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.15);
        setTimeout(() => g.disconnect(), 400);
      } else {
        g.disconnect();
      }
      this._musicGain = null;
    }
  }

  get musicPlaying() {
    return this._music !== null;
  }

  /** Fade the record out with distance, so a jukebox is a place, not a mood. */
  setMusicDistance(distance) {
    if (!this._musicGain || !this.ready) return;
    const level = Math.max(0, 1 - distance / MUSIC_RANGE);
    this._musicGain.gain.setTargetAtTime(0.5 * level * level, this.ctx.currentTime, 0.2);
  }

  /** An achievement: a short rising arpeggio, distinct from anything else. */
  achievement() {
    if (!this.ready) return;
    const base = 523;
    [0, 4, 7, 12].forEach((semi, i) => {
      this.tone({
        freq: base * Math.pow(2, semi / 12), duration: 0.22, gain: 0.11,
        type: 'triangle', delay: i * 0.075, lowpass: 4000,
      });
    });
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
