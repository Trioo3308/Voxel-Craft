/**
 * input.js — Keyboard, mouse and pointer-lock handling.
 *
 * Exposes both *state* (`isDown`) and *edges* (`wasPressed`). Edge queries are
 * valid for exactly one frame; the game loop calls `endFrame()` to clear them,
 * which keeps input handling free of scattered one-shot booleans.
 *
 * Prefer the action-based queries (`isActionDown`, `actionWasPressed`) over raw
 * key codes so controls stay rebindable.
 */

import { keybinds } from './keybinds.js';

/**
 * Keys we deliberately let through to the browser even while playing.
 *
 * Everything else is suppressed. That is the opposite of the previous approach,
 * which allow-listed game keys and skipped suppression whenever Ctrl was held —
 * and since Ctrl is the sprint key, every Ctrl+<game key> combination reached
 * the browser instead. Ctrl+D bookmarked the page, Ctrl+S opened a save dialog,
 * Ctrl+F opened find, and so on, in the middle of play.
 *
 * Escape has to reach the browser to release the pointer lock; the rest are
 * developer and window controls that it would be hostile to steal.
 */
const ALLOWED_THROUGH = new Set([
  'Escape',
  'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/**
 * Combinations Chrome reserves at the browser level. `preventDefault` cannot
 * stop these — only the Keyboard Lock API can, and only in fullscreen. Listed so
 * the settings screen can explain the situation honestly.
 */
export const RESERVED_COMBOS = ['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+W', 'Alt+F4'];

/** In menus, only block keys that would scroll the page or move focus. */
const MENU_SUPPRESSED = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class Input {
  /** @param {HTMLElement} domElement element that captures the pointer */
  constructor(domElement) {
    this.dom = domElement;

    this.keysDown = new Set();
    this.keysPressed = new Set();   // pressed since last endFrame()
    this.keysReleased = new Set();

    this.mouseDown = [false, false, false];
    this.mousePressed = [false, false, false];

    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;

    this.locked = false;
    /** @type {((locked:boolean)=>void)|null} */
    this.onLockChange = null;
    /** Set to true to swallow input while a menu is open. */
    this.enabled = true;
    /** Set while a text input has focus, so typing is not suppressed. */
    this.textFieldFocused = false;
    /**
     * When rebinding, the next keydown is captured instead of being treated as
     * a game input. Set to a callback by the settings screen.
     * @type {((code:string)=>void)|null}
     */
    this.captureNextKey = null;

    this._bind();
  }

  _bind() {
    // Track text-field focus so the rebinding UI and world-name box can type.
    document.addEventListener('focusin', (e) => {
      this.textFieldFocused = e.target instanceof HTMLInputElement;
    });
    document.addEventListener('focusout', () => { this.textFieldFocused = false; });

    window.addEventListener('keydown', (e) => {
      // Rebinding swallows the key entirely — it must not also act in-game.
      if (this.captureNextKey) {
        e.preventDefault();
        const callback = this.captureNextKey;
        this.captureNextKey = null;
        callback(e.code);
        return;
      }

      // Record the key regardless of modifiers.
      //
      // This used to bail out whenever e.ctrlKey was set, to avoid stealing
      // browser shortcuts — but Ctrl is the sprint key, so holding it silently
      // swallowed WASD and Space and made sprinting-while-jumping impossible.
      // Modifier state is irrelevant to us; we simply never preventDefault on
      // keys the game does not own, so real browser shortcuts still work.
      if (!this.keysDown.has(e.code)) this.keysPressed.add(e.code);
      this.keysDown.add(e.code);

      // While the pointer is locked the player is playing, not browsing, so
      // suppress everything except the small allowlist. Modifier state is
      // ignored on purpose: Ctrl is a game key, and skipping suppression when it
      // was held is exactly what let Ctrl+D, Ctrl+S and Ctrl+F fire mid-game.
      if (this.locked && !ALLOWED_THROUGH.has(e.code)) {
        e.preventDefault();
      }
      // In a menu, only stop keys that would scroll or move focus behind it.
      else if (!this.locked && MENU_SUPPRESSED.has(e.code) && !this.textFieldFocused) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.code);
      this.keysReleased.add(e.code);
    });

    // Releasing focus should not leave keys stuck down.
    window.addEventListener('blur', () => {
      this.keysDown.clear();
      this.mouseDown = [false, false, false];
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button < 3) {
        if (!this.mouseDown[e.button]) this.mousePressed[e.button] = true;
        this.mouseDown[e.button] = true;
      }
      e.preventDefault();
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button < 3) this.mouseDown[e.button] = false;
    });

    // Right-click places blocks; the context menu would get in the way.
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDeltaX += e.movementX || 0;
      this.mouseDeltaY += e.movementY || 0;
    });

    this.dom.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.wheelDelta += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keysDown.clear();
        this.mouseDown = [false, false, false];
      }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  /** Request pointer lock. Must be called from a user gesture. */
  requestLock() {
    if (!this.locked) this.dom.requestPointerLock();
  }

  releaseLock() {
    if (this.locked) document.exitPointerLock();
  }

  isDown(code) {
    return this.enabled && this.keysDown.has(code);
  }

  wasPressed(code) {
    return this.enabled && this.keysPressed.has(code);
  }

  isMouseDown(button) {
    return this.enabled && this.mouseDown[button];
  }

  mouseWasPressed(button) {
    return this.enabled && this.mousePressed[button];
  }

  /** Any of the given key codes held. */
  anyDown(...codes) {
    return codes.some((c) => this.isDown(c));
  }

  // -------------------------------------------------------------------------
  // Action queries
  // -------------------------------------------------------------------------
  // The game asks about actions rather than key codes, so rebinding needs no
  // changes anywhere else.

  isActionDown(actionId) {
    return this.isDown(keybinds.get(actionId));
  }

  actionWasPressed(actionId) {
    return this.wasPressed(keybinds.get(actionId));
  }

  // -------------------------------------------------------------------------
  // Keyboard capture
  // -------------------------------------------------------------------------

  /**
   * Ask for exclusive keyboard access, which is the only way to intercept the
   * combinations Chrome reserves (Ctrl+W, Ctrl+T and friends). It requires
   * fullscreen, so this enters fullscreen first.
   *
   * @returns {Promise<boolean>} whether capture is now active
   */
  async requestKeyboardCapture() {
    if (!document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        return false;
      }
    }
    if (!navigator.keyboard || !navigator.keyboard.lock) return false;
    try {
      await navigator.keyboard.lock();
      this.keyboardCaptured = true;
      return true;
    } catch {
      return false;
    }
  }

  releaseKeyboardCapture() {
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    this.keyboardCaptured = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  /** Is exclusive keyboard capture available in this browser? */
  get canCaptureKeyboard() {
    return !!(navigator.keyboard && navigator.keyboard.lock);
  }

  /** Clear per-frame edges and accumulated deltas. Call at end of each frame. */
  endFrame() {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed = [false, false, false];
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }
}
