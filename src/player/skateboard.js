/**
 * skateboard.js — Riding, tricks and combo scoring.
 *
 * Kept out of player.js because it is a self-contained scoring machine: the
 * player owns one of these and hands it input each frame, and it owns every
 * question about what a trick is, when a combo breaks and what anything is
 * worth. That means the trick table can be extended without touching physics.
 *
 * Tricks are read from what you were *already* doing rather than from dedicated
 * buttons — the direction you hold and how far you spin. Nothing new to learn,
 * and it keeps both hands free for actually steering.
 */

/**
 * Trick definitions.
 *
 * `detect` is given the airborne state and returns true if that trick is being
 * performed right now. Order matters: the first match wins, so the showier
 * tricks are listed first.
 */
const TRICKS = [
  {
    name: 'Kickflip', points: 120,
    detect: (s) => s.heldLateral < 0 && s.airTime > 0.18,
  },
  {
    name: 'Heelflip', points: 120,
    detect: (s) => s.heldLateral > 0 && s.airTime > 0.18,
  },
  {
    name: 'Nose Grab', points: 90,
    detect: (s) => s.heldForward > 0 && s.airTime > 0.18,
  },
  {
    name: 'Tail Grab', points: 90,
    detect: (s) => s.heldForward < 0 && s.airTime > 0.18,
  },
];

/** Spin milestones, biggest first so a 720 does not report as a 180. */
const SPINS = [
  { turns: 2.0, name: '720 Spin', points: 500 },
  { turns: 1.5, name: '540 Spin', points: 320 },
  { turns: 1.0, name: '360 Spin', points: 200 },
  { turns: 0.5, name: '180 Spin', points: 100 },
];

/** Airborne longer than this and the hang time itself is worth something. */
const BIG_AIR_SECONDS = 1.1;
const BIG_AIR_POINTS = 150;

/**
 * Grinding.
 *
 * Style accrues per second rather than per grind, so a long rail is worth more
 * than a short one and there is a reason to build a long one. A grind has to
 * last a moment before it counts, or brushing a fence post would score.
 */
const GRIND_MIN_SECONDS = 0.35;
const GRIND_POINTS_PER_SECOND = 110;
/** Named by how long you held it, so the readout says something specific. */
const GRIND_TIERS = [
  { seconds: 4.0, name: 'Endless Grind' },
  { seconds: 2.5, name: 'Long Grind' },
  { seconds: 1.2, name: 'Grind' },
  { seconds: GRIND_MIN_SECONDS, name: 'Short Grind' },
];

/**
 * A fall this hard while riding is a bail, not a landing.
 *
 * Sized above what a rocket can launch you (5.8 blocks straight up), so the
 * move the trick list is built around never punishes you for landing it. Drop
 * off something taller than this and you are falling, not skating.
 */
export const BAIL_FALL_DISTANCE = 10;

export class Skateboard {
  constructor() {
    /** Lifetime style points. Saved with the world. */
    this.totalStyle = 0;
    /** The best single run so far, for the statistics screen. */
    this.lastBanked = 0;

    /** Tricks banked in the current run, and the multiplier they have earned. */
    this.comboTricks = [];
    this.comboPoints = 0;
    /** Seconds left before an unlanded combo expires on the ground. */
    this.comboGrace = 0;

    /** Per-jump accumulators. */
    this.airTime = 0;
    this.spinAccum = 0;
    /** Null until the first update seeds it. See `mount`. */
    this._lastYaw = null;
    this._airTricks = [];
    this._wasAirborne = false;

    /** How long the current grind has lasted, and whether one is running. */
    this.grindTime = 0;
    this.grinding = false;

    /**
     * The most recent landing, bail or payout, and a counter that ticks with
     * it. The event is never cleared: the HUD compares `eventSeq` against the
     * last one it drew, so it reacts exactly once no matter what order the
     * frame runs in. Clearing it after a frame instead meant a run banked
     * outside the update loop — stepping off the board does exactly that —
     * could be wiped before anything had shown it.
     */
    this.lastEvent = null;
    this.eventSeq = 0;
    /** How long the HUD should keep showing the combo readout. */
    this.displayTimer = 0;
  }

  get riding() {
    return this._riding === true;
  }

  /** Post an event for the HUD, bumping the sequence so it is seen once. */
  _emit(event) {
    this.lastEvent = event;
    this.eventSeq++;
  }

  /** Combo multiplier: one per trick in the chain, capped so it stays sane. */
  get multiplier() {
    return Math.min(8, 1 + this.comboTricks.length);
  }

  mount() {
    this._riding = true;
    this.resetRun();
    // Unknown until the first update; seeding it with 0 would read as a huge
    // spin on frame one if you happened to be facing the other way.
    this._lastYaw = null;
  }

  /** @returns points banked by stepping off, so the caller can announce them. */
  dismount() {
    // Stepping off banks whatever is pending rather than losing it.
    const gained = this.bankCombo();
    this._riding = false;
    return gained;
  }

  resetRun() {
    this.comboTricks = [];
    this.comboPoints = 0;
    this.comboGrace = 0;
    this.airTime = 0;
    this.spinAccum = 0;
    this._airTricks = [];
    this.grindTime = 0;
    this.grinding = false;
  }

  /**
   * @param dt seconds
   * @param state {{onGround, onRail, yaw, fallDistance, heldForward, heldLateral, speed}}
   */
  update(dt, state) {
    // The readout has to keep fading after you step off, so the timer runs
    // whether or not you are still on the board.
    if (this.displayTimer > 0) this.displayTimer -= dt;
    if (!this._riding) return;

    if (this._lastYaw === null) this._lastYaw = state.yaw;

    const airborne = !state.onGround;

    // A grind holds the combo open on its own, so a rail is a way to link two
    // jumps together rather than a place the chain quietly expires.
    this._updateGrind(dt, state);

    if (airborne) {
      if (!this._wasAirborne) this._startAir();
      this._updateAir(dt, state);
    } else if (this._wasAirborne) {
      this._land(state);
    } else if (!this.grinding) {
      // On the ground with a live combo: it expires if you do not pop again.
      if (this.comboTricks.length > 0) {
        this.comboGrace -= dt;
        if (this.comboGrace <= 0) this.bankCombo();
      }
    }

    this._wasAirborne = airborne;
    this._lastYaw = state.yaw;
  }

  /**
   * Rolling along a rail. Entirely separate from the jump machinery — you are
   * on the ground the whole time — so it has its own start/stop rather than
   * being folded into `_land`.
   */
  _updateGrind(dt, state) {
    // You have to actually be moving. Parking on a rail is not a grind.
    const riding = state.onRail && state.onGround && state.speed > 1.2;

    if (riding) {
      this.grinding = true;
      this.grindTime += dt;
      return;
    }

    if (!this.grinding) return;

    // Coming off. Score it if it lasted, then reset either way.
    const held = this.grindTime;
    this.grinding = false;
    this.grindTime = 0;
    if (held < GRIND_MIN_SECONDS) return;

    const tier = GRIND_TIERS.find((t) => held >= t.seconds) ?? GRIND_TIERS[GRIND_TIERS.length - 1];
    const points = Math.round(held * GRIND_POINTS_PER_SECOND);
    this.comboTricks.push({ name: tier.name, points });
    this.comboPoints += points;
    this.comboGrace = 2.5;
    this.displayTimer = 3;
    this._emit({ type: 'land', tricks: [{ name: tier.name, points }], combo: this.comboTricks.length });
  }

  _startAir() {
    this.airTime = 0;
    this.spinAccum = 0;
    this._airTricks = [];
    // `_lastYaw` is deliberately left alone: it still holds the yaw from the
    // frame you popped on, and resetting it here threw away that frame's
    // rotation. One frame is small, but it lands exactly on the milestone
    // boundary — a clean 540 scored as a 360.
  }

  _updateAir(dt, state) {
    this.airTime += dt;

    // Accumulate absolute rotation, wrapped so crossing +/-PI is not a huge jump.
    let delta = state.yaw - this._lastYaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.spinAccum += Math.abs(delta);

    // Register at most one of each trick per jump, so holding a direction the
    // whole way up does not score it repeatedly.
    for (const trick of TRICKS) {
      if (this._airTricks.some((t) => t.name === trick.name)) continue;
      if (!trick.detect({ ...state, airTime: this.airTime })) continue;
      this._airTricks.push({ name: trick.name, points: trick.points });
    }
  }

  /**
   * Touching down. A clean landing banks the jump's tricks into the combo; too
   * hard a fall bails and loses the lot.
   */
  _land(state) {
    if (state.fallDistance > BAIL_FALL_DISTANCE) {
      this.bail();
      return;
    }

    const scored = [...this._airTricks];

    // Spin: whichever milestone the rotation cleared.
    const turns = this.spinAccum / (Math.PI * 2);
    const spin = SPINS.find((s) => turns >= s.turns);
    if (spin) scored.push({ name: spin.name, points: spin.points });

    if (this.airTime >= BIG_AIR_SECONDS) {
      scored.push({ name: 'Big Air', points: BIG_AIR_POINTS });
    }

    if (scored.length === 0) {
      // A plain hop keeps an existing combo alive but adds nothing.
      if (this.comboTricks.length > 0) this.comboGrace = 2.0;
      return;
    }

    for (const trick of scored) {
      this.comboTricks.push(trick);
      this.comboPoints += trick.points;
    }
    this.comboGrace = 2.5;
    this.displayTimer = 3;
    this._emit({ type: 'land', tricks: scored, combo: this.comboTricks.length });
  }

  /** Bail: the whole chain is lost. */
  bail() {
    if (this.comboTricks.length > 0 || this._airTricks.length > 0) {
      this._emit({ type: 'bail', lost: this.comboPoints * this.multiplier });
      this.displayTimer = 2;
    }
    this.resetRun();
  }

  /**
   * Bank the current chain into the lifetime total.
   * @returns the points added, or 0 if there was no chain to bank.
   */
  bankCombo() {
    if (this.comboTricks.length === 0) {
      this.resetRun();
      return 0;
    }
    const gained = Math.round(this.comboPoints * this.multiplier);
    this.totalStyle += gained;
    this.lastBanked = gained;
    this._emit({ type: 'bank', gained, combo: this.comboTricks.length });
    this.displayTimer = 2.5;
    this.resetRun();
    return gained;
  }

  /** Text for the HUD: the chain so far and what it is currently worth. */
  describeCombo() {
    if (this.comboTricks.length === 0) return null;
    const names = this.comboTricks.map((t) => t.name).join(' + ');
    return {
      names,
      points: this.comboPoints,
      multiplier: this.multiplier,
      total: Math.round(this.comboPoints * this.multiplier),
    };
  }
}

export { TRICKS, SPINS };
