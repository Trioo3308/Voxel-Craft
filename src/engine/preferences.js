/**
 * preferences.js — Per-browser options: video, audio, controls, interface.
 *
 * Kept apart from world saves, like the key bindings: these describe the
 * person and their machine rather than a world, so they follow you into every
 * world and are untouched by save migrations.
 *
 * The PREFERENCES table is the whole definition. The settings screen builds its
 * rows from it, and anything that cares about a value subscribes with
 * `prefs.onChange`, so adding an option is one entry here plus whatever reads it.
 */

const STORAGE_KEY = 'voxelcraft.prefs.v1';
/** Bumped when stored options need migrating; see load(). */
const PREFS_VERSION = 2;

const percent = (v) => `${Math.round(v * 100)}%`;

/**
 * Every option.
 *   type 'range'  — min/max/step, shown with `format`
 *   type 'toggle' — boolean
 *   type 'select' — one of `options`
 */
export const PREFERENCES = [
  // ---- Video ---------------------------------------------------------------
  {
    id: 'graphics', group: 'video', label: 'Graphics', type: 'select',
    options: ['auto', 'high', 'medium', 'low'], default: 'auto',
    desc: 'Shadows and glow. Auto starts high and steps down if the game runs slowly.',
  },
  {
    id: 'renderDistance', group: 'video', label: 'Render distance', type: 'range',
    min: 3, max: 16, step: 1, default: 8, format: (v) => `${v} chunks`,
    desc: 'How far terrain loads. Lower is smoother on slow machines.',
  },
  {
    id: 'fov', group: 'video', label: 'Field of view', type: 'range',
    min: 50, max: 110, step: 1, default: 75, format: (v) => `${v}°`,
  },
  {
    id: 'brightness', group: 'video', label: 'Brightness', type: 'range',
    min: 0, max: 1, step: 0.05, default: 0.25, format: percent,
    desc: 'Lifts the darkest shadows. Caves stay dark, just not black.',
  },
  { id: 'clouds', group: 'video', label: 'Clouds', type: 'toggle', default: true },
  {
    id: 'farTerrain', group: 'video', label: 'Distant terrain', type: 'toggle', default: true,
    desc: 'Low-detail land past your render distance, out to 512 blocks. Not drawn on Low graphics.',
  },
  {
    id: 'foliageSway', group: 'video', label: 'Swaying plants', type: 'toggle', default: true,
    desc: 'Leaves, grass and crops move in the wind.',
  },
  {
    id: 'particles', group: 'video', label: 'Particles', type: 'select',
    options: ['all', 'fewer', 'minimal'], default: 'all',
  },
  { id: 'viewBobbing', group: 'video', label: 'View bobbing', type: 'toggle', default: true },
  {
    id: 'fovEffects', group: 'video', label: 'Speed effects', type: 'toggle', default: true,
    desc: 'Widen the view while sprinting or boosting.',
  },

  // ---- Audio ---------------------------------------------------------------
  { id: 'masterVolume', group: 'audio', label: 'Master', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7, format: percent },
  { id: 'musicVolume', group: 'audio', label: 'Music', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7, format: percent },
  { id: 'effectsVolume', group: 'audio', label: 'Effects', type: 'range', min: 0, max: 1, step: 0.05, default: 1, format: percent },

  // ---- Controls ------------------------------------------------------------
  {
    id: 'sensitivity', group: 'controls', label: 'Mouse sensitivity', type: 'range',
    min: 0.2, max: 3, step: 0.05, default: 1, format: (v) => `${v.toFixed(2)}×`,
  },
  { id: 'invertY', group: 'controls', label: 'Invert mouse', type: 'toggle', default: false },
  {
    id: 'autoJump', group: 'controls', label: 'Auto-jump', type: 'toggle', default: false,
    desc: 'Hop up one-block steps as you walk into them.',
  },

  // ---- Interface -----------------------------------------------------------
  {
    id: 'guiScale', group: 'interface', label: 'Interface size', type: 'range',
    min: 0.75, max: 1.5, step: 0.05, default: 1, format: percent,
  },
  { id: 'showCoords', group: 'interface', label: 'Coordinates', type: 'toggle', default: true },
  {
    id: 'compass', group: 'interface', label: 'Compass strip', type: 'toggle', default: true,
    desc: 'Bearings and markers across the top of the screen.',
  },
  {
    id: 'captions', group: 'interface', label: 'Sound captions', type: 'toggle', default: false,
    desc: 'Show what you can hear, and where it is, in the corner.',
  },
  {
    id: 'minimap', group: 'interface', label: 'Minimap', type: 'toggle', default: false,
    desc: 'A small map of your surroundings in the corner.',
  },
  {
    id: 'damageFlash', group: 'interface', label: 'Damage flash', type: 'toggle', default: true,
    desc: 'Red flash across the screen when you are hurt.',
  },
];

export const PREFERENCE_GROUPS = [
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'controls', label: 'Controls' },
  { id: 'interface', label: 'Interface' },
];

const BY_ID = new Map(PREFERENCES.map((p) => [p.id, p]));

/** Force a stored value back into range, so a hand-edited or stale one is safe. */
function sanitize(def, value) {
  switch (def.type) {
    case 'range': {
      const n = Number(value);
      if (!Number.isFinite(n)) return def.default;
      const stepped = Math.round((n - def.min) / def.step) * def.step + def.min;
      return Math.min(def.max, Math.max(def.min, Number(stepped.toFixed(4))));
    }
    case 'toggle':
      return typeof value === 'boolean' ? value : def.default;
    case 'select':
      return def.options.includes(value) ? value : def.default;
    default:
      return def.default;
  }
}

export class Preferences {
  constructor() {
    this.values = {};
    for (const def of PREFERENCES) this.values[def.id] = def.default;
    /** @type {Set<(id:string, value:any)=>void>} */
    this.listeners = new Set();
    this.load();
  }

  get(id) {
    return this.values[id];
  }

  set(id, value) {
    const def = BY_ID.get(id);
    if (!def) return;
    const clean = sanitize(def, value);
    if (clean === this.values[id]) return;
    this.values[id] = clean;
    this.save();
    for (const listener of this.listeners) listener(id, clean);
  }

  /** Restore one group's defaults, or every option. */
  reset(group = null) {
    for (const def of PREFERENCES) {
      if (!group || def.group === group) this.set(def.id, def.default);
    }
  }

  /**
   * Subscribe to changes. The listener is also called once per option right
   * away, so a subscriber applies the current state without a second code path.
   * @returns an unsubscribe function
   */
  onChange(listener) {
    this.listeners.add(listener);
    for (const def of PREFERENCES) listener(def.id, this.values[def.id]);
    return () => this.listeners.delete(listener);
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw);
      // Settings saved before Graphics had an Auto level recorded High only
      // because it was the default then. Move them to Auto, once.
      if ((stored.version ?? 1) < 2 && stored.graphics === 'high') delete stored.graphics;
      for (const def of PREFERENCES) {
        if (def.id in stored) this.values[def.id] = sanitize(def, stored[def.id]);
      }
    } catch {
      // Corrupt or blocked storage: defaults are already in place.
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.values, version: PREFS_VERSION }));
    } catch {
      // Private browsing can block storage; options just will not persist.
    }
  }
}

export const prefs = new Preferences();
