/**
 * settings.js — Settings screen, primarily key rebinding.
 *
 * Rows are built from the ACTIONS table in engine/keybinds.js, so adding a
 * rebindable action needs no changes here.
 */

import { ACTIONS, FIXED_CONTROLS, keybinds, keyLabel } from '../engine/keybinds.js';
import { RESERVED_COMBOS } from '../engine/input.js';

const el = (id) => document.getElementById(id);

export class SettingsScreen {
  /**
   * @param input the Input instance, used to capture the next key press
   * @param onClose called when the player dismisses the screen
   */
  constructor(input, onClose) {
    this.input = input;
    this.onClose = onClose;
    this.screen = el('settingsScreen');
    this.listEl = el('keybindList');

    /** Action currently waiting for a key, or null. */
    this.listening = null;
    this.rows = new Map();

    this._buildBindRows();
    this._buildFixedList();
    this._bindButtons();
  }

  _buildBindRows() {
    let lastGroup = null;

    for (const action of ACTIONS) {
      if (action.group !== lastGroup) {
        lastGroup = action.group;
        const heading = document.createElement('div');
        heading.className = 'bindGroup';
        heading.textContent = action.group;
        this.listEl.appendChild(heading);
      }

      const row = document.createElement('div');
      row.className = 'bindRow';

      const label = document.createElement('div');
      label.className = 'bindLabel';
      label.textContent = action.label;

      const button = document.createElement('button');
      button.textContent = keyLabel(keybinds.get(action.id));
      button.addEventListener('click', () => this._beginListening(action.id, button));

      const desc = document.createElement('div');
      desc.className = 'bindDesc';
      desc.textContent = action.desc;

      row.append(label, button, desc);
      this.listEl.appendChild(row);
      this.rows.set(action.id, button);
    }
  }

  _buildFixedList() {
    const target = el('fixedList');
    for (const control of FIXED_CONTROLS) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = control.label;
      const desc = document.createElement('span');
      desc.textContent = control.desc;
      target.append(key, desc);
    }
  }

  _bindButtons() {
    el('closeSettingsButton').addEventListener('click', () => this.close());

    // Escape closes the screen, or cancels a rebind that is mid-capture.
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.code !== 'Escape') return;
      if (this.listening) {
        this.input.captureNextKey = null;
        this.listening = null;
        this._refresh();
        return;
      }
      this.close();
    });

    el('resetBindsButton').addEventListener('click', () => {
      keybinds.reset();
      this._refresh();
    });

    const captureButton = el('captureKeysButton');
    const status = el('captureStatus');

    if (!this.input.canCaptureKeyboard) {
      captureButton.disabled = true;
      status.textContent = 'Not supported in this browser.';
    } else {
      captureButton.addEventListener('click', async () => {
        if (this.input.keyboardCaptured) {
          this.input.releaseKeyboardCapture();
          captureButton.textContent = 'Capture all keys (fullscreen)';
          status.textContent = '';
          return;
        }
        const ok = await this.input.requestKeyboardCapture();
        if (ok) {
          captureButton.textContent = 'Stop capturing';
          status.textContent = `Now blocking ${RESERVED_COMBOS.join(', ')} too.`;
        } else {
          status.textContent = 'Could not capture — fullscreen was refused.';
        }
      });
    }
  }

  /** Wait for the next key press and assign it to this action. */
  _beginListening(actionId, button) {
    // Cancel any row already listening.
    if (this.listening) {
      this.rows.get(this.listening).classList.remove('listening');
      this.input.captureNextKey = null;
    }

    this.listening = actionId;
    button.classList.add('listening');
    button.textContent = 'Press a key…';

    this.input.captureNextKey = (code) => {
      this.listening = null;
      button.classList.remove('listening');

      // Escape cancels rather than binding — it is needed to leave menus.
      if (code !== 'Escape') keybinds.set(actionId, code);
      this._refresh();
    };
  }

  /** Repaint every row from the current bindings. */
  _refresh() {
    for (const [actionId, button] of this.rows) {
      button.classList.remove('listening');
      button.textContent = keyLabel(keybinds.get(actionId));
    }
  }

  open() {
    this._refresh();
    this.screen.classList.add('show');
  }

  close() {
    // Abandon a half-finished rebind rather than leaving input hijacked.
    if (this.listening) {
      this.input.captureNextKey = null;
      this.listening = null;
      this._refresh();
    }
    this.screen.classList.remove('show');
    if (this.onClose) this.onClose();
  }

  get isOpen() {
    return this.screen.classList.contains('show');
  }
}
