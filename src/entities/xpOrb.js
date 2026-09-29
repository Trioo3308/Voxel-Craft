/**
 * xpOrb.js — Experience orbs.
 *
 * Small glowing motes that pop out of whatever gave the experience, hop about,
 * then home in on the nearest living player and are absorbed. They glow above
 * 1 on purpose: the bloom pass picks that up, so a stream of orbs reads as
 * light, not as green cubes. Bigger rewards come as bigger orbs (see
 * experience.js), so a boss does not bury you in a hundred of them.
 */

import * as THREE from 'three';
import { moveWithCollision } from '../player/physics.js';

/** Collision size; the sprite is drawn a little larger than this. */
const SIZE = 0.12;
/** Orbs home in on a player within this range. */
const ATTRACT_RADIUS = 7.5;
const PICKUP_RADIUS = 0.9;
/** A beat before an orb can be taken, so it visibly pops out first. */
const PICKUP_DELAY = 0.35;
const LIFETIME = 300;

/**
 * The orb's picture: a 16px pixel-art bead, lime at the rim and near-white in
 * the middle, painted once and shared by every orb.
 */
let orbTexture = null;
function getOrbTexture() {
  if (orbTexture) return orbTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 5.6) continue;
      const i = (y * 16 + x) * 4;
      // Rim, body, hot core, with a pixel of shine up and to the left.
      const shine = x === 6 && y === 5;
      const [r, g, b] = shine || d < 1.8 ? [255, 255, 214] : d < 3.6 ? [206, 255, 92] : d < 4.7 ? [128, 222, 46] : [72, 150, 24];
      image.data.set([r, g, b, 255], i);
    }
  }
  ctx.putImageData(image, 0, 0);
  orbTexture = new THREE.CanvasTexture(canvas);
  orbTexture.magFilter = THREE.NearestFilter;
  orbTexture.minFilter = THREE.NearestFilter;
  orbTexture.generateMipmaps = false;
  orbTexture.colorSpace = THREE.SRGBColorSpace;
  return orbTexture;
}

export class XpOrb {
  constructor(position, value) {
    this.value = value;
    this.position = position.clone();
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 3,
      2 + Math.random() * 2,
      (Math.random() - 0.5) * 3
    );
    this.age = Math.random() * 0.2;
    this.removed = false;
    this._phase = Math.random() * Math.PI * 2;

    // A camera-facing sprite: an orb looks round from every side.
    this.material = new THREE.SpriteMaterial({
      map: getOrbTexture(), transparent: true, alphaTest: 0.5, toneMapped: false,
    });
    this.mesh = new THREE.Sprite(this.material);
    // Bigger rewards, bigger orbs, but gently: a 37-point orb is not 37 times
    // the size of a 1.
    this.baseScale = 0.22 * (1 + Math.log2(1 + value) * 0.14);
    this.mesh.scale.setScalar(this.baseScale);
    this.mesh.position.copy(this.position);
  }

  /** @param ctx { world, player, onCollect(value) } */
  update(dt, ctx) {
    this.age += dt;
    if (this.age > LIFETIME || this.position.y < -32) {
      this.removed = true;
      return;
    }

    const player = ctx.player;
    const alive = player && !player.survival.dead;
    const dx = alive ? player.position.x - this.position.x : 0;
    const dy = alive ? player.position.y + 0.8 - this.position.y : 0;
    const dz = alive ? player.position.z - this.position.z : 0;
    const distance = Math.hypot(dx, dy, dz);

    if (alive && this.age > PICKUP_DELAY && distance < ATTRACT_RADIUS) {
      // Accelerate toward the player, harder the nearer it is, ignoring
      // terrain: orbs slip through gaps rather than getting stuck on a lip.
      const pull = (1 - distance / ATTRACT_RADIUS) * 26 + 4;
      this.velocity.x += (dx / distance) * pull * dt;
      this.velocity.y += (dy / distance) * pull * dt;
      this.velocity.z += (dz / distance) * pull * dt;
      this.velocity.multiplyScalar(Math.exp(-2.2 * dt));
      this.position.addScaledVector(this.velocity, dt);
      if (distance < PICKUP_RADIUS) {
        this.removed = true;
        ctx.onCollect?.(this.value);
        return;
      }
    } else {
      this.velocity.y -= 14 * dt;
      const result = moveWithCollision(ctx.world, this.position, this.velocity, { width: SIZE, height: SIZE }, dt);
      if (result.onGround) {
        this.velocity.x *= Math.exp(-5 * dt);
        this.velocity.z *= Math.exp(-5 * dt);
      }
    }

    // Pulse brighter than white, which the bloom pass turns into a glow, and
    // drift between lime and gold; bob a little.
    const t = this.age * 4 + this._phase;
    const glow = 1.25 + Math.sin(t * 1.3) * 0.3;
    this.material.color.setRGB((0.85 + 0.15 * Math.sin(t)) * glow, glow, (0.6 + 0.2 * Math.sin(t * 0.7)) * glow);
    this.mesh.scale.setScalar(this.baseScale * (0.92 + 0.08 * Math.sin(t * 2.1)));
    this.mesh.position.set(this.position.x, this.position.y + SIZE * 0.5 + Math.sin(t) * 0.04, this.position.z);
  }

  dispose() {
    this.material.dispose();
  }
}
