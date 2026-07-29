/**
 * mobTypes.js — Mob registry: models, stats and behaviour.
 *
 * ADDING A MOB
 * ------------
 * Append one object to `MOB_TYPES` with `buildModel()` and `ai()`. Spawning,
 * physics, animation, combat and despawning are all handled generically by
 * mob.js / entityManager.js — nothing else needs to know your mob exists.
 *
 * Model convention: the mob faces +Z when unrotated, and its origin is at the
 * centre of its feet.
 */

import * as THREE from 'three';
import { PORKCHOP, ROTTEN_FLESH, GRASS, DIRT, SAND, SNOW, STONE } from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Model building helpers
// ---------------------------------------------------------------------------

/** Fresh material per part — mobs tint their own materials when hurt. */
function material(color) {
  return new THREE.MeshLambertMaterial({ color });
}

/** A static box centred at (x, y, z). */
function box(w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * A limb that rotates about its top edge (the hip / shoulder).
 * Returns a Group placed at the pivot, with the box hanging below it — so
 * `group.rotation.x` swings the limb naturally.
 */
function limb(w, h, d, color, x, y, z) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  return pivot;
}

// ---------------------------------------------------------------------------
// Shared AI utilities
// ---------------------------------------------------------------------------

/** Head straight for a point. */
function steerToward(mob, x, z, speedScale = 1) {
  const dx = x - mob.position.x;
  const dz = z - mob.position.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return;
  mob.moveX = dx / len;
  mob.moveZ = dz / len;
  mob.moveSpeed = mob.type.speed * speedScale;
}

/** Run directly away from a point. */
function steerAway(mob, x, z, speedScale = 1) {
  steerToward(mob, x, z, speedScale);
  mob.moveX = -mob.moveX;
  mob.moveZ = -mob.moveZ;
}

/** Idle behaviour: pick a heading, hold it a few seconds, sometimes pause. */
function wander(mob, dt) {
  const m = mob.memory;
  m.wanderTimer = (m.wanderTimer ?? 0) - dt;

  if (m.wanderTimer <= 0) {
    m.wanderTimer = 3 + Math.random() * 5;
    if (Math.random() < 0.35) {
      m.wanderX = 0;
      m.wanderZ = 0; // stand and graze
    } else {
      const angle = Math.random() * Math.PI * 2;
      m.wanderX = Math.sin(angle);
      m.wanderZ = Math.cos(angle);
    }
  }

  mob.moveX = m.wanderX ?? 0;
  mob.moveZ = m.wanderZ ?? 0;

  // Hop over a one-block obstacle rather than grinding into it.
  if (mob.hitWall && mob.onGround) mob.wantsJump = true;
}

/** Stop passive mobs from strolling off cliffs. */
function avoidCliffs(mob) {
  if (!mob.onGround || (mob.moveX === 0 && mob.moveZ === 0)) return;

  const lookAhead = 0.9;
  const fx = mob.position.x + mob.moveX * lookAhead;
  const fz = mob.position.z + mob.moveZ * lookAhead;

  for (let drop = 1; drop <= 3; drop++) {
    if (mob.world.isSolid(fx, mob.position.y - drop, fz)) return; // ground found
  }

  mob.moveX = 0;
  mob.moveZ = 0;
  mob.memory.wanderTimer = 0; // pick a new heading next frame
}

// ---------------------------------------------------------------------------
// Mob definitions
// ---------------------------------------------------------------------------

export const ZOMBIE = {
  name: 'zombie',
  displayName: 'Zombie',
  width: 0.6,
  height: 1.85,
  maxHealth: 20,
  speed: 2.6,
  hostile: true,
  attackDamage: 3,
  attackRange: 1.7,
  armsForward: true,
  /** Zombies burn when the sun is up and they can see the sky. */
  burnsInSunlight: true,
  drops: [{ id: ROTTEN_FLESH.id, min: 0, max: 1 }],

  spawn: {
    atNight: true,
    dayTimeAllowed: false,
    maxCount: 14,
    groupSize: [1, 3],
    canSpawnOn: (id) => id === GRASS.id || id === DIRT.id || id === STONE.id || id === SAND.id || id === SNOW.id,
  },

  buildModel() {
    const group = new THREE.Group();
    const skin = 0x4f8f4a;
    const shirt = 0x2f6f6a;
    const pants = 0x2a3a6a;

    const legLeft = limb(0.22, 0.72, 0.22, pants, -0.13, 0.72, 0);
    const legRight = limb(0.22, 0.72, 0.22, pants, 0.13, 0.72, 0);
    const armLeft = limb(0.2, 0.7, 0.2, skin, -0.36, 1.3, 0);
    const armRight = limb(0.2, 0.7, 0.2, skin, 0.36, 1.3, 0);

    const body = box(0.52, 0.62, 0.26, shirt, 0, 1.03, 0);
    const head = box(0.5, 0.5, 0.5, skin, 0, 1.59, 0);
    // Eyes on the +Z face, since that is the mob's forward direction.
    const eyeLeft = box(0.1, 0.1, 0.02, 0x101a10, -0.12, 1.64, 0.26);
    const eyeRight = box(0.1, 0.1, 0.02, 0x101a10, 0.12, 1.64, 0.26);

    group.add(legLeft, legRight, armLeft, armRight, body, head, eyeLeft, eyeRight);

    return {
      group,
      parts: { legFrontLeft: legLeft, legFrontRight: legRight, armLeft, armRight, head },
    };
  },

  ai(mob, dt, ctx) {
    const { player, isDay } = ctx;

    // Daylight burning — the reason night is dangerous and day is safe.
    if (this.burnsInSunlight && isDay && !mob.inLiquid && mob.isExposedToSky()) {
      mob.burnTimer += dt;
      if (mob.burnTimer >= 1) {
        mob.burnTimer = 0;
        mob.takeDamage(1);
      }
    } else {
      mob.burnTimer = 0;
    }

    const distance = mob.horizontalDistanceTo(player.position);
    const verticalGap = player.position.y - mob.position.y;

    const canChase = !player.survival.dead && distance < 22 && Math.abs(verticalGap) < 12;
    if (!canChase) {
      wander(mob, dt);
      return;
    }

    // Ease off right at contact range so zombies do not jitter against you.
    steerToward(mob, player.position.x, player.position.z, distance < 1.6 ? 0.35 : 1);

    // Jump obstacles, and jump when the player is standing above.
    if (mob.onGround && (mob.hitWall || (verticalGap > 0.9 && distance < 2.5))) {
      mob.wantsJump = true;
    }

    if (distance < this.attackRange && Math.abs(verticalGap) < 2 && mob.attackCooldown <= 0) {
      mob.attackCooldown = 1.0;
      if (player.survival.damage(this.attackDamage, 'mob')) {
        // Knock the player back and up a little.
        const dx = player.position.x - mob.position.x;
        const dz = player.position.z - mob.position.z;
        const len = Math.hypot(dx, dz) || 1;
        player.velocity.x += (dx / len) * 5.5;
        player.velocity.z += (dz / len) * 5.5;
        if (player.onGround) player.velocity.y = 4.2;
      }
    }
  },
};

export const PIG = {
  name: 'pig',
  displayName: 'Pig',
  width: 0.8,
  height: 0.95,
  maxHealth: 10,
  speed: 1.7,
  hostile: false,
  armsForward: false,
  drops: [{ id: PORKCHOP.id, min: 1, max: 3 }],

  spawn: {
    atNight: false,
    dayTimeAllowed: true,
    maxCount: 10,
    groupSize: [2, 4],
    canSpawnOn: (id) => id === GRASS.id,
  },

  buildModel() {
    const group = new THREE.Group();
    const skin = 0xefaeae;
    const snoutColor = 0xd88f8f;

    const legFrontLeft = limb(0.18, 0.4, 0.18, skin, -0.19, 0.4, 0.28);
    const legFrontRight = limb(0.18, 0.4, 0.18, skin, 0.19, 0.4, 0.28);
    const legBackLeft = limb(0.18, 0.4, 0.18, skin, -0.19, 0.4, -0.3);
    const legBackRight = limb(0.18, 0.4, 0.18, skin, 0.19, 0.4, -0.3);

    const body = box(0.58, 0.52, 0.94, skin, 0, 0.66, 0);
    const head = box(0.45, 0.44, 0.4, skin, 0, 0.66, 0.63);
    const snout = box(0.24, 0.17, 0.09, snoutColor, 0, 0.6, 0.86);
    const nostrilLeft = box(0.05, 0.05, 0.02, 0x9a5f5f, -0.06, 0.6, 0.91);
    const nostrilRight = box(0.05, 0.05, 0.02, 0x9a5f5f, 0.06, 0.6, 0.91);
    const eyeLeft = box(0.07, 0.07, 0.02, 0x1a1010, -0.14, 0.75, 0.81);
    const eyeRight = box(0.07, 0.07, 0.02, 0x1a1010, 0.14, 0.75, 0.81);
    const earLeft = box(0.12, 0.1, 0.05, snoutColor, -0.13, 0.9, 0.55);
    const earRight = box(0.12, 0.1, 0.05, snoutColor, 0.13, 0.9, 0.55);

    group.add(
      legFrontLeft, legFrontRight, legBackLeft, legBackRight,
      body, head, snout, nostrilLeft, nostrilRight,
      eyeLeft, eyeRight, earLeft, earRight
    );

    return {
      group,
      parts: { legFrontLeft, legFrontRight, legBackLeft, legBackRight, head },
    };
  },

  ai(mob, dt, ctx) {
    const memory = mob.memory;

    if ((memory.panicTimer ?? 0) > 0) {
      memory.panicTimer -= dt;
      steerAway(mob, ctx.player.position.x, ctx.player.position.z, 1.9);
      if (mob.hitWall && mob.onGround) mob.wantsJump = true;
      return;
    }

    wander(mob, dt);
    avoidCliffs(mob);
  },

  onDamaged(mob) {
    mob.memory.panicTimer = 4; // bolt for a few seconds
  },
};

/** Every registered mob. Spawning iterates this list. */
export const MOB_TYPES = [ZOMBIE, PIG];
