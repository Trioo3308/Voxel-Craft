/**
 * avatars.js — The other players, as you see them.
 *
 * A figure in the same boxy style as the mobs (mobTypes.js), with a shirt
 * coloured from the player's name so friends are told apart at a glance, a
 * name tag that shows through walls the way Minecraft's does, and whatever
 * they hold in their right hand. Poses arrive about ten times a second
 * (session.js); in between, each figure glides toward the latest one, and its
 * legs swing with how fast it is really moving.
 *
 * A pose is a flat array, the shape it travels in:
 *   [x, y, z, yaw, pitch, dimension, heldId, flags]
 *   flags: 1 crouching, 2 swung an arm since the last pose, 4 held item enchanted
 */

import * as THREE from 'three';
import { getIconTile, isBlockId, ATLAS_COLS, ATLAS_ROWS } from '../world/blocks.js';
import { getAtlasTexture } from '../world/textures.js';

export const POSE_CROUCH = 1;
export const POSE_SWING = 2;
export const POSE_ENCHANTED = 4;

/** Seconds a swing of the arm takes. */
const SWING_TIME = 0.3;
/** Further than this between poses is a teleport, not a walk. */
const SNAP_DISTANCE = 8;

const HAIR = [0x3b2a1e, 0x1c1a19, 0x7a4a24, 0xc9a45c, 0x8c2f1f, 0x5a5a5a];
const SKIN = [0xe0b08c, 0xc68e62, 0x9c6b47, 0x6b4630, 0xf0c9a4];

function nameHash(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function material(color) {
  return new THREE.MeshLambertMaterial({ color });
}

function box(w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
  mesh.position.set(x, y, z);
  return mesh;
}

/** A limb hanging from a pivot at its top edge, as mobTypes.js builds them. */
function limb(w, h, d, color, x, y, z) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material(color));
  mesh.position.y = -h / 2;
  pivot.add(mesh);
  return pivot;
}

/** Faces +Z unrotated, feet at the origin: the mob convention. */
function buildFigure(name) {
  const h = nameHash(name);
  const shirt = new THREE.Color().setHSL((h % 360) / 360, 0.55, 0.45).getHex();
  const skin = SKIN[(h >>> 9) % SKIN.length];
  const hair = HAIR[(h >>> 13) % HAIR.length];
  const pants = 0x2c3552;

  const group = new THREE.Group();
  const body = new THREE.Group();
  // Facing +Z, the figure's own right is -X.
  const legLeft = limb(0.24, 0.72, 0.24, pants, 0.125, 0.72, 0);
  const legRight = limb(0.24, 0.72, 0.24, pants, -0.125, 0.72, 0);
  const armLeft = limb(0.22, 0.7, 0.22, shirt, 0.37, 1.34, 0);
  const armRight = limb(0.22, 0.7, 0.22, shirt, -0.37, 1.34, 0);
  // Bare hands at the ends of the sleeves.
  armLeft.add(box(0.225, 0.2, 0.225, skin, 0, -0.6, 0));
  armRight.add(box(0.225, 0.2, 0.225, skin, 0, -0.6, 0));
  const torso = box(0.5, 0.62, 0.26, shirt, 0, 1.03, 0);

  const head = new THREE.Group();
  head.position.set(0, 1.34, 0);
  head.add(box(0.5, 0.5, 0.5, skin, 0, 0.25, 0));
  head.add(box(0.52, 0.14, 0.52, hair, 0, 0.45, 0));
  head.add(box(0.52, 0.3, 0.1, hair, 0, 0.32, -0.22));
  head.add(box(0.09, 0.07, 0.02, 0xf4f4f4, -0.12, 0.26, 0.26));
  head.add(box(0.09, 0.07, 0.02, 0xf4f4f4, 0.12, 0.26, 0.26));
  head.add(box(0.045, 0.07, 0.022, 0x2b3a6b, -0.1, 0.26, 0.262));
  head.add(box(0.045, 0.07, 0.022, 0x2b3a6b, 0.14, 0.26, 0.262));

  body.add(legLeft, legRight, armLeft, armRight, torso, head);
  group.add(body);
  return { group, body, legLeft, legRight, armLeft, armRight, head };
}

/** A name tag drawn once into a canvas, as a sprite that faces the camera. */
function buildTag(name) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 30px "Pixelify Sans", monospace';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(name).width) + 24;
  canvas.width = width;
  canvas.height = 44;
  ctx.font = font;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, 0, width, 44);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, width / 2, 23);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false,
  }));
  sprite.scale.set((width / 44) * 0.3, 0.3, 1);
  sprite.position.y = 2.2;
  sprite.renderOrder = 20;
  return sprite;
}

/** Held things: a small cube for blocks, a flat card for items, both wearing the atlas. */
const heldGeometry = new Map();
const sharedGeometry = new Set();
let heldMaterial = null;

function heldMesh(id) {
  heldMaterial ??= new THREE.MeshLambertMaterial({ map: getAtlasTexture(), alphaTest: 0.5, side: THREE.DoubleSide });
  let geometry = heldGeometry.get(id);
  if (!geometry) {
    const block = isBlockId(id);
    geometry = block ? new THREE.BoxGeometry(0.28, 0.28, 0.28) : new THREE.BoxGeometry(0.52, 0.52, 0.02);
    const tile = getIconTile(id);
    const col = tile % ATLAS_COLS;
    const row = Math.floor(tile / ATLAS_COLS);
    const u0 = col / ATLAS_COLS;
    const v0 = 1 - (row + 1) / ATLAS_ROWS;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + (0.02 + uv.getX(i) * 0.96) / ATLAS_COLS, v0 + (0.02 + uv.getY(i) * 0.96) / ATLAS_ROWS);
    }
    heldGeometry.set(id, geometry);
    sharedGeometry.add(geometry);
  }
  const mesh = new THREE.Mesh(geometry, heldMaterial);
  if (isBlockId(id)) {
    mesh.position.set(0, -0.7, 0.12);
  } else {
    // Held by the handle, side on: an icon's handle is its bottom-left
    // corner, so the card sits forward and up of the hand, head pointing ahead.
    mesh.rotation.y = -Math.PI / 2;
    mesh.position.set(0, -0.44, 0.17);
  }
  return mesh;
}

const angleTo = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Avatars {
  constructor(scene) {
    this.scene = scene;
    /** id -> avatar */
    this.list = new Map();
  }

  /** Add someone, or rename them. */
  add(id, name) {
    const existing = this.list.get(id);
    if (existing && existing.name === name) return;
    if (existing) this.remove(id);
    const figure = buildFigure(name);
    const tag = buildTag(name);
    figure.group.add(tag);
    figure.group.visible = false;
    this.scene.add(figure.group);
    this.list.set(id, {
      name, ...figure, tag,
      target: null, position: new THREE.Vector3(), yaw: 0, pitch: 0,
      dimension: null, heldId: 0, heldObject: null,
      walk: 0, speed: 0, swing: 1, crouch: false,
    });
  }

  remove(id) {
    const avatar = this.list.get(id);
    if (!avatar) return;
    this.scene.remove(avatar.group);
    avatar.group.traverse((object) => {
      if (object.isMesh && !sharedGeometry.has(object.geometry)) object.geometry.dispose();
      if (object.material && object.material !== heldMaterial) {
        object.material.map?.dispose();
        object.material.dispose();
      }
    });
    this.list.delete(id);
  }

  /** The latest pose for someone; see the file comment for its shape. */
  setPose(id, pose) {
    const avatar = this.list.get(id);
    if (!avatar || !Array.isArray(pose)) return;
    const [x, y, z, yaw, pitch, dimension, heldId, flags] = pose;
    const first = !avatar.target || avatar.dimension !== dimension;
    avatar.target = { x, y, z, yaw, pitch };
    avatar.dimension = dimension;
    avatar.crouch = (flags & POSE_CROUCH) !== 0;
    if (flags & POSE_SWING) avatar.swing = 0;
    if (first || avatar.position.distanceTo(avatar.target) > SNAP_DISTANCE) {
      avatar.position.set(x, y, z);
      avatar.yaw = yaw;
      avatar.pitch = pitch;
    }
    if ((heldId | 0) !== avatar.heldId) {
      avatar.heldId = heldId | 0;
      if (avatar.heldObject) avatar.armRight.remove(avatar.heldObject);
      avatar.heldObject = avatar.heldId ? heldMesh(avatar.heldId) : null;
      if (avatar.heldObject) avatar.armRight.add(avatar.heldObject);
    }
  }

  /** Glide everyone toward their latest pose, and show those in this dimension. */
  update(dt, dimension) {
    const blend = 1 - Math.exp(-12 * dt);
    for (const avatar of this.list.values()) {
      const visible = !!avatar.target && avatar.dimension === dimension;
      avatar.group.visible = visible;
      if (!visible) continue;

      const t = avatar.target;
      const before = avatar.position.clone();
      avatar.position.x += (t.x - avatar.position.x) * blend;
      avatar.position.y += (t.y - avatar.position.y) * blend;
      avatar.position.z += (t.z - avatar.position.z) * blend;
      avatar.yaw += angleTo(avatar.yaw, t.yaw) * blend;
      avatar.pitch += (t.pitch - avatar.pitch) * blend;

      const moved = Math.hypot(avatar.position.x - before.x, avatar.position.z - before.z);
      avatar.speed += ((dt > 0 ? moved / dt : 0) - avatar.speed) * Math.min(1, dt * 8);
      avatar.walk += dt * Math.min(avatar.speed, 8) * 2.2;
      const stride = Math.min(1, avatar.speed / 4.3) * 0.75;
      const swing = Math.sin(avatar.walk) * stride;

      avatar.group.position.copy(avatar.position);
      // The player looks down -Z at yaw 0; the figure faces +Z.
      avatar.group.rotation.y = avatar.yaw + Math.PI;
      avatar.body.position.y = avatar.crouch ? -0.2 : 0;
      avatar.body.rotation.x = avatar.crouch ? 0.35 : 0;
      avatar.head.rotation.x = -avatar.pitch - (avatar.crouch ? 0.35 : 0);
      avatar.legLeft.rotation.x = swing;
      avatar.legRight.rotation.x = -swing;
      avatar.armLeft.rotation.x = -swing * 0.8;

      // A swing is a chop down and forward, then back to walking.
      if (avatar.swing < 1) avatar.swing = Math.min(1, avatar.swing + dt / SWING_TIME);
      const chop = avatar.swing < 1 ? Math.sin(avatar.swing * Math.PI) : 0;
      avatar.armRight.rotation.x = swing * 0.8 - chop * 1.6 - (avatar.heldId ? 0.25 : 0);
      avatar.armRight.rotation.z = chop * 0.25;
    }
  }

  clear() {
    for (const id of [...this.list.keys()]) this.remove(id);
  }
}
