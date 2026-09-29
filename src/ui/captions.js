/**
 * captions.js — On-screen captions for sounds.
 *
 * For anyone playing muted or hard of hearing. Jev's pick (see
 * JEV_DECISIONS.md) was Minecraft's style: a short list in the bottom-right
 * corner, newest at the bottom, each line fading as it ages. The close
 * runner-up is folded in: a caption with a source keeps an arrow pointing at
 * it, updated as you turn, rather than a fixed left or right.
 *
 * The same caption arriving again refreshes the existing line instead of
 * stacking a copy, so a herd of cows is one "Cow moos", not six.
 */

import { prefs } from '../engine/preferences.js';

/** Seconds a caption stays, including its fade. */
const LIFETIME = 3.4;
const FADE = 1.0;
const MAX_LINES = 7;

export class Captions {
  constructor(root) {
    this.root = root;
    /** @type {{text, position, age, el, arrow}[]} */
    this.lines = [];
  }

  /**
   * @param position {x, y, z} of the source, or null for a sound with no
   *   place in the world (thunder, your own footsteps)
   */
  show(text, position = null) {
    if (!prefs.get('captions') || !text) return;
    let line = this.lines.find((l) => l.text === text);
    if (line) {
      line.age = 0;
      line.position = position ? { x: position.x, y: position.y, z: position.z } : line.position;
      // Newest at the bottom.
      this.root.appendChild(line.el);
      this.lines.splice(this.lines.indexOf(line), 1);
      this.lines.push(line);
      return;
    }

    const el = document.createElement('div');
    el.className = 'caption';
    const arrow = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = text;
    el.append(arrow, label);
    this.root.appendChild(el);
    line = { text, position: position ? { x: position.x, y: position.y, z: position.z } : null, age: 0, el, arrow };
    this.lines.push(line);
    while (this.lines.length > MAX_LINES) this.lines.shift().el.remove();
  }

  /** Age the lines and keep each arrow pointing at its source. */
  update(dt, player) {
    this.root.classList.toggle('show', this.lines.length > 0 && prefs.get('captions'));
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      line.age += dt;
      if (line.age >= LIFETIME) {
        line.el.remove();
        this.lines.splice(i, 1);
        continue;
      }
      line.el.style.opacity = String(Math.min(1, (LIFETIME - line.age) / FADE));

      if (!line.position) {
        line.arrow.className = '';
        continue;
      }
      const dx = line.position.x - player.position.x;
      const dz = line.position.z - player.position.z;
      if (Math.hypot(dx, dz) < 2) {
        // Right on top of you: a dot rather than an arrow.
        line.arrow.className = 'here';
        continue;
      }
      line.arrow.className = 'dir';
      const look = player.getLookDirection();
      const len = Math.hypot(look.x, look.z) || 1;
      const fx = look.x / len, fz = look.z / len;
      // Clockwise angle from straight ahead; 0 points up the screen.
      const angle = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
      line.arrow.style.transform = `rotate(${angle}rad)`;
    }
  }

  clear() {
    for (const line of this.lines) line.el.remove();
    this.lines = [];
  }
}

/** The verb each kind of creature voice makes, for "Zombie groans". */
const VERBS = {
  groan: 'groans', rattle: 'rattles', hiss: 'hisses', chitter: 'chitters', oink: 'grunts', baa: 'baas',
  burble: 'burbles', fuse: 'hisses',
  moo: 'moos', bleat: 'baas', cluck: 'clucks', bark: 'barks', howl: 'howls', squeak: 'squeaks',
  crackle: 'crackles', whale: 'sings', buzz: 'buzzes', roar: 'roars', warble: 'warbles',
  click: 'clicks', hum: 'hums', skitter: 'skitters', screech: 'screeches',
};

/** A caption for a creature's call: "Zombie groans", "Cow hurts", "Spider dies". */
export function mobCaption(profile, kind) {
  if (!profile) return null;
  const raw = profile.displayName ?? profile.name ?? 'Creature';
  const name = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
  if (kind === 'hurt') return `${name} hurts`;
  if (kind === 'death') return `${name} dies`;
  return `${name} ${VERBS[profile.voice] ?? 'calls'}`;
}
