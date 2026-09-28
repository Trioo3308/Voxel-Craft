/**
 * particles.js — Pooled voxel particles.
 *
 * Every particle in the game comes from one `InstancedMesh`, so the whole
 * effect layer costs a single draw call no matter how much is happening. The
 * pool is fixed size and allocated once: spawning past capacity recycles the
 * oldest particle rather than growing, which keeps a big explosion from
 * stuttering the frame it happens on.
 *
 * Shards are tinted by sampling the block's own atlas tile, so a broken stone
 * block throws grey chips and grass throws green ones without this module
 * knowing anything about the block registry.
 */

import { prefs } from '../engine/preferences.js';
import * as THREE from 'three';
import { getTilePalette } from '../world/textures.js';
import { BLOCKS, FACE_PY, isLiquid } from '../world/blocks.js';

const GRAVITY = -18;
/** Air resistance per second. Keeps shards from skating forever after landing. */
const DRAG = 2.6;
/** Below this speed a grounded particle is considered settled. */
const REST_SPEED = 0.35;

const MAX_PARTICLES = 700;

/** Scratch objects, so the update loop never allocates. */
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

/** Share of particles kept at each Particles setting. */
const PARTICLE_DENSITY = { all: 1, fewer: 0.45, minimal: 0.15 };

/** Ground fireflies hover over. */
const GRASSY = new Set(['grass', 'swamp_grass', 'podzol', 'dry_grass']);

export class ParticleSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/world.js').World} world
   */
  constructor(scene, world, capacity = MAX_PARTICLES) {
    this.scene = scene;
    this.world = world;
    this.capacity = capacity;

    // A cube rather than a billboarded quad: it reads as a chip of the block
    // it came from, and it needs no per-frame orientation work.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial({ vertexColors: false });

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances move far beyond the mesh's own bounds, so let the GPU have them.
    this.mesh.frustumCulled = false;
    this.mesh.count = capacity;
    scene.add(this.mesh);

    // A second, unlit pool shares the same slots for things that give off
    // light: fireflies, embers, sparkles. Their colours go past white, so
    // bloom makes them glow. Each slot draws in exactly one of the two meshes.
    this.glowMesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), capacity);
    this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.count = capacity;
    scene.add(this.glowMesh);

    // Parallel arrays rather than objects: this is the hot loop.
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    /** 0 = collides with the world, 1 = passes through (rain, sparks). */
    this.ghost = new Uint8Array(capacity);
    /** 0 = falls, 1 = drifts upward (smoke, portal motes). */
    this.buoyant = new Uint8Array(capacity);
    /** 1 = ignores gravity entirely, so it falls at a constant rate (rain). */
    this.weightless = new Uint8Array(capacity);
    /**
     * Vertical scale multiplier. A raindrop rendered as a cube is a speck you
     * cannot see against the sky; stretched into a streak it reads as rain.
     */
    this.stretch = new Float32Array(capacity);
    /** 1 = drawn unlit in the glow pool. */
    this.glow = new Uint8Array(capacity);
    /**
     * How it moves beyond plain physics:
     *   0 ordinary   1 leaf (flutters down)   2 firefly (wanders, blinks)
     *   3 mote (drifts, twinkles)
     */
    this.kind = new Uint8Array(capacity);
    /** Per-particle phase, so a swarm does not move in lockstep. */
    this.phase = new Float32Array(capacity);

    this._next = 0;
    this._live = 0;

    // Everything starts hidden.
    for (let i = 0; i < capacity; i++) this._hide(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** How many particles are currently alive — handy for tests and the debug HUD. */
  get liveCount() {
    return this._live;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Claim a pool slot. Past capacity this recycles the oldest slot, which is
   * why the array is walked round-robin rather than searched for a free one.
   */
  _claim() {
    const index = this._next;
    this._next = (this._next + 1) % this.capacity;
    if (this.life[index] <= 0) this._live++;
    return index;
  }

  _hide(index) {
    _matrix.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(index, _matrix);
    this.glowMesh.setMatrixAt(index, _matrix);
  }

  /**
   * @param options {{x,y,z, vx,vy,vz, life, size, color, ghost?, buoyant?}}
   */
  spawn(options) {
    // The Particles option thins every effect evenly rather than dropping
    // whole kinds of them, so nothing goes missing, it just gets sparser.
    const density = PARTICLE_DENSITY[prefs.get('particles')] ?? 1;
    if (density < 1 && Math.random() > density) return -1;
    const i = this._claim();
    this.x[i] = options.x;
    this.y[i] = options.y;
    this.z[i] = options.z;
    this.vx[i] = options.vx;
    this.vy[i] = options.vy;
    this.vz[i] = options.vz;
    this.life[i] = options.life;
    this.maxLife[i] = options.life;
    this.size[i] = options.size;
    this.ghost[i] = options.ghost ? 1 : 0;
    this.buoyant[i] = options.buoyant ? 1 : 0;
    this.weightless[i] = options.weightless ? 1 : 0;
    this.stretch[i] = options.stretch ?? 1;
    this.glow[i] = options.glow ? 1 : 0;
    this.kind[i] = options.kind ?? 0;
    this.phase[i] = Math.random() * Math.PI * 2;

    // Hide the slot in both pools, then colour it in the one it draws in.
    this._hide(i);
    const target = options.glow ? this.glowMesh : this.mesh;
    _color.setHex(options.color);
    if (options.brightness) _color.multiplyScalar(options.brightness);
    target.setColorAt(i, _color);
    if (target.instanceColor) target.instanceColor.needsUpdate = true;
    return i;
  }

  /** Colours to chip off a block, taken from the face you would actually see. */
  _paletteFor(blockId) {
    const block = BLOCKS[blockId];
    if (!block) return [0x9a9a9a];
    return getTilePalette(block.tiles[FACE_PY]);
  }

  /** A block shattering: a burst of chips thrown out of its cell. */
  blockBreak(x, y, z, blockId, count = 14) {
    const palette = this._paletteFor(blockId);
    for (let n = 0; n < count; n++) {
      this.spawn({
        x: x + 0.15 + Math.random() * 0.7,
        y: y + 0.15 + Math.random() * 0.7,
        z: z + 0.15 + Math.random() * 0.7,
        vx: (Math.random() - 0.5) * 3.4,
        vy: Math.random() * 3.6 + 0.6,
        vz: (Math.random() - 0.5) * 3.4,
        life: 0.6 + Math.random() * 0.5,
        size: 0.06 + Math.random() * 0.06,
        color: palette[(Math.random() * palette.length) | 0],
      });
    }
  }

  /**
   * Chips knocked off the face being mined. Sprayed back along the face normal
   * so they come toward the player rather than out of the block's middle.
   */
  blockHit(x, y, z, blockId, normal, count = 3) {
    const palette = this._paletteFor(blockId);
    const nx = normal?.x ?? 0, ny = normal?.y ?? 1, nz = normal?.z ?? 0;
    for (let n = 0; n < count; n++) {
      this.spawn({
        x: x + 0.5 + nx * 0.55 + (Math.random() - 0.5) * 0.6 * (1 - Math.abs(nx)),
        y: y + 0.5 + ny * 0.55 + (Math.random() - 0.5) * 0.6 * (1 - Math.abs(ny)),
        z: z + 0.5 + nz * 0.55 + (Math.random() - 0.5) * 0.6 * (1 - Math.abs(nz)),
        vx: nx * 1.6 + (Math.random() - 0.5) * 1.2,
        vy: ny * 1.6 + Math.random() * 1.4,
        vz: nz * 1.6 + (Math.random() - 0.5) * 1.2,
        life: 0.35 + Math.random() * 0.3,
        size: 0.045 + Math.random() * 0.04,
        color: palette[(Math.random() * palette.length) | 0],
      });
    }
  }

  /** Dust kicked up on landing, or from feet while sprinting. */
  footDust(x, y, z, blockId, count = 6, spread = 0.5) {
    const palette = this._paletteFor(blockId);
    for (let n = 0; n < count; n++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * spread,
        y: y + 0.06,
        z: z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 1.8,
        vy: Math.random() * 1.5 + 0.3,
        vz: (Math.random() - 0.5) * 1.8,
        life: 0.35 + Math.random() * 0.3,
        size: 0.05 + Math.random() * 0.05,
        color: palette[(Math.random() * palette.length) | 0],
      });
    }
  }

  /** Water thrown up on entry, and the droplets that fall back. */
  splash(x, y, z, count = 12) {
    for (let n = 0; n < count; n++) {
      const blue = 0x4a80d0 + ((Math.random() * 0x202020) | 0);
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.7,
        y: y + 0.1,
        z: z + (Math.random() - 0.5) * 0.7,
        vx: (Math.random() - 0.5) * 2.6,
        vy: Math.random() * 3.2 + 1.0,
        vz: (Math.random() - 0.5) * 2.6,
        life: 0.4 + Math.random() * 0.4,
        size: 0.04 + Math.random() * 0.04,
        color: blue,
      });
    }
  }

  /** Red flecks when something takes a hit. */
  damage(x, y, z, count = 8) {
    for (let n = 0; n < count; n++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.5,
        y: y + (Math.random() - 0.5) * 0.6,
        z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 2.4,
        vy: Math.random() * 2.2 + 0.4,
        vz: (Math.random() - 0.5) * 2.4,
        life: 0.3 + Math.random() * 0.25,
        size: 0.05,
        color: 0xb01818 + ((Math.random() * 0x303030) | 0),
        ghost: true,
      });
    }
  }

  /** Sparks and smoke from an explosion. */
  explosion(x, y, z, count = 40) {
    for (let n = 0; n < count; n++) {
      const ember = Math.random() < 0.45;
      this.spawn({
        x: x + (Math.random() - 0.5) * 1.4,
        y: y + (Math.random() - 0.5) * 1.4,
        z: z + (Math.random() - 0.5) * 1.4,
        vx: (Math.random() - 0.5) * 7,
        vy: Math.random() * 5 + 1,
        vz: (Math.random() - 0.5) * 7,
        life: 0.6 + Math.random() * 0.8,
        size: 0.08 + Math.random() * 0.09,
        color: ember ? 0xffb03a + ((Math.random() * 0x303030) | 0) : 0x3a3a3a,
        buoyant: !ember,
      });
    }
  }

  /**
   * A spore, drifting. Slow, weightless and long-lived, so a handful spawned
   * per second fills the Comb's air without ever looking like a snowfall.
   */
  spore(x, y, z) {
    this.spawn({
      x, y, z,
      vx: (Math.random() - 0.5) * 0.35,
      vy: 0.08 + Math.random() * 0.14,
      vz: (Math.random() - 0.5) * 0.35,
      life: 6 + Math.random() * 5,
      size: 0.035 + Math.random() * 0.025,
      color: Math.random() < 0.25 ? 0xd8969c : 0xf4efe4,
      ghost: true,
      weightless: true,
    });
  }

  /** Soft green motes rising off an attuned sustingus while it heals you. */
  sustain(x, y, z, count = 4) {
    for (let n = 0; n < count; n++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.8,
        y: y + (Math.random() - 0.5) * 0.4,
        z: z + (Math.random() - 0.5) * 0.8,
        vx: (Math.random() - 0.5) * 0.4,
        vy: 0.7 + Math.random() * 0.5,
        vz: (Math.random() - 0.5) * 0.4,
        life: 0.8 + Math.random() * 0.5,
        size: 0.05,
        color: Math.random() < 0.5 ? 0x9ee08a : 0xe8f0b4,
        ghost: true,
        buoyant: true,
      });
    }
  }

  /**
   * A firework burst: a shell of sparks in one or two colours, plus the smoke
   * they leave behind.
   */
  firework(x, y, z, colors, count = 70) {
    for (let n = 0; n < count; n++) {
      // Points on a sphere, so the burst is a shell rather than a blob.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 5 + Math.random() * 4;
      this.spawn({
        x, y, z,
        vx: Math.sin(phi) * Math.cos(theta) * speed,
        vy: Math.cos(phi) * speed,
        vz: Math.sin(phi) * Math.sin(theta) * speed,
        life: 0.7 + Math.random() * 0.7,
        size: 0.07 + Math.random() * 0.05,
        color: colors[(Math.random() * colors.length) | 0],
        ghost: true,
      });
    }
    for (let n = 0; n < 10; n++) {
      this.spawn({
        x, y, z,
        vx: (Math.random() - 0.5) * 2,
        vy: Math.random() * 1.2,
        vz: (Math.random() - 0.5) * 2,
        life: 1.4 + Math.random(),
        size: 0.1,
        color: 0x555055,
        ghost: true,
        buoyant: true,
      });
    }
  }

  /** The trail behind a climbing rocket. */
  rocketTrail(x, y, z) {
    for (let n = 0; n < 3; n++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.2,
        y, z: z + (Math.random() - 0.5) * 0.2,
        vx: (Math.random() - 0.5) * 0.8,
        vy: -1 - Math.random(),
        vz: (Math.random() - 0.5) * 0.8,
        life: 0.3 + Math.random() * 0.3,
        size: 0.06,
        color: Math.random() < 0.5 ? 0xffc357 : 0x8a8a8a,
        ghost: true,
      });
    }
  }

  /** Motes drifting off a lit portal. */
  portalMotes(x, y, z, count = 2) {
    for (let n = 0; n < count; n++) {
      this.spawn({
        x: x + Math.random(),
        y: y + Math.random(),
        z: z + Math.random(),
        vx: (Math.random() - 0.5) * 0.5,
        vy: Math.random() * 0.7 + 0.15,
        vz: (Math.random() - 0.5) * 0.5,
        life: 1.0 + Math.random() * 0.9,
        size: 0.04 + Math.random() * 0.03,
        color: Math.random() < 0.5 ? 0xf4f0e8 : 0xc2323c,
        ghost: true,
        buoyant: true,
      });
    }
  }

  /**
   * One falling precipitation streak.
   *
   * Ghosted, because collision-testing every drop against every ledge would
   * cost more than the rest of the effect layer combined. Instead the drop is
   * given exactly enough life to reach `stopY` and no more — so it lands on a
   * roof rather than falling through it, at the price of one height lookup
   * instead of a per-step sweep.
   */
  precipitation(x, y, z, snow, stopY = -Infinity) {
    const vy = snow ? -1.8 - Math.random() : -9 - Math.random() * 3;
    const fall = Math.max(0.2, y - stopY);
    // Buoyancy is off for these, so the fall is linear and the arithmetic holds.
    const life = Math.min(snow ? 6 : 2.2, fall / -vy);

    this.spawn({
      x, y, z,
      vx: snow ? (Math.random() - 0.5) * 0.6 : (Math.random() - 0.5) * 0.3,
      vy,
      vz: snow ? (Math.random() - 0.5) * 0.6 : (Math.random() - 0.5) * 0.3,
      life,
      size: snow ? 0.075 : 0.045,
      // Rain is a streak; a snowflake is a flake.
      stretch: snow ? 1 : 9,
      color: snow ? 0xf2f6ff : 0xa8c0e4,
      ghost: true,
      /** Precipitation falls at a steady rate rather than accelerating. */
      weightless: true,
    });
  }

  // -------------------------------------------------------------------------
  // Life in the air
  // -------------------------------------------------------------------------

  /** A mob's last breath: a puff of smoke where it fell. */
  deathPuff(x, y, z, size = 1) {
    const n = Math.round(10 + size * 8);
    for (let k = 0; k < n; k++) {
      const grey = 0.72 + Math.random() * 0.25;
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.7 * size,
        y: y + Math.random() * 1.2 * size,
        z: z + (Math.random() - 0.5) * 0.7 * size,
        vx: (Math.random() - 0.5) * 1.4, vy: 0.6 + Math.random() * 1.1, vz: (Math.random() - 0.5) * 1.4,
        life: 0.6 + Math.random() * 0.5, size: 0.14 + Math.random() * 0.12,
        color: _color.setRGB(grey, grey, grey).getHex(), ghost: true, buoyant: true,
      });
    }
  }

  /** Bubbles rising from your mouth while you hold your breath. */
  bubble(x, y, z) {
    this.spawn({
      x: x + (Math.random() - 0.5) * 0.3, y, z: z + (Math.random() - 0.5) * 0.3,
      vx: (Math.random() - 0.5) * 0.3, vy: 1.4 + Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.3,
      life: 0.9 + Math.random() * 0.6, size: 0.05 + Math.random() * 0.05,
      color: 0xbfe6ff, ghost: true, weightless: true,
    });
  }

  /**
   * Ambient particles around the player, driven each frame.
   *
   * Picks a few random spots nearby and asks what is there, so it costs the
   * same whatever the scenery, and nothing is spawned where you cannot see it.
   *
   * @param ctx {dimension, isNight, player, underwater, rain}
   */
  ambient(dt, ctx) {
    this._ambientClock = (this._ambientClock ?? 0) - dt;
    if (this._ambientClock > 0) return;
    this._ambientClock = 0.1;

    const p = ctx.player.position;
    const px = p.x, py = p.y, pz = p.z;
    const rand = (r) => (Math.random() - 0.5) * 2 * r;

    if (ctx.underwater && Math.random() < 0.6) {
      this.bubble(px, py + 1.5, pz);
    }

    switch (ctx.dimension) {
      case 'overworld': {
        // Leaves drift down from any canopy nearby.
        for (let n = 0; n < 3; n++) {
          const x = Math.floor(px + rand(14));
          const z = Math.floor(pz + rand(14));
          for (let y = Math.floor(py) + 12; y > py - 4; y--) {
            const id = this.world.getBlock(x, y, z);
            if (id === 0) continue;
            const block = BLOCKS[id];
            if (block && block.decays && this.world.getBlock(x, y - 1, z) === 0) {
              const palette = this._paletteFor(id);
              this.spawn({
                x: x + Math.random(), y: y - 0.05, z: z + Math.random(),
                vx: 0, vy: -0.8, vz: 0, life: 5 + Math.random() * 3, size: 0.07,
                color: palette[Math.floor(Math.random() * palette.length)],
                kind: 1, ghost: false,
              });
            }
            break;
          }
        }
        // Fireflies over grass on clear nights.
        if (ctx.isNight && !ctx.rain) {
          for (let n = 0; n < 2; n++) {
            const x = Math.floor(px + rand(12));
            const z = Math.floor(pz + rand(12));
            const top = this.world.getSurfaceY(x, z);
            if (top < 0 || Math.abs(top - py) > 10) continue;
            const ground = this.world.getBlock(x, top, z);
            if (!GRASSY.has(BLOCKS[ground]?.name)) continue;
            this.spawn({
              x: x + Math.random(), y: top + 1.2 + Math.random() * 1.8, z: z + Math.random(),
              vx: 0, vy: 0, vz: 0, life: 4 + Math.random() * 4, size: 0.06,
              color: 0xd8ff6a, brightness: 2.6, glow: true, ghost: true, weightless: true, kind: 2,
            });
          }
        }
        break;
      }
      case 'nether': {
        // Ash sifting down, and now and then an ember rising off the lava.
        for (let n = 0; n < 3; n++) {
          const shade = 0.25 + Math.random() * 0.2;
          this.spawn({
            x: px + rand(16), y: py + 3 + Math.random() * 10, z: pz + rand(16),
            vx: rand(0.4), vy: -0.35 - Math.random() * 0.3, vz: rand(0.4),
            life: 6 + Math.random() * 4, size: 0.045,
            color: _color.setRGB(shade, shade * 0.95, shade * 0.9).getHex(),
            ghost: true, weightless: true, kind: 3,
          });
        }
        if (Math.random() < 0.45) {
          this.spawn({
            x: px + rand(14), y: py - 2 + Math.random() * 6, z: pz + rand(14),
            vx: rand(0.3), vy: 0.6 + Math.random() * 0.8, vz: rand(0.3),
            life: 3 + Math.random() * 2, size: 0.05,
            color: 0xff8a30, brightness: 3, glow: true, ghost: true, weightless: true, kind: 3,
          });
        }
        break;
      }
      case 'aether': {
        // Sparkles hanging in the bright air.
        for (let n = 0; n < 2; n++) {
          this.spawn({
            x: px + rand(14), y: py - 2 + Math.random() * 10, z: pz + rand(14),
            vx: rand(0.15), vy: 0.12 + Math.random() * 0.2, vz: rand(0.15),
            life: 4 + Math.random() * 3, size: 0.05,
            color: 0xfff4c2, brightness: 2.4, glow: true, ghost: true, weightless: true, kind: 3,
          });
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  update(dt) {
    if (this._live === 0) return;
    // A long stall (tab in the background) should not teleport particles
    // through the floor.
    const step = Math.min(dt, 0.05);

    let live = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;

      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._hide(i);
        continue;
      }
      live++;

      const kind = this.kind[i];
      if (kind === 1) {
        // A leaf: falls slowly, rocking side to side.
        this.phase[i] += step * 2.6;
        this.vx[i] = Math.sin(this.phase[i]) * 0.9;
        this.vy[i] = -0.9 + Math.cos(this.phase[i] * 2) * 0.25;
      } else if (kind === 2) {
        // A firefly: wanders on a slow loop, drifting a little up and down.
        this.phase[i] += step * 1.3;
        this.vx[i] = Math.cos(this.phase[i]) * 0.5;
        this.vz[i] = Math.sin(this.phase[i] * 0.83) * 0.5;
        this.vy[i] = Math.sin(this.phase[i] * 1.7) * 0.25;
      } else if (kind === 3) {
        this.phase[i] += step;
      } else if (!this.weightless[i]) {
        const gravity = this.buoyant[i] ? -GRAVITY * 0.18 : GRAVITY;
        this.vy[i] += gravity * step;

        const drag = 1 - Math.min(1, DRAG * step);
        this.vx[i] *= drag;
        this.vz[i] *= drag;
      }

      if (this.ghost[i]) {
        this.x[i] += this.vx[i] * step;
        this.y[i] += this.vy[i] * step;
        this.z[i] += this.vz[i] * step;
      } else {
        this._moveWithCollision(i, step);
      }

      // Shrink away over the last third of life, so nothing pops out of view,
      // and grow in over the first tenth, so ambient motes fade up rather than
      // appear.
      const t = this.life[i] / this.maxLife[i];
      let scale = this.size[i] * (t > 0.34 ? 1 : t / 0.34);
      if (kind >= 2) {
        scale *= Math.min(1, (1 - t) * 10);
        // Fireflies blink; motes twinkle more gently.
        const pulse = Math.sin(this.phase[i] * (kind === 2 ? 3.1 : 5.3));
        scale *= kind === 2 ? Math.max(0, pulse) : 0.6 + 0.4 * pulse;
      }

      _position.set(this.x[i], this.y[i], this.z[i]);
      _scale.set(scale, scale * this.stretch[i], scale);
      _matrix.compose(_position, _quaternion, _scale);
      (this.glow[i] ? this.glowMesh : this.mesh).setMatrixAt(i, _matrix);
    }

    this._live = live;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glowMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Axis-by-axis sweep against solid blocks, the same order the player uses.
   * Particles are treated as points — they are small enough that a full AABB
   * sweep would cost more than it is worth.
   */
  _moveWithCollision(i, step) {
    const nx = this.x[i] + this.vx[i] * step;
    if (this._solidAt(nx, this.y[i], this.z[i])) this.vx[i] = 0;
    else this.x[i] = nx;

    const ny = this.y[i] + this.vy[i] * step;
    if (this._solidAt(this.x[i], ny, this.z[i])) {
      // Landing kills sideways drift quickly so chips settle instead of sliding.
      if (this.vy[i] < 0) {
        this.vx[i] *= 0.4;
        this.vz[i] *= 0.4;
        if (Math.abs(this.vy[i]) < REST_SPEED) this.vy[i] = 0;
        else this.vy[i] *= -0.24; // small bounce
      } else {
        this.vy[i] = 0;
      }
    } else {
      this.y[i] = ny;
    }

    const nz = this.z[i] + this.vz[i] * step;
    if (this._solidAt(this.x[i], this.y[i], nz)) this.vz[i] = 0;
    else this.z[i] = nz;
  }

  _solidAt(x, y, z) {
    const id = this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = BLOCKS[id];
    // Liquids do not stop a particle; you want splashes to sink.
    return !!block && block.solid && !isLiquid(id);
  }

  /** Drop everything — used when a world unloads or a dimension changes. */
  clear() {
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0;
      this._hide(i);
    }
    this._live = 0;
    this._next = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glowMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
