/**
 * settings.js — The settings screen: option pages plus key rebinding.
 *
 * Both halves are table-driven. Option rows come from PREFERENCES in
 * engine/preferences.js and key rows from ACTIONS in engine/keybinds.js, so
 * adding either kind of setting needs no changes here.
 */

import { ACTIONS, FIXED_CONTROLS, keybinds, keyLabel } from '../engine/keybinds.js';
import { RESERVED_COMBOS } from '../engine/input.js';
import { PREFERENCES, PREFERENCE_GROUPS, prefs } from '../engine/preferences.js';

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
    /** Repaint functions for option rows, keyed by preference id. */
    this.prefRows = new Map();
    this.page = 'video';

    this._buildTabs();
    this._buildPrefRows();
    this._buildBindRows();
    this._buildFixedList();
    this._bindButtons();

    // Keep the rows honest if something else changes an option (the mute key,
    // say) while the screen is open.
    prefs.onChange((id) => this.prefRows.get(id)?.());
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  _buildTabs() {
    const bar = el('settingsTabs');
    this.tabButtons = new Map();
    for (const group of PREFERENCE_GROUPS) {
      const button = document.createElement('button');
      button.textContent = group.label;
      button.addEventListener('click', () => this.showPage(group.id));
      bar.appendChild(button);
      this.tabButtons.set(group.id, button);
    }
    this.showPage(this.page);
  }

  showPage(page) {
    this.page = page;
    for (const [id, button] of this.tabButtons) button.classList.toggle('active', id === page);
    for (const node of this.screen.querySelectorAll('.tabPage')) {
      node.classList.toggle('active', node.dataset.page === page);
    }
  }

  // -------------------------------------------------------------------------
  // Option rows
  // -------------------------------------------------------------------------

  _buildPrefRows() {
    for (const def of PREFERENCES) {
      const list = el(`prefs-${def.group}`);
      if (!list) continue;

      const row = document.createElement('div');
      row.className = 'prefRow';
      const label = document.createElement('div');
      label.className = 'prefLabel';
      label.textContent = def.label;
      row.appendChild(label);

      let repaint;
      if (def.type === 'range') {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = def.min;
        slider.max = def.max;
        slider.step = def.step;
        const value = document.createElement('div');
        value.className = 'prefValue';
        slider.addEventListener('input', () => prefs.set(def.id, Number(slider.value)));
        row.append(slider, value);
        repaint = () => {
          const v = prefs.get(def.id);
          slider.value = v;
          value.textContent = def.format ? def.format(v) : String(v);
        };
      } else if (def.type === 'toggle') {
        const button = document.createElement('button');
        button.className = 'toggle';
        button.addEventListener('click', () => prefs.set(def.id, !prefs.get(def.id)));
        row.appendChild(button);
        repaint = () => {
          const on = prefs.get(def.id);
          button.textContent = on ? 'On' : 'Off';
          button.classList.toggle('on', on);
        };
      } else {
        const group = document.createElement('div');
        group.className = 'segmented';
        const buttons = def.options.map((option) => {
          const button = document.createElement('button');
          button.textContent = option;
          button.addEventListener('click', () => prefs.set(def.id, option));
          group.appendChild(button);
          return [option, button];
        });
        row.appendChild(group);
        repaint = () => {
          for (const [option, button] of buttons) button.classList.toggle('on', prefs.get(def.id) === option);
        };
      }

      if (def.desc) {
        const desc = document.createElement('div');
        desc.className = 'prefDesc';
        desc.textContent = def.desc;
        row.appendChild(desc);
      }

      list.appendChild(row);
      this.prefRows.set(def.id, repaint);
      repaint();
    }
  }

  // -------------------------------------------------------------------------
  // Key bindings
  // -------------------------------------------------------------------------

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

    // Resets only the page you are looking at: nobody wants to lose their key
    // bindings because the brightness slider went too far.
    el('resetBindsButton').addEventListener('click', () => {
      prefs.reset(this.page);
      if (this.page === 'controls') keybinds.reset();
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

  /** Repaint every row from the current bindings and options. */
  _refresh() {
    for (const [actionId, button] of this.rows) {
      button.classList.remove('listening');
      button.textContent = keyLabel(keybinds.get(actionId));
    }
    for (const repaint of this.prefRows.values()) repaint();
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
