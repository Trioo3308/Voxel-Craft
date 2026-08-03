/**
 * entityManager.js — Spawning, updating and culling every non-player entity.
 *
 * Handles mobs and dropped items together because they share a lifecycle:
 * spawn near the player, simulate while close, remove when far away or dead.
 */

import * as THREE from 'three';
import Settings from '../settings.js';
import { Mob } from './mob.js';
import { MOB_TYPES, MOB_POOLS } from './mobTypes.js';
import { ItemEntity } from './itemEntity.js';
import { rollLoot } from './loot.js';
import { dimensionInfo } from '../world/dimensions.js';
import { Arrow } from './projectile.js';
import { Rocket } from './rocket.js';
import { AIR, BLOCKS, getBlock, getMaxStack } from '../world/blocks.js';
import { audio } from '../engine/audio.js';

const M = Settings.mobs;

/**
 * Cave spawning.
 *
 * `DEPTH` is how far below the surface counts as underground — enough that a
 * shallow overhang or the inside of a house is still "outside", so building a
 * roof does not turn your living room into a spawner.
 *
 * `SPREAD` is how far up and down from the player a spawn floor may be found.
 * Wide enough to reach the next level of a cave, tight enough that a mob never
 * appears in a chamber you have no route to.
 *
 * `LIGHT_RADIUS` / `LIGHT_BLOCKS` decide what counts as "lit". Block light is
 * computed in the worker and never comes back, so the main thread cannot ask
 * for a light level; it looks for a light *source* within range instead.
 *
 * `LIGHT_BLOCKS` sits deliberately above the ambient decoration. Glow lichen
 * emits 7 and grows all over the caves — set the bar at 7 and the entire cave
 * system counts as lit, which is exactly what happened the first time and left
 * the caves completely empty. Only a deliberate light — a torch (14), either
 * lantern (15), or lava (15) — should hold a space clear.
 */
const CAVE_SPAWN_DEPTH = 6;
const CAVE_SPAWN_SPREAD = 12;
const CAVE_LIGHT_RADIUS = 6;
const CAVE_LIGHT_BLOCKS = 12;

/** How close two dropped stacks must be to combine. */
const ITEM_MERGE_RADIUS = 0.9;
/** Seconds between merge sweeps — this is O(n^2), so it does not run per frame. */
const ITEM_MERGE_INTERVAL = 0.25;

/** Breeding: how close fed partners must be, and how long before they can again. */
const BREED_RADIUS = 4;
const BREED_COOLDOWN = 90;
const BREED_CHECK_INTERVAL = 0.4;
const DEFAULT_GROW_SECONDS = 150;

export class EntityManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/world.js').World} world
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;

    /** @type {Mob[]} */
    this.mobs = [];
    /** @type {ItemEntity[]} */
    this.items = [];
    /** @type {Arrow[]} */
    this.projectiles = [];

    this._spawnTimer = 0;
    this._mergeTimer = 0;
    this._breedTimer = 0;
    this._tmpVec = new THREE.Vector3();

    /**
     * Effects layer, attached once a world exists. Optional throughout, so the
     * entity code never has to care whether particles are switched on.
     * @type {import('./particles.js').ParticleSystem|null}
     */
    this.particles = null;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {{player: object, isDay: boolean, isNight: boolean}} ctx
   */
  update(dt, ctx) {
    // Give the AI a handle on the manager so it can shout to pack-mates and
    // spawn projectiles.
    const context = { ...ctx, entities: this };

    this._updateMobs(dt, context);
    this._separateEntities(context.player);
    this._updateProjectiles(dt, context);
    this._updateItems(dt, context);
    this._updateBreeding(dt);

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = M.spawnInterval;
      this._trySpawnWave(context);
      this._despawnDistant(context.player);
    }
  }

  /**
   * Push overlapping entities apart.
   *
   * Without this, mobs chasing the same target converge on one point and end up
   * standing inside each other. Positions are nudged directly (so the fix is
   * immediate) and a little velocity is added (so they keep drifting apart
   * rather than re-overlapping next frame).
   *
   * O(n^2), but n is capped in the tens by the spawn limits.
   */
  _separateEntities(player) {
    const mobs = this.mobs;

    for (let i = 0; i < mobs.length; i++) {
      const a = mobs[i];
      if (a.dead) continue;

      for (let j = i + 1; j < mobs.length; j++) {
        const b = mobs[j];
        if (b.dead) continue;

        // Ignore pairs on clearly different levels — one standing on the other's
        // head is a legitimate stack, not an overlap to resolve.
        const verticalGap = Math.abs(a.position.y - b.position.y);
        if (verticalGap > Math.max(a.height, b.height) * 0.8) continue;

        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const distance = Math.hypot(dx, dz);
        const minDistance = (a.width + b.width) * 0.5;
        if (distance >= minDistance) continue;

        // Exactly coincident: pick an arbitrary direction so they still split.
        let nx, nz;
        if (distance < 1e-4) {
          const angle = Math.random() * Math.PI * 2;
          nx = Math.cos(angle);
          nz = Math.sin(angle);
        } else {
          nx = dx / distance;
          nz = dz / distance;
        }

        const overlap = (minDistance - distance) * 0.5;
        a.position.x -= nx * overlap;
        a.position.z -= nz * overlap;
        b.position.x += nx * overlap;
        b.position.z += nz * overlap;

        const push = Math.min(2.5, overlap * 12);
        a.velocity.x -= nx * push;
        a.velocity.z -= nz * push;
        b.velocity.x += nx * push;
        b.velocity.z += nz * push;
      }

      // --- Against the player ---------------------------------------------
      // The player is a solid body too, so mobs cannot stand inside you.
      const verticalGap = Math.abs(a.position.y - player.position.y);
      if (verticalGap > Math.max(a.height, player.height) * 0.8) continue;

      const dx = player.position.x - a.position.x;
      const dz = player.position.z - a.position.z;
      const distance = Math.hypot(dx, dz);
      const minDistance = (a.width + 0.6) * 0.5;
      if (distance >= minDistance) continue;

      // Exactly coincident (a mob spawned or teleported onto the player): pick
      // an arbitrary direction, otherwise they would stay merged forever.
      let nx, nz;
      if (distance < 1e-4) {
        const angle = Math.random() * Math.PI * 2;
        nx = Math.cos(angle);
        nz = Math.sin(angle);
      } else {
        nx = dx / distance;
        nz = dz / distance;
      }
      const overlap = minDistance - distance;

      // The mob yields most of the ground; the player only gets nudged, via
      // velocity so normal collision keeps them out of walls.
      a.position.x -= nx * overlap * 0.8;
      a.position.z -= nz * overlap * 0.8;
      player.velocity.x += nx * Math.min(2.0, overlap * 8);
      player.velocity.z += nz * Math.min(2.0, overlap * 8);
    }
  }

  _updateProjectiles(dt, ctx) {
    // Rockets share this list: both are things that fly, tick and remove
    // themselves, and the loop needs nothing else from them.
    const context = { ...ctx, particles: this.particles };
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      projectile.update(dt, context);
      if (!projectile.removed) continue;

      this.scene.remove(projectile.mesh);
      projectile.dispose();
      this.projectiles.splice(i, 1);
    }
  }

  /** Launch a firework rocket. */
  launchRocket(position, direction) {
    const rocket = new Rocket(this.world, position, direction);
    this.projectiles.push(rocket);
    this.scene.add(rocket.mesh);
    return rocket;
  }

  /** Fire a projectile from `mob` toward `target`, leading the shot slightly. */
  fireProjectile(mob, target, config) {
    const from = new THREE.Vector3(
      mob.position.x,
      mob.position.y + mob.height * 0.8,
      mob.position.z
    );

    // Aim at the target's chest, plus a lob so gravity is compensated for.
    const to = new THREE.Vector3(
      target.position.x,
      target.position.y + target.height * 0.6,
      target.position.z
    );
    const delta = to.clone().sub(from);
    const horizontal = Math.hypot(delta.x, delta.z);
    const travelTime = horizontal / config.speed;
    delta.y += 0.5 * 12 * travelTime * travelTime; // counter gravity over the flight

    const velocity = delta.normalize().multiplyScalar(config.speed);
    // A little scatter so skeletons are not perfect marksmen.
    velocity.x += (Math.random() - 0.5) * config.speed * config.spread;
    velocity.y += (Math.random() - 0.5) * config.speed * config.spread;
    velocity.z += (Math.random() - 0.5) * config.speed * config.spread;

    const arrow = new Arrow(this.world, from, velocity, mob, config.damage);
    this.projectiles.push(arrow);
    this.scene.add(arrow.mesh);
    return arrow;
  }

  /** Launch an arrow with an explicit velocity (used by the player's bow). */
  spawnArrow(position, velocity, owner, damage) {
    const arrow = new Arrow(
      this.world,
      this._tmpVec.set(position.x, position.y, position.z),
      new THREE.Vector3(velocity.x, velocity.y, velocity.z),
      owner,
      damage
    );
    this.projectiles.push(arrow);
    this.scene.add(arrow.mesh);
    return arrow;
  }

  /**
   * Blow a spherical crater and hurt everything nearby.
   *
   * Block removal is batched through `setBlocks` so the whole crater costs one
   * remesh per affected chunk rather than one per block — a radius-3 explosion
   * touches over a hundred voxels.
   */
  explode(x, y, z, radius, ctx) {
    const world = this.world;
    const rSq = radius * radius;

    if (this.particles) this.particles.explosion(x, y, z);

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > rSq) continue;
          // Ragged edge rather than a perfect sphere.
          if (distSq > rSq * 0.45 && Math.random() < 0.35) continue;

          const bx = Math.floor(x) + dx;
          const by = Math.floor(y) + dy;
          const bz = Math.floor(z) + dz;

          const block = world.getBlock(bx, by, bz);
          if (block === AIR) continue;
          // Bedrock and other unbreakable blocks survive.
          const def = BLOCKS[block];
          if (!def || def.hardness === Infinity) continue;

          world.setBlock(bx, by, bz, AIR, true);
        }
      }
    }
    world.flushBlockChanges();

    // --- Damage with falloff ------------------------------------------------
    const centre = { x, y, z };
    const maxDamage = radius * 6;

    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const d = mob.distanceTo(centre);
      if (d > radius * 1.6) continue;
      const falloff = 1 - d / (radius * 1.6);
      mob.takeDamage(Math.ceil(maxDamage * falloff), {
        x: (mob.position.x - x) / (d || 1),
        y: 0.6,
        z: (mob.position.z - z) / (d || 1),
      });
    }

    const player = ctx && ctx.player;
    if (player && !player.survival.dead) {
      const d = player.eyePosition.distanceTo(new THREE.Vector3(x, y, z));
      if (d <= radius * 1.6) {
        const falloff = 1 - d / (radius * 1.6);
        player.survival.damage(Math.ceil(maxDamage * falloff), 'explosion');
        const dx = player.position.x - x;
        const dz = player.position.z - z;
        const len = Math.hypot(dx, dz) || 1;
        player.velocity.x += (dx / len) * 9 * falloff;
        player.velocity.z += (dz / len) * 9 * falloff;
        player.velocity.y = Math.max(player.velocity.y, 7 * falloff);
      }
      audio.explosion(d);
    }
  }

  /** A mob that spotted the player tells its neighbours of the same species. */
  alertNearby(source, radius) {
    const radiusSq = radius * radius;
    for (const mob of this.mobs) {
      if (mob === source || mob.dead || mob.type !== source.type) continue;
      const dx = mob.position.x - source.position.x;
      const dz = mob.position.z - source.position.z;
      if (dx * dx + dz * dz > radiusSq) continue;
      mob.alert(source.target);
    }
  }

  _updateMobs(dt, ctx) {
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      const hurtBefore = mob.hurtTimer;
      mob.update(dt, ctx);

      // Watching the i-frame timer catches damage from every source — melee,
      // arrows, sunlight, fall — without each of them needing its own hook.
      if (this.particles && mob.hurtTimer > hurtBefore) {
        this.particles.damage(mob.position.x, mob.position.y + mob.type.height * 0.6, mob.position.z);
      }

      if (mob.removed) {
        this._dropLoot(mob);
        this.scene.remove(mob.object3D);
        mob.dispose();
        this.mobs.splice(i, 1);
      }
    }
  }

  _updateItems(dt, ctx) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.update(dt, ctx);

      if (item.removed) {
        this.scene.remove(item.mesh);
        item.dispose();
        this.items.splice(i, 1);
      }
    }

    this._mergeItems(dt);
  }

  /**
   * Pair up animals that have both been fed and are standing close enough.
   *
   * Run on the same sweep timer as item merging rather than per frame — this is
   * O(n^2) over the mob list, and a pairing being a fraction of a second late is
   * imperceptible.
   */
  _updateBreeding(dt) {
    this._breedTimer -= dt;
    if (this._breedTimer > 0) return;
    this._breedTimer = BREED_CHECK_INTERVAL;

    for (let i = 0; i < this.mobs.length; i++) {
      const a = this.mobs[i];
      if (a.dead || a.loveTimer <= 0 || a.isBaby) continue;

      for (let j = i + 1; j < this.mobs.length; j++) {
        const b = this.mobs[j];
        if (b.dead || b.loveTimer <= 0 || b.isBaby) continue;
        if (b.type !== a.type) continue;
        if (a.horizontalDistanceTo(b.position) > BREED_RADIUS) continue;

        // Both partners spend their willingness and go on cooldown, so a fed
        // crowd produces one baby per pair rather than a baby per animal.
        a.loveTimer = 0; b.loveTimer = 0;
        a.breedCooldown = BREED_COOLDOWN; b.breedCooldown = BREED_COOLDOWN;

        const baby = this.spawnMob(
          a.type,
          (a.position.x + b.position.x) / 2,
          Math.max(a.position.y, b.position.y),
          (a.position.z + b.position.z) / 2
        );
        baby.makeBaby(a.type.growSeconds ?? DEFAULT_GROW_SECONDS);
        if (this.particles) {
          this.particles.portalMotes(baby.position.x, baby.position.y + 0.5, baby.position.z, 8);
        }
        audio.mobSound(a.type.voice, 'idle', 0);
        break;
      }
    }
  }

  /**
   * Coalesce touching stacks of the same thing.
   *
   * Digging a seam or breaking a full chest used to leave a drift of one-count
   * entities, each with its own mesh and physics. Merging keeps the count down
   * and, incidentally, makes a pile look like a pile.
   *
   * Only tools carry durability, and merging those would silently repair or
   * damage one of them, so anything with wear is left alone.
   */
  _mergeItems(dt) {
    this._mergeTimer -= dt;
    if (this._mergeTimer > 0) return;
    this._mergeTimer = ITEM_MERGE_INTERVAL;
    if (this.items.length < 2) return;

    const radiusSq = ITEM_MERGE_RADIUS * ITEM_MERGE_RADIUS;

    for (let i = this.items.length - 1; i > 0; i--) {
      const a = this.items[i];
      if (a.removed || a.durability !== undefined) continue;

      for (let j = i - 1; j >= 0; j--) {
        const b = this.items[j];
        if (b.removed || b.id !== a.id || b.durability !== undefined) continue;

        const dx = a.position.x - b.position.x;
        const dy = a.position.y - b.position.y;
        const dz = a.position.z - b.position.z;
        if (dx * dx + dy * dy + dz * dz > radiusSq) continue;

        const max = getMaxStack(a.id);
        const moved = Math.min(max - b.count, a.count);
        if (moved <= 0) continue;

        b.count += moved;
        a.count -= moved;
        // The survivor takes a nudge so a merging pile visibly settles. The
        // mesh is keyed on the item id, not the count, so nothing else changes.
        b.velocity.y = Math.max(b.velocity.y, 1.2);

        if (a.count <= 0) {
          a.removed = true;
          this.scene.remove(a.mesh);
          a.dispose();
          this.items.splice(i, 1);
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Attempt one spawn per wave, choosing the species by weight.
   *
   * Only one type per wave (rather than looping every type) is what actually
   * keeps night-time populations down — previously every eligible hostile got a
   * chance every few seconds, which stacked up fast.
   */
  _trySpawnWave(ctx) {
    const { player, isNight } = ctx;
    if (player.survival.dead) return;

    // Each dimension draws from its own list, so overworld animals never wander
    // the Comb and mites never turn up in a field.
    const pool = MOB_POOLS[ctx.dimension] ?? MOB_TYPES;

    // Global cap, and a local one so mobs do not pile up around the player.
    if (this.mobs.length >= M.maxTotalMobs) return;
    if (this._countWithin(player.position, 24) >= M.maxNearbyMobs) return;

    // Where the player is decides which rules apply: a cave is dark and roofed
    // whatever the sky is doing, so the time of day stops mattering down there.
    const playerSurface = this.world.getSurfaceY(
      Math.floor(player.position.x), Math.floor(player.position.z)
    );
    const underground = playerSurface > 0 &&
      player.position.y < playerSurface - CAVE_SPAWN_DEPTH;

    const candidates = [];
    for (const type of pool) {
      const rules = type.spawn;
      // Some things only exist underground, and some only above it.
      if (rules.cavesOnly && !underground) continue;

      // Time-of-day gate: hostiles at night, passives during the day — unless
      // we are underground and this is something that does not care.
      const allowed = underground && rules.cavesAnyTime
        ? true
        : (isNight ? rules.atNight : rules.dayTimeAllowed);
      if (!allowed) continue;

      const current = this.mobs.reduce((n, m) => n + (m.type === type && !m.dead ? 1 : 0), 0);
      if (current >= rules.maxCount) continue;
      candidates.push({ type, weight: rules.weight ?? 1 });
    }
    if (candidates.length === 0) return;

    const type = pickWeighted(candidates);
    {
      const rules = type.spawn;
      const current = this.mobs.reduce((n, m) => n + (m.type === type && !m.dead ? 1 : 0), 0);

      const spot = this._findSpawnSpot(player, type);
      if (!spot) return;

      // Spawn a small group so the world does not feel evenly sprinkled.
      const [minGroup, maxGroup] = rules.groupSize;
      const groupSize = minGroup + Math.floor(Math.random() * (maxGroup - minGroup + 1));
      const room = rules.maxCount - current;
      const nearY = player.position.y;

      for (let i = 0; i < Math.min(groupSize, room); i++) {
        // Scatter group members a few blocks apart around the anchor point.
        const offsetX = i === 0 ? 0 : (Math.random() - 0.5) * 5;
        const offsetZ = i === 0 ? 0 : (Math.random() - 0.5) * 5;
        const x = Math.floor(spot.x + offsetX);
        const z = Math.floor(spot.z + offsetZ);
        const floorY = this._findFloorAt(x, z, type, nearY);
        if (floorY < 0) continue;

        // Underground, hostiles need the dark. Passive animals do not care, and
        // gating them too would leave lit caves entirely lifeless.
        const underground = floorY < this.world.getSurfaceY(x, z) - CAVE_SPAWN_DEPTH;
        if (underground && rules.needsDark && !this._isDarkEnough(x, floorY + 1, z)) continue;

        this.spawnMob(type, x + 0.5, floorY + 1, z + 0.5);
      }
    }
  }

  /**
   * Look for a valid anchor point in the spawn ring around the player.
   *
   * The ring is horizontal, so underground the search is over a cylinder around
   * you rather than a patch of ground — which is what lets a cave system supply
   * its own mobs.
   */
  _findSpawnSpot(player, type) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = M.minSpawnDistance + Math.random() * (M.maxSpawnDistance - M.minSpawnDistance);
      const x = Math.floor(player.position.x + Math.cos(angle) * distance);
      const z = Math.floor(player.position.z + Math.sin(angle) * distance);
      if (this._canStandAt(x, z, type, player.position.y)) return { x, z };
    }
    return null;
  }

  /**
   * Find a floor in this column that `type` could stand on, or -1.
   *
   * This used to be surface-only — it asked `getSurfaceY` and nothing else —
   * which is the entire reason nothing ever spawned in a cave. A player forty
   * blocks down would have mobs appearing in the daylight above their head,
   * counting against the nearby cap, and never coming anywhere near them.
   *
   * `nearY` biases the search toward the player's own elevation, so a wave
   * spawned while you are underground lands in the cave you are in rather than
   * on the roof of the world.
   */
  _findFloorAt(x, z, type, nearY = null) {
    if (!this.world.isChunkLoaded(x, z)) return -1;

    const surfaceY = this.world.getSurfaceY(x, z);
    if (surfaceY < 1) return -1;

    const fits = (floorY) => {
      const ground = this.world.getBlock(x, floorY, z);
      if (!type.spawn.canSpawnOn(ground)) return false;
      const needed = Math.ceil(type.height);
      for (let dy = 1; dy <= needed; dy++) {
        if (this.world.getBlock(x, floorY + dy, z) !== AIR) return false;
      }
      return true;
    };

    // Above ground, or no elevation preference: the surface is the answer.
    if (nearY === null || nearY > surfaceY - CAVE_SPAWN_DEPTH) {
      return fits(surfaceY) ? surfaceY : -1;
    }

    // Underground: walk outward from the player's own level looking for a
    // ledge. Outward rather than top-down so a mob turns up on the level you
    // are exploring instead of at the roof of the tallest chamber in the column.
    const start = Math.round(nearY);
    for (let radius = 0; radius <= CAVE_SPAWN_SPREAD; radius++) {
      for (const y of radius === 0 ? [start] : [start + radius, start - radius]) {
        if (y < 1 || y >= surfaceY) continue;
        if (fits(y)) return y;
      }
    }
    return -1;
  }

  /** Is there anywhere in this column `type` could stand? */
  _canStandAt(x, z, type, nearY = null) {
    return this._findFloorAt(x, z, type, nearY) >= 0;
  }

  /**
   * Is this spot dark enough for something hostile to appear in?
   *
   * Block light lives in the worker, so the main thread cannot ask for a light
   * level. Instead this looks for a light *source* nearby — which is the thing
   * a player actually controls. Torch a cave and it stops spawning; that is the
   * rule players already expect, arrived at from the other direction.
   */
  _isDarkEnough(x, y, z) {
    for (let dy = -CAVE_LIGHT_RADIUS; dy <= CAVE_LIGHT_RADIUS; dy++) {
      for (let dz = -CAVE_LIGHT_RADIUS; dz <= CAVE_LIGHT_RADIUS; dz++) {
        for (let dx = -CAVE_LIGHT_RADIUS; dx <= CAVE_LIGHT_RADIUS; dx++) {
          // Cheap sphere test, so a corner of the cube is not "nearby".
          if (dx * dx + dy * dy + dz * dz > CAVE_LIGHT_RADIUS * CAVE_LIGHT_RADIUS) continue;
          const block = getBlock(this.world.getBlock(x + dx, y + dy, z + dz));
          if (block && block.lightEmission >= CAVE_LIGHT_BLOCKS) return false;
        }
      }
    }
    return true;
  }

  /** Create a mob directly (also handy for debugging / commands). */
  spawnMob(type, x, y, z) {
    const mob = new Mob(type, this.world, this._tmpVec.set(x, y, z));
    this.mobs.push(mob);
    this.scene.add(mob.object3D);
    return mob;
  }

  _despawnDistant(player) {
    const limitSq = M.despawnDistance * M.despawnDistance;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      const dx = mob.position.x - player.position.x;
      const dz = mob.position.z - player.position.z;
      if (dx * dx + dz * dz <= limitSq) continue;

      if (this.onMobDespawn) this.onMobDespawn(mob);
      this.scene.remove(mob.object3D);
      mob.dispose();
      this.mobs.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Drops
  // -------------------------------------------------------------------------

  _dropLoot(mob) {
    // Counted here rather than at the damage site: this is the one place that
    // runs exactly once per mob that actually died.
    if (this.onMobKilled) this.onMobKilled(mob);

    // A `lootTable` (bosses) rolls weighted rewards; a plain `drops` list is the
    // fixed everyday case. Either may be present.
    if (mob.type.lootTable) {
      for (const stack of rollLoot(mob.type.lootTable)) {
        this.dropItem(mob.position.x, mob.position.y + 0.6, mob.position.z, stack.id, stack.count);
      }
      if (this.onBossDefeated && mob.type.boss) this.onBossDefeated(mob);
    }

    if (!mob.type.drops) return;
    for (const drop of mob.type.drops) {
      const count = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
      if (count > 0) this.dropItem(mob.position.x, mob.position.y + 0.4, mob.position.z, drop.id, count);
    }
  }

  dropItem(x, y, z, id, count = 1, durability) {
    const item = new ItemEntity(this.world, this._tmpVec.set(x, y, z), id, count, durability);
    if (this.onItemPickup) item.onPickup = this.onItemPickup;
    this.items.push(item);
    this.scene.add(item.mesh);
    return item;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Nearest mob along a ray, via the slab method.
   * @returns {{mob: Mob, distance: number}|null}
   */
  raycast(origin, direction, maxDistance) {
    let best = null;

    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const hw = mob.width / 2;
      const t = rayBoxIntersect(
        origin, direction,
        mob.position.x - hw, mob.position.y, mob.position.z - hw,
        mob.position.x + hw, mob.position.y + mob.height, mob.position.z + hw
      );
      if (t === null || t > maxDistance) continue;
      if (!best || t < best.distance) best = { mob, distance: t };
    }

    return best;
  }

  /** Used to stop the player sealing a mob inside a block. */
  anyMobIntersectsBlock(x, y, z) {
    return this.mobs.some((mob) => !mob.dead && mob.intersectsBlock(x, y, z));
  }

  /** How many living mobs are within `radius` of a point. */
  _countWithin(point, radius) {
    const radiusSq = radius * radius;
    let count = 0;
    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const dx = mob.position.x - point.x;
      const dz = mob.position.z - point.z;
      if (dx * dx + dz * dz <= radiusSq) count++;
    }
    return count;
  }

  get mobCount() {
    return this.mobs.length;
  }

  clear() {
    for (const mob of this.mobs) {
      this.scene.remove(mob.object3D);
      mob.dispose();
    }
    for (const item of this.items) this.scene.remove(item.mesh);
    for (const arrow of this.projectiles) this.scene.remove(arrow.mesh);
    this.mobs.length = 0;
    this.items.length = 0;
    this.projectiles.length = 0;
    // Effects belong to the scene that is going away with everything else.
    if (this.particles) this.particles.clear();
  }
}

/** Pick one `{type, weight}` entry proportionally to its weight. */
function pickWeighted(candidates) {
  let total = 0;
  for (const c of candidates) total += c.weight;
  let roll = Math.random() * total;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) return c.type;
  }
  return candidates[candidates.length - 1].type;
}

/**
 * Ray vs. axis-aligned box (slab method).
 * @returns {number|null} distance along the ray to the entry point
 */
function rayBoxIntersect(origin, dir, minX, minY, minZ, maxX, maxY, maxZ) {
  let tMin = 0;
  let tMax = Infinity;

  const axes = [
    [origin.x, dir.x, minX, maxX],
    [origin.y, dir.y, minY, maxY],
    [origin.z, dir.z, minZ, maxZ],
  ];

  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      // Ray is parallel to this slab: miss unless the origin is already inside.
      if (o < lo || o > hi) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin;
}
