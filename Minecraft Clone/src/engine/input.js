/**
 * input.js — Keyboard, mouse and pointer-lock handling.
 *
 * Exposes both *state* (`isDown`) and *edges* (`wasPressed`). Edge queries are
 * valid for exactly one frame; the game loop calls `endFrame()` to clear them,
 * which keeps input handling free of scattered one-shot booleans.
 */

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

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      // Let the browser keep its own shortcuts (reload, devtools, ...).
      if (e.ctrlKey && e.code !== 'ControlLeft' && e.code !== 'ControlRight') return;
      if (!this.keysDown.has(e.code)) this.keysPressed.add(e.code);
      this.keysDown.add(e.code);
      // Stop space/arrows from scrolling the page behind the canvas.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) {
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
