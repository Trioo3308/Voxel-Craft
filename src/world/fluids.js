/**
 * fluids.js — Flowing water and lava, in the style of early Minecraft.
 *
 * MODEL
 * -----
 * A fluid cell is either a *source* (level 0, permanent) or a *flow*
 * (level 1..max, which only exists while something upstream keeps feeding it).
 * Each tick a flow recomputes the level it is entitled to:
 *
 *   - fed from directly above          -> level 1 (a falling column stays strong)
 *   - otherwise  min(horizontal neighbour levels) + 1
 *   - if that exceeds the family's max -> the cell dries up
 *
 * Then it spreads: straight down if there is room, otherwise outward to the
 * four horizontal neighbours at one level weaker. Because levels only ever grow
 * as you move away from a source, the system always settles — and removing the
 * source makes the whole pool recede on its own.
 *
 * SCHEDULING
 * ----------
 * This is an event-driven automaton, not a per-frame sweep: only cells adjacent
 * to a change are queued. That is what makes it affordable in an infinite world
 * — a static ocean of source blocks costs literally nothing until you disturb it.
 *
 * THREADING
 * ---------
 * Runs on the main thread, which already holds authoritative voxel data for
 * collision and raycasting. Writes are applied locally at once but the worker
 * sync is *batched* per tick (`world.flushBlockChanges()`), so a spreading pool
 * triggers one remesh per affected chunk rather than one per changed block.
 */

import { AIR, COBBLE, OBSIDIAN, getFluid, fluidId, FLUIDS } from './blocks.js';
import { CHUNK_SY } from './chunk.js';

/** The four horizontal directions fluid can spread into. */
const HORIZONTAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class FluidSimulator {
  /** @param {import('./world.js').World} world */
  constructor(world) {
    this.world = world;

    /** Cells to evaluate on the next tick, as "x,y,z" keys. */
    this.pending = new Set();

    /** Seconds between fluid ticks (water moves one block per tick). */
    this.tickInterval = 0.2;
    /** Hard cap on cells evaluated per tick; overflow rolls to the next one. */
    this.budget = 3000;

    this._timer = 0;
    this._tickCount = 0;
    this.stats = { pending: 0, lastProcessed: 0 };
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  schedule(x, y, z) {
    if (y < 0 || y >= CHUNK_SY) return;
    this.pending.add(x + ',' + y + ',' + z);
  }

  /**
   * Called by World.setBlock for every change, whoever made it.
   * Queues the cell plus its six face neighbours — the only cells whose
   * equilibrium this edit could possibly have broken.
   */
  onBlockChanged(x, y, z) {
    this.schedule(x, y, z);
    this.schedule(x + 1, y, z);
    this.schedule(x - 1, y, z);
    this.schedule(x, y + 1, z);
    this.schedule(x, y - 1, z);
    this.schedule(x, y, z + 1);
    this.schedule(x, y, z - 1);
  }

  // -------------------------------------------------------------------------
  // Ticking
  // -------------------------------------------------------------------------

  update(dt) {
    if (dt <= 0) return;
    this._timer += dt;
    // Cap catch-up so a long stall cannot run dozens of ticks in one frame.
    let guard = 0;
    while (this._timer >= this.tickInterval && guard++ < 4) {
      this._timer -= this.tickInterval;
      this._tick();
    }
    if (guard >= 4) this._timer = 0;
    this.stats.pending = this.pending.size;
  }

  _tick() {
    this._tickCount++;
    if (this.pending.size === 0) return;

    // Snapshot and clear: anything scheduled *during* this tick belongs to the
    // next generation, which keeps the automaton from cascading unboundedly
    // within a single tick.
    const cells = this.pending;
    this.pending = new Set();

    let processed = 0;
    for (const key of cells) {
      if (processed >= this.budget) {
        this.pending.add(key); // defer the remainder
        continue;
      }
      processed++;
      const parts = key.split(',');
      this._tickCell(+parts[0], +parts[1], +parts[2]);
    }

    this.stats.lastProcessed = processed;
    // One batched message to the worker for everything that changed this tick.
    this.world.flushBlockChanges();
  }

  _tickCell(x, y, z) {
    const world = this.world;
    const id = world.getBlock(x, y, z);
    const fluid = getFluid(id);
    if (!fluid) return;

    const family = FLUIDS[fluid.family];

    // Viscosity: lava only acts on every Nth tick.
    if (family.tickInterval > 1 && this._tickCount % family.tickInterval !== 0) {
      this.schedule(x, y, z); // try again next tick
      return;
    }

    let level = fluid.level;

    // --- Flows must justify their own existence every tick -----------------
    if (level > 0) {
      const supported = this._supportedLevel(x, y, z, fluid);

      if (supported > fluid.maxLevel) {
        // Nothing upstream any more: dry up. setBlock re-queues the neighbours,
        // so the recession propagates outward on its own.
        world.setBlock(x, y, z, AIR, true);
        return;
      }

      if (supported !== level) {
        world.setBlock(x, y, z, fluidId(fluid.family, supported), true);
        level = supported;
      }
    }

    this._spread(x, y, z, fluid.family, level, fluid.maxLevel);
  }

  /** The strongest level this flowing cell is entitled to. */
  _supportedLevel(x, y, z, fluid) {
    const above = getFluid(this.world.getBlock(x, y + 1, z));
    if (above && above.family === fluid.family) return 1;

    let best = Infinity;
    for (const [dx, dz] of HORIZONTAL) {
      const neighbor = getFluid(this.world.getBlock(x + dx, y, z + dz));
      if (neighbor && neighbor.family === fluid.family && neighbor.level < best) {
        best = neighbor.level;
      }
    }
    return best + 1; // Infinity + 1 stays Infinity -> the cell dries up
  }

  _spread(x, y, z, familyName, level, maxLevel) {
    const world = this.world;

    // --- 1. Gravity first --------------------------------------------------
    const belowId = world.getBlock(x, y - 1, z);
    if (this._canFlowInto(belowId)) {
      // Falling fluid stays at full strength, so waterfalls do not thin out.
      if (world.setBlock(x, y - 1, z, fluidId(familyName, 1), true)) return;
    } else if (this._isOpposingFluid(belowId, familyName)) {
      this._mix(x, y - 1, z);
      return;
    } else {
      const below = getFluid(belowId);
      // Reinforce a weaker flow directly beneath us before spreading sideways.
      if (below && below.family === familyName && below.level > 1) {
        world.setBlock(x, y - 1, z, fluidId(familyName, 1), true);
        return;
      }
      // Fluid resting on solid ground (or on a full column) spreads outward.
      if (below && below.family === familyName) return;
    }

    // --- 2. Then outward ---------------------------------------------------
    const nextLevel = level + 1;
    if (nextLevel > maxLevel) return;

    for (const [dx, dz] of HORIZONTAL) {
      const tx = x + dx;
      const tz = z + dz;
      const targetId = world.getBlock(tx, y, tz);

      if (this._canFlowInto(targetId)) {
        world.setBlock(tx, y, tz, fluidId(familyName, nextLevel), true);
        continue;
      }

      if (this._isOpposingFluid(targetId, familyName)) {
        this._mix(tx, y, tz);
        continue;
      }

      // Upgrade a neighbour that is weaker than it should be. Without this,
      // a pool fed from two sides would keep a stale high level in the middle.
      const target = getFluid(targetId);
      if (target && target.family === familyName && target.level > nextLevel) {
        world.setBlock(tx, y, tz, fluidId(familyName, nextLevel), true);
      }
    }
  }

  /** Fluid only displaces air — it never breaks blocks. */
  _canFlowInto(id) {
    return id === AIR;
  }

  _isOpposingFluid(id, familyName) {
    const f = getFluid(id);
    return !!f && f.family !== familyName;
  }

  /**
   * Water meeting lava.
   *
   * A lava *source* becomes obsidian; anything else becomes cobblestone. That
   * split is what makes obsidian gatherable at all — you have to find or make a
   * still pool and tip water into it, rather than getting it free wherever two
   * flows happen to touch. It is also the classic Minecraft rule.
   */
  _mix(x, y, z) {
    const fluid = getFluid(this.world.getBlock(x, y, z));
    const isLavaSource = fluid && fluid.family === 'lava' && fluid.level === 0;
    this.world.setBlock(x, y, z, isLavaSource ? OBSIDIAN.id : COBBLE.id, true);
  }

  /** Drop all queued work — used when the world is torn down. */
  clear() {
    this.pending.clear();
    this._timer = 0;
  }
}
