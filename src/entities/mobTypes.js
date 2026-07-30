/**
 * mobTypes.js — Mob registry: models, stats, voices and behaviour config.
 *
 * ADDING A MOB
 * ------------
 * Append one object to `MOB_TYPES`. Behaviour is *declared*, not coded: the
 * generic state machine in mob.js reads `brain` and handles wandering, line of
 * sight, chasing, melee, ranged fire, leaping, fleeing and sunlight burning.
 * Only add an `ai()` hook if a species needs something genuinely unusual.
 *
 * Model convention: the mob faces +Z when unrotated, and its origin is at the
 * centre of its feet.
 */

import * as THREE from 'three';
import {
  ITEM_ID, WOOL, GRASS, DIRT, SAND, SNOW, STONE, DRY_GRASS, PODZOL, SWAMP_GRASS,
} from '../world/blocks.js';

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

/** Ground blocks most surface animals are happy to stand on. */
const GRASSY = new Set([GRASS.id, DRY_GRASS.id, SWAMP_GRASS.id, PODZOL.id]);
const ANY_GROUND = new Set([
  GRASS.id, DIRT.id, STONE.id, SAND.id, SNOW.id,
  DRY_GRASS.id, PODZOL.id, SWAMP_GRASS.id,
]);

// ---------------------------------------------------------------------------
// Hostiles
// ---------------------------------------------------------------------------

export const ZOMBIE = {
  name: 'zombie',
  displayName: 'Zombie',
  width: 0.6,
  height: 1.85,
  maxHealth: 20,
  speed: 2.6,
  armsForward: true,
  voice: { name: 'zombie', voice: 'groan', pitch: 120, duration: 0.5 },
  drops: [
    { id: ITEM_ID.ROTTEN_FLESH, min: 0, max: 2 },
  ],

  brain: {
    hostile: true,
    sightRange: 20,
    loseSightAfter: 6,
    attackRange: 1.7,
    attackDamage: 3,
    attackCooldown: 1.0,
    burnsInSunlight: true,
    // Zombies call each other in — a lone one becomes a small crowd.
    packCall: true,
    packRadius: 14,
  },

  spawn: {
    atNight: true,
    dayTimeAllowed: false,
    maxCount: 8,
    weight: 5,
    groupSize: [1, 2],
    canSpawnOn: (id) => ANY_GROUND.has(id),
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
    const eyeLeft = box(0.1, 0.1, 0.02, 0x101a10, -0.12, 1.64, 0.26);
    const eyeRight = box(0.1, 0.1, 0.02, 0x101a10, 0.12, 1.64, 0.26);

    group.add(legLeft, legRight, armLeft, armRight, body, head, eyeLeft, eyeRight);
    return {
      group,
      parts: { legFrontLeft: legLeft, legFrontRight: legRight, armLeft, armRight, head },
    };
  },
};

export const SKELETON = {
  name: 'skeleton',
  displayName: 'Skeleton',
  width: 0.6,
  height: 1.85,
  maxHealth: 20,
  speed: 2.9,
  armsForward: true,
  voice: { name: 'skeleton', voice: 'rattle', pitch: 200, duration: 0.3 },
  drops: [
    { id: ITEM_ID.BONE, min: 1, max: 2 },
    { id: ITEM_ID.ARROW, min: 0, max: 2 },
  ],

  brain: {
    hostile: true,
    sightRange: 18,
    loseSightAfter: 5,
    burnsInSunlight: true,
    // Keeps its distance and shoots rather than closing to melee.
    ranged: {
      range: 15,
      minRange: 4,
      cooldown: 2.0,
      damage: 3,
      speed: 26,
      spread: 0.05,
    },
  },

  spawn: {
    atNight: true,
    dayTimeAllowed: false,
    maxCount: 5,
    weight: 3,
    groupSize: [1, 2],
    canSpawnOn: (id) => ANY_GROUND.has(id),
  },

  buildModel() {
    const group = new THREE.Group();
    const bone = 0xcfcfc4;
    const shade = 0xa8a89e;

    const legLeft = limb(0.14, 0.74, 0.14, bone, -0.11, 0.74, 0);
    const legRight = limb(0.14, 0.74, 0.14, bone, 0.11, 0.74, 0);
    // Arms held out to aim the bow.
    const armLeft = limb(0.13, 0.7, 0.13, bone, -0.3, 1.32, 0);
    const armRight = limb(0.13, 0.7, 0.13, bone, 0.3, 1.32, 0);

    const ribs = box(0.4, 0.6, 0.2, shade, 0, 1.06, 0);
    const spine = box(0.12, 0.62, 0.12, bone, 0, 1.06, -0.06);
    const head = box(0.48, 0.48, 0.46, bone, 0, 1.6, 0);
    const eyeLeft = box(0.11, 0.11, 0.02, 0x14100e, -0.11, 1.64, 0.24);
    const eyeRight = box(0.11, 0.11, 0.02, 0x14100e, 0.11, 1.64, 0.24);
    // A suggestion of a bow in the right hand.
    const bow = box(0.05, 0.5, 0.05, 0x6b4a24, 0.3, 1.06, 0.16);

    group.add(legLeft, legRight, armLeft, armRight, ribs, spine, head, eyeLeft, eyeRight, bow);
    return {
      group,
      parts: { legFrontLeft: legLeft, legFrontRight: legRight, armLeft, armRight, head },
    };
  },
};

export const SPIDER = {
  name: 'spider',
  displayName: 'Spider',
  width: 1.0,
  height: 0.75,
  maxHealth: 16,
  speed: 3.6,
  voice: { name: 'spider', voice: 'hiss', pitch: 300, duration: 0.35 },
  drops: [
    { id: ITEM_ID.STRING, min: 0, max: 2 },
    { id: ITEM_ID.SPIDER_EYE, min: 0, max: 1 },
  ],

  brain: {
    hostile: true,
    sightRange: 16,
    loseSightAfter: 4,
    attackRange: 1.4,
    attackDamage: 2,
    attackCooldown: 0.9,
    // Spiders do not burn, but they lose interest in daylight — as in Minecraft,
    // a spider caught out at dawn becomes neutral rather than bursting into flame.
    dayTimid: true,
    chaseSpeed: 1.15,
    leaps: { range: 5, cooldown: 2.2, power: 7, lift: 5.5 },
  },

  spawn: {
    atNight: true,
    dayTimeAllowed: false,
    maxCount: 4,
    weight: 2,
    groupSize: [1, 2],
    canSpawnOn: (id) => ANY_GROUND.has(id),
  },

  buildModel() {
    const group = new THREE.Group();
    const body = 0x2a2320;
    const marking = 0x6b1f1f;

    const abdomen = box(0.62, 0.44, 0.62, body, 0, 0.44, -0.3);
    const thorax = box(0.44, 0.36, 0.36, body, 0, 0.44, 0.16);
    const head = box(0.4, 0.34, 0.34, body, 0, 0.44, 0.48);
    const stripe = box(0.4, 0.06, 0.4, marking, 0, 0.66, -0.3);

    // Eight legs: four per side, splayed outward.
    const legs = [];
    for (let i = 0; i < 4; i++) {
      const z = 0.28 - i * 0.22;
      for (const side of [-1, 1]) {
        const leg = limb(0.09, 0.42, 0.09, body, side * 0.34, 0.5, z);
        // Angle them out so the spider looks low and sprawling.
        leg.rotation.z = side * 0.55;
        legs.push(leg);
      }
    }

    const eyes = [];
    for (const [ex, ey] of [[-0.12, 0.52], [0.12, 0.52], [-0.06, 0.42], [0.06, 0.42]]) {
      eyes.push(box(0.06, 0.06, 0.02, 0xd03a3a, ex, ey, 0.65));
    }

    group.add(abdomen, thorax, head, stripe, ...legs, ...eyes);
    return {
      group,
      // Map two legs per side onto the generic walk cycle.
      parts: {
        legFrontLeft: legs[0], legFrontRight: legs[1],
        legBackLeft: legs[4], legBackRight: legs[5],
        head,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Passives
// ---------------------------------------------------------------------------

/** Shared config for grazing animals. */
const PASSIVE_BRAIN = {
  hostile: false,
  avoidCliffs: true,
  fleeWhenHurt: 4,
  fleeSpeed: 1.9,
};

export const PIG = {
  name: 'pig',
  displayName: 'Pig',
  width: 0.8,
  height: 0.95,
  maxHealth: 10,
  speed: 1.7,
  voice: { name: 'pig', voice: 'oink', pitch: 240, duration: 0.22 },
  drops: [{ id: ITEM_ID.PORKCHOP, min: 1, max: 3 }],
  brain: PASSIVE_BRAIN,

  spawn: {
    atNight: false,
    dayTimeAllowed: true,
    maxCount: 8,
    weight: 4,
    groupSize: [2, 4],
    canSpawnOn: (id) => GRASSY.has(id),
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
};

export const COW = {
  name: 'cow',
  displayName: 'Cow',
  width: 0.9,
  height: 1.35,
  maxHealth: 10,
  speed: 1.5,
  voice: { name: 'cow', voice: 'moo', pitch: 150, duration: 0.5 },
  drops: [
    { id: ITEM_ID.BEEF, min: 1, max: 3 },
    { id: ITEM_ID.LEATHER, min: 0, max: 2 },
  ],
  brain: PASSIVE_BRAIN,

  spawn: {
    atNight: false,
    dayTimeAllowed: true,
    maxCount: 8,
    weight: 4,
    groupSize: [2, 4],
    canSpawnOn: (id) => GRASSY.has(id),
  },

  buildModel() {
    const group = new THREE.Group();
    const hide = 0x4a3626;
    const patch = 0xe8e4dc;
    const horn = 0xd8d2c0;

    const legFrontLeft = limb(0.2, 0.6, 0.2, hide, -0.22, 0.6, 0.3);
    const legFrontRight = limb(0.2, 0.6, 0.2, hide, 0.22, 0.6, 0.3);
    const legBackLeft = limb(0.2, 0.6, 0.2, hide, -0.22, 0.6, -0.34);
    const legBackRight = limb(0.2, 0.6, 0.2, hide, 0.22, 0.6, -0.34);

    const body = box(0.66, 0.6, 1.08, hide, 0, 0.9, 0);
    const patchTop = box(0.5, 0.06, 0.6, patch, 0, 1.21, -0.1);
    const patchSide = box(0.02, 0.3, 0.4, patch, 0.34, 0.86, 0.16);
    const head = box(0.46, 0.46, 0.42, hide, 0, 1.06, 0.72);
    const muzzle = box(0.3, 0.2, 0.1, patch, 0, 0.96, 0.95);
    const eyeLeft = box(0.08, 0.08, 0.02, 0x120c08, -0.14, 1.14, 0.93);
    const eyeRight = box(0.08, 0.08, 0.02, 0x120c08, 0.14, 1.14, 0.93);
    const hornLeft = box(0.09, 0.09, 0.09, horn, -0.2, 1.3, 0.66);
    const hornRight = box(0.09, 0.09, 0.09, horn, 0.2, 1.3, 0.66);
    const udder = box(0.2, 0.12, 0.24, 0xd89898, 0, 0.58, -0.18);

    group.add(
      legFrontLeft, legFrontRight, legBackLeft, legBackRight,
      body, patchTop, patchSide, head, muzzle,
      eyeLeft, eyeRight, hornLeft, hornRight, udder
    );
    return {
      group,
      parts: { legFrontLeft, legFrontRight, legBackLeft, legBackRight, head },
    };
  },
};

export const SHEEP = {
  name: 'sheep',
  displayName: 'Sheep',
  width: 0.8,
  height: 1.2,
  maxHealth: 8,
  speed: 1.6,
  voice: { name: 'sheep', voice: 'baa', pitch: 340, duration: 0.35 },
  drops: [
    { id: ITEM_ID.MUTTON, min: 1, max: 2 },
    { id: WOOL.id, min: 1, max: 1 },
  ],
  brain: PASSIVE_BRAIN,

  spawn: {
    atNight: false,
    dayTimeAllowed: true,
    maxCount: 8,
    weight: 4,
    groupSize: [2, 4],
    canSpawnOn: (id) => GRASSY.has(id),
  },

  buildModel() {
    const group = new THREE.Group();
    const fleece = 0xece7e0;
    const skin = 0xd8c3b0;

    const legFrontLeft = limb(0.16, 0.5, 0.16, skin, -0.18, 0.5, 0.24);
    const legFrontRight = limb(0.16, 0.5, 0.16, skin, 0.18, 0.5, 0.24);
    const legBackLeft = limb(0.16, 0.5, 0.16, skin, -0.18, 0.5, -0.28);
    const legBackRight = limb(0.16, 0.5, 0.16, skin, 0.18, 0.5, -0.28);

    // Chunky fleece body, slightly oversized to look woolly.
    const body = box(0.68, 0.62, 0.98, fleece, 0, 0.82, 0);
    const head = box(0.38, 0.38, 0.36, skin, 0, 0.98, 0.62);
    const wooltuft = box(0.42, 0.2, 0.3, fleece, 0, 1.14, 0.5);
    const eyeLeft = box(0.07, 0.07, 0.02, 0x141010, -0.11, 1.02, 0.81);
    const eyeRight = box(0.07, 0.07, 0.02, 0x141010, 0.11, 1.02, 0.81);
    const earLeft = box(0.12, 0.07, 0.06, skin, -0.22, 1.02, 0.56);
    const earRight = box(0.12, 0.07, 0.06, skin, 0.22, 1.02, 0.56);

    group.add(
      legFrontLeft, legFrontRight, legBackLeft, legBackRight,
      body, head, wooltuft, eyeLeft, eyeRight, earLeft, earRight
    );
    return {
      group,
      parts: { legFrontLeft, legFrontRight, legBackLeft, legBackRight, head },
    };
  },
};

export const CHICKEN = {
  name: 'chicken',
  displayName: 'Chicken',
  width: 0.45,
  height: 0.7,
  maxHealth: 4,
  speed: 1.4,
  voice: { name: 'chicken', voice: 'cluck', pitch: 620, duration: 0.12 },
  drops: [
    { id: ITEM_ID.CHICKEN_RAW, min: 1, max: 1 },
    { id: ITEM_ID.FEATHER, min: 0, max: 2 },
  ],
  brain: PASSIVE_BRAIN,
  /** Chickens flap, so they fall slowly instead of taking fall damage. */
  slowFall: true,

  spawn: {
    atNight: false,
    dayTimeAllowed: true,
    maxCount: 8,
    weight: 3,
    groupSize: [2, 4],
    canSpawnOn: (id) => GRASSY.has(id),
  },

  buildModel() {
    const group = new THREE.Group();
    const feathers = 0xf2f0ea;
    const beak = 0xe8a23a;
    const comb = 0xc23b3b;

    const legLeft = limb(0.06, 0.22, 0.06, beak, -0.08, 0.22, 0.02);
    const legRight = limb(0.06, 0.22, 0.06, beak, 0.08, 0.22, 0.02);

    const body = box(0.3, 0.32, 0.4, feathers, 0, 0.38, 0);
    const wingLeft = box(0.04, 0.22, 0.3, feathers, -0.17, 0.4, 0);
    const wingRight = box(0.04, 0.22, 0.3, feathers, 0.17, 0.4, 0);
    const tail = box(0.2, 0.2, 0.08, feathers, 0, 0.5, -0.24);
    const head = box(0.22, 0.22, 0.2, feathers, 0, 0.6, 0.16);
    const beakMesh = box(0.1, 0.08, 0.12, beak, 0, 0.58, 0.32);
    const combMesh = box(0.06, 0.09, 0.14, comb, 0, 0.72, 0.14);
    const wattle = box(0.06, 0.08, 0.05, comb, 0, 0.52, 0.29);
    const eyeLeft = box(0.05, 0.05, 0.02, 0x140f0c, -0.07, 0.63, 0.27);
    const eyeRight = box(0.05, 0.05, 0.02, 0x140f0c, 0.07, 0.63, 0.27);

    group.add(
      legLeft, legRight, body, wingLeft, wingRight, tail,
      head, beakMesh, combMesh, wattle, eyeLeft, eyeRight
    );
    return {
      group,
      parts: { legFrontLeft: legLeft, legFrontRight: legRight, head },
    };
  },
};

/** Every registered mob. Spawning iterates this list. */
export const MOB_TYPES = [ZOMBIE, SKELETON, SPIDER, PIG, COW, SHEEP, CHICKEN];
