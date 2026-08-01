/**
 * rocket.js — Launched fireworks.
 *
 * A rocket is its own entity rather than a particle effect because it has to
 * climb for a while before it does anything, and the particle pool has no
 * concept of "run this callback when you expire".
 *
 * Colours are picked per rocket from a small palette and kept for the burst, so
 * a rocket looks like one firework rather than a spray of unrelated sparks.
 */

import * as THREE from 'three';
import { BLOCKS, AIR, isLiquid } from '../world/blocks.js';
import { audio } from '../engine/audio.js';

const GRAVITY = 3.2;
/** Upward thrust while the fuse burns. */
const THRUST = 26;

/** Firework palettes. Each rocket picks one, so its burst reads as a colour. */
const PALETTES = [
  [0xff4d4d, 0xffa14d],
  [0x4db8ff, 0xa4e4ff],
  [0x7dff6b, 0xd6ff9e],
  [0xff6bd6, 0xffc2ec],
  [0xffe14d, 0xfff4a8],
  [0xffffff, 0xc2d4ff],
];

export class Rocket {
  /**
   * @param {THREE.Vector3} position launch point
   * @param {THREE.Vector3} direction unit vector to climb along
   */
  constructor(world, position, direction) {
    this.world = world;
    this.position = position.clone();
    this.velocity = direction.clone().multiplyScalar(6);

    // Fuse length varies, so a handful launched together do not burst in unison.
    this.fuse = 0.9 + Math.random() * 0.7;
    this.removed = false;
    this.colors = PALETTES[(Math.random() * PALETTES.length) | 0];
    this._trailTimer = 0;

    const geometry = new THREE.BoxGeometry(0.14, 0.32, 0.14);
    const material = new THREE.MeshLambertMaterial({ color: 0xd8d2c4 });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(this.position);

    audio.rocketLaunch();
  }

  update(dt, ctx) {
    this.fuse -= dt;

    // Thrust along the current heading, so a rocket fired at an angle keeps it.
    const heading = this.velocity.clone().normalize();
    this.velocity.addScaledVector(heading, THRUST * dt);
    this.velocity.y -= GRAVITY * dt;

    const next = this.position.clone().addScaledVector(this.velocity, dt);

    // Hitting anything solid detonates it early — a rocket fired at a wall
    // should burst against the wall, not tunnel through it.
    if (this._solidAt(next)) {
      this.burst(ctx);
      return;
    }
    this.position.copy(next);
    this.mesh.position.copy(this.position);
    // Point the casing along its flight.
    this.mesh.lookAt(this.position.clone().add(this.velocity));
    this.mesh.rotateX(Math.PI / 2);

    this._trailTimer -= dt;
    if (this._trailTimer <= 0) {
      this._trailTimer = 0.03;
      ctx.particles?.rocketTrail(this.position.x, this.position.y, this.position.z);
    }

    if (this.fuse <= 0) this.burst(ctx);
  }

  burst(ctx) {
    this.removed = true;
    ctx.particles?.firework(this.position.x, this.position.y, this.position.z, this.colors);

    const listener = ctx.player ? this.position.distanceTo(ctx.player.eyePosition) : 0;
    audio.fireworkBurst(listener);
  }

  _solidAt(point) {
    const id = this.world.getBlock(
      Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)
    );
    const block = BLOCKS[id];
    return !!block && block.solid && !isLiquid(id);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
