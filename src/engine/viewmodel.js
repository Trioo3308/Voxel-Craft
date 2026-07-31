/**
 * viewmodel.js — First-person arm and held item.
 *
 * Rendered in its *own* scene and camera, drawn after the world with the depth
 * buffer cleared. That is the standard trick for first-person view models: if
 * the arm lived in the main scene it would poke through walls whenever you
 * stood close to one, because it is physically inside the terrain.
 *
 * Blocks are shown as small cubes with their real atlas texture; tools and
 * items are shown as flat sprites, the way Minecraft holds them.
 */

import * as THREE from 'three';
import { getAtlasTexture, getGripPoint } from '../world/textures.js';
import { getIconTile, isBlockId, getThing, ATLAS_COLS, FACE_PY, BLOCKS } from '../world/blocks.js';

const SKIN = 0xc98b62;
const SLEEVE = 0x3f6fb5;

/** Edge length of the flat sprite used for tools and items. */
const SPRITE_SIZE = 0.34;

/** Where the grip of a tool sits — the front of the closed fist. */
const HOLD_TOOL = new THREE.Vector3(-0.03, 0.03, -0.14);
/**
 * Blade/head points up-left at roughly 40 degrees. The sprite's own axis is
 * up-left once mirrored, so the small +z roll only tilts it off the diagonal;
 * the yaw is what gives it perspective rather than looking like a decal.
 */
const HOLD_TOOL_ROTATION = new THREE.Euler(0, 0.45, 0.18);
/** Plain items float in front of the hand instead. */
const HOLD_ITEM = new THREE.Vector3(-0.02, 0.06, -0.2);

/** Seconds one full swing takes. */
const SWING_SECONDS = 0.28;

export class ViewModel {
  constructor(renderer) {
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
    this.camera.position.set(0, 0, 0);

    // Lighting just for the hand, so it reads as solid regardless of world time.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x606060, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);

    /** Holds the arm and whatever is being held, so both swing together. */
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this._buildArm();

    /** @type {THREE.Object3D|null} */
    this.heldObject = null;
    this._heldId = null;
    this._blockGeometryCache = new Map();
    this._spriteMaterialCache = new Map();

    this.swing = 0;      // 0..1 progress through a swing
    this._swinging = false;
    this._bobPhase = 0;

    this._restPosition = new THREE.Vector3(0.42, -0.38, -0.62);
    this._restRotation = new THREE.Euler(0, -0.3, 0.12);
  }

  _buildArm() {
    this.arm = new THREE.Group();

    const forearm = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.52),
      new THREE.MeshLambertMaterial({ color: SKIN })
    );
    forearm.position.set(0, 0, 0.16);

    const sleeve = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.22),
      new THREE.MeshLambertMaterial({ color: SLEEVE })
    );
    sleeve.position.set(0, 0, 0.44);

    this.arm.add(forearm, sleeve);
    this.pivot.add(this.arm);
  }

  // -------------------------------------------------------------------------
  // Held item
  // -------------------------------------------------------------------------

  /** Cube geometry with the block's own faces mapped from the atlas. */
  _blockGeometry(id) {
    const cached = this._blockGeometryCache.get(id);
    if (cached) return cached;

    const geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const block = BLOCKS[id];
    const uv = geometry.attributes.uv;
    const span = 1 / ATLAS_COLS;

    // BoxGeometry face order matches our own: +X, -X, +Y, -Y, +Z, -Z.
    for (let face = 0; face < 6; face++) {
      const tile = block ? block.tiles[face] : 0;
      const u0 = (tile % ATLAS_COLS) * span;
      const v0 = 1 - (Math.floor(tile / ATLAS_COLS) + 1) * span;
      for (let i = 0; i < 4; i++) {
        const index = face * 4 + i;
        uv.setXY(
          index,
          u0 + (0.03 + uv.getX(index) * 0.94) * span,
          v0 + (0.03 + uv.getY(index) * 0.94) * span
        );
      }
    }
    uv.needsUpdate = true;

    this._blockGeometryCache.set(id, geometry);
    return geometry;
  }

  /** Flat sprite material for a tool or item icon. */
  _spriteMaterial(id) {
    const tile = getIconTile(id);
    const cached = this._spriteMaterialCache.get(tile);
    if (cached) return cached;

    // Clone the atlas so each icon can carry its own UV offset.
    const texture = getAtlasTexture().clone();
    texture.needsUpdate = true;
    texture.repeat.set(1 / ATLAS_COLS, 1 / ATLAS_COLS);
    texture.offset.set(
      (tile % ATLAS_COLS) / ATLAS_COLS,
      1 - (Math.floor(tile / ATLAS_COLS) + 1) / ATLAS_COLS
    );

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    this._spriteMaterialCache.set(tile, material);
    return material;
  }

  /** Show (or clear) what the player is holding. */
  setHeld(id) {
    if (id === this._heldId) return;
    this._heldId = id;

    if (this.heldObject) {
      this.pivot.remove(this.heldObject);
      this.heldObject = null;
    }
    if (!id) {
      this.arm.visible = true;
      return;
    }

    if (isBlockId(id)) {
      const mesh = new THREE.Mesh(
        this._blockGeometry(id),
        new THREE.MeshLambertMaterial({ map: getAtlasTexture(), alphaTest: 0.5 })
      );
      mesh.position.set(0, 0.04, -0.22);
      mesh.rotation.set(0.2, 0.7, 0.1);
      this.heldObject = mesh;
    } else {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SPRITE_SIZE, SPRITE_SIZE), this._spriteMaterial(id));

      // A tool is carried by its handle, not by the middle of its blade. The
      // sprite is shifted inside a holder so its grip sits at the holder's
      // origin, and the holder is what gets placed at the fist — so the tool
      // also rotates about the hand instead of about its own centre.
      const thing = getThing(id);
      const holder = new THREE.Group();

      // A bow is gripped mid-limb, not at a handle, so it is excluded — the
      // measured rule would put the hand on its bottom tip. Plain items have no
      // handle either and stay centred.
      const hasHandle = !!(thing && thing.tool && !thing.ranged);

      if (hasHandle) {
        const grip = getGripPoint(getIconTile(id));
        // Mirrored, so the handle ends up on the right beside the fist and the
        // head sweeps up-left toward the crosshair — the icons are all drawn
        // handle-bottom-left, which points the wrong way when held.
        mesh.scale.x = -1;
        mesh.position.set((grip.u - 0.5) * SPRITE_SIZE, (grip.v - 0.5) * SPRITE_SIZE, 0);
        holder.position.copy(HOLD_TOOL);
        holder.rotation.copy(HOLD_TOOL_ROTATION);
      } else {
        holder.position.copy(HOLD_ITEM);
        holder.rotation.set(0, -0.55, -0.5);
      }

      holder.add(mesh);
      this.heldObject = holder;
    }

    // The arm still shows, tucked behind the item.
    this.arm.visible = true;
    this.pivot.add(this.heldObject);
  }

  /**
   * Trigger the swing animation.
   *
   * A swing already in flight is left alone. Mining sets `didSwing` every frame
   * it is held, and restarting the cycle each time pinned progress at 0 — the
   * arm sat frozen mid-mine instead of swinging. Repeats are handled in
   * `update` by relooping once a cycle actually completes.
   */
  triggerSwing() {
    if (this._swinging) return;
    this.swing = 0;
    this._swinging = true;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /**
   * @param dt seconds
   * @param player used for held item, walk bob and stance
   */
  update(dt, player) {
    const held = player.inventory.getSelected();
    this.setHeld(held ? held.id : null);
    if (player.didSwing) this.triggerSwing();

    // --- Swing ------------------------------------------------------------
    if (this._swinging) {
      this.swing += dt / SWING_SECONDS;
      if (this.swing >= 1) {
        // Holding to mine keeps `didSwing` true, so roll straight into the next
        // stroke; a one-off hit stops here. The remainder is carried over so
        // repeated swings stay evenly paced instead of drifting with framerate.
        if (player.didSwing) {
          this.swing %= 1;
        } else {
          this.swing = 0;
          this._swinging = false;
        }
      }
    }

    // Up-and-over arc: rises, drives down and forward, then recovers. The
    // downstroke is quicker than the recovery, which is what makes it read as a
    // swing with weight rather than a symmetric wobble.
    const t = this.swing;
    const s = this._swinging
      ? (t < 0.4 ? Math.sin((t / 0.4) * Math.PI * 0.5) : Math.cos(((t - 0.4) / 0.6) * Math.PI * 0.5))
      : 0;

    // --- Walk bob ---------------------------------------------------------
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.onGround && speed > 0.5) {
      this._bobPhase += dt * speed * 1.7;
    }
    const bobX = Math.cos(this._bobPhase) * 0.014 * Math.min(1, speed / 5);
    const bobY = Math.abs(Math.sin(this._bobPhase)) * 0.018 * Math.min(1, speed / 5);

    // Crouching pulls the hand down a little.
    const crouchDrop = player.crouching ? 0.06 : 0;

    this.pivot.position.set(
      this._restPosition.x + bobX - s * 0.12,
      this._restPosition.y + bobY - crouchDrop - s * 0.06,
      this._restPosition.z + s * 0.18
    );
    this.pivot.rotation.set(
      this._restRotation.x - s * 0.9,
      this._restRotation.y + s * 0.25,
      this._restRotation.z
    );
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Draw over the world with a cleared depth buffer so it never clips. */
  render() {
    const gl = this.renderer.renderer;
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(this.scene, this.camera);
    gl.autoClear = true;
  }
}
