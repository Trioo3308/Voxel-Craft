/**
 * keybinds.js — Rebindable controls.
 *
 * The rest of the game asks for *actions* ("is forward held?") rather than key
 * codes, so rebinding is purely a matter of changing this map. Bindings persist
 * in localStorage, keyed separately from world saves so they survive across
 * worlds and are unaffected by save migrations.
 */

const STORAGE_KEY = 'voxelcraft.keybinds.v1';

/**
 * Every rebindable action, with its default key and a one-line description.
 * The descriptions are deliberately terse — this list doubles as the in-game
 * controls reference, and a wall of prose there is worse than none.
 */
export const ACTIONS = [
  { id: 'forward',   label: 'Forward',      default: 'KeyW',        group: 'Movement', desc: 'Walk ahead' },
  { id: 'back',      label: 'Back',         default: 'KeyS',        group: 'Movement', desc: 'Walk backwards' },
  { id: 'left',      label: 'Strafe left',  default: 'KeyA',        group: 'Movement', desc: 'Sidestep left' },
  { id: 'right',     label: 'Strafe right', default: 'KeyD',        group: 'Movement', desc: 'Sidestep right' },
  { id: 'jump',      label: 'Jump',         default: 'Space',       group: 'Movement', desc: 'Jump, swim up, fly up' },
  { id: 'crouch',    label: 'Crouch',       default: 'ShiftLeft',   group: 'Movement', desc: 'Shorter, and cannot fall off edges' },
  { id: 'sprint',    label: 'Sprint',       default: 'ControlLeft', group: 'Movement', desc: 'Run faster — or double-tap Forward' },

  { id: 'inventory', label: 'Inventory',    default: 'KeyE',        group: 'Actions',  desc: 'Open your inventory and crafting grid' },
  { id: 'drop',      label: 'Drop item',    default: 'KeyQ',        group: 'Actions',  desc: 'Throw one; hold Sprint for the whole stack' },
  { id: 'progress',  label: 'Progress',     default: 'KeyL',        group: 'Actions',  desc: 'Achievements and statistics' },

  { id: 'creative',  label: 'Game mode',    default: 'KeyG',        group: 'Options',  desc: 'Switch between survival and creative' },
  { id: 'fly',       label: 'Fly',          default: 'KeyF',        group: 'Options',  desc: 'Toggle flight (creative only)' },
  { id: 'debug',     label: 'Debug info',   default: 'F3',          group: 'Options',  desc: 'Show position, biome and performance' },
  { id: 'mute',      label: 'Mute sound',   default: 'KeyM',        group: 'Options',  desc: 'Silence all audio' },
  { id: 'settings',  label: 'Settings',     default: 'F1',          group: 'Options',  desc: 'Open this screen' },
];

/** Controls that are not rebindable, listed for reference only. */
export const FIXED_CONTROLS = [
  { label: 'Mouse',        desc: 'Look around' },
  { label: 'Left click',   desc: 'Hold to mine, click to attack' },
  { label: 'Right click',  desc: 'Place, eat, use doors and containers' },
  { label: 'Hold right',   desc: 'Draw the bow, release to fire' },
  { label: '1 – 9',        desc: 'Select a hotbar slot' },
  { label: 'Mouse wheel',  desc: 'Cycle hotbar slots' },
  { label: 'Esc',          desc: 'Pause, or close a menu' },
];

/** Human-readable name for a KeyboardEvent.code. */
export function keyLabel(code) {
  if (!code) return 'Unbound';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  if (code.startsWith('Arrow')) return code.slice(5) + ' Arrow';

  const named = {
    Space: 'Space',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt',
    Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    CapsLock: 'Caps Lock', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return named[code] ?? code;
}

export class Keybinds {
  constructor() {
    /** action id -> KeyboardEvent.code */
    this.map = {};
    this.reset(false);
    this.load();
  }

  /** Restore every action to its default. */
  reset(save = true) {
    for (const action of ACTIONS) this.map[action.id] = action.default;
    if (save) this.save();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw);
      // Only accept ids we still know about, so removing an action cannot
      // resurrect a stale binding.
      for (const action of ACTIONS) {
        if (typeof stored[action.id] === 'string') this.map[action.id] = stored[action.id];
      }
    } catch {
      // Corrupt or unavailable storage: defaults are already in place.
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map));
    } catch {
      // Private browsing can block storage; bindings just will not persist.
    }
  }

  get(actionId) {
    return this.map[actionId];
  }

  /** Which action a key code currently triggers, or null. */
  actionFor(code) {
    for (const id of Object.keys(this.map)) if (this.map[id] === code) return id;
    return null;
  }

  /**
   * Assign a key to an action.
   *
   * If another action already uses that key, the two swap rather than leaving a
   * duplicate — a duplicate would make one of them silently unreachable.
   * @returns {{displaced: string|null}}
   */
  set(actionId, code) {
    const previous = this.map[actionId];
    const conflict = this.actionFor(code);

    if (conflict && conflict !== actionId) this.map[conflict] = previous;
    this.map[actionId] = code;
    this.save();
    return { displaced: conflict && conflict !== actionId ? conflict : null };
  }

  /** Every code currently bound, for the input layer's suppression check. */
  boundCodes() {
    return new Set(Object.values(this.map));
  }
}

export const keybinds = new Keybinds();
