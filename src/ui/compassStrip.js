/**
 * compassStrip.js — Bearings and markers across the top of the screen.
 *
 * The only navigation aid used to be a coordinate readout, which asks you to
 * do trigonometry to find your way home. Jev's pick for replacing it (see
 * JEV_DECISIONS.md) was a strip in the style of modern open-world games: the
 * compass points scroll past as you turn, and anything worth finding again
 * (your bed, your gravestone, portals you have lit, your own waypoints) sits
 * on it at its bearing, with how far away it is.
 */

import { prefs } from '../engine/preferences.js';

/** Degrees either side of straight ahead that the strip shows. */
const HALF_SPAN = 80;
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Wrap an angle into -180..180. */
function wrap(degrees) {
  return ((degrees + 540) % 360) - 180;
}

export class CompassStrip {
  constructor(root) {
    this.root = root;
    root.innerHTML = '<div class="csTrack"></div><div class="csCaret"></div>';
    this.track = root.querySelector('.csTrack');

    // Ticks every 15 degrees; the eight compass points get labels.
    this.ticks = [];
    for (let deg = 0; deg < 360; deg += 15) {
      const tick = document.createElement('div');
      const point = deg % 45 === 0;
      tick.className = point ? 'csTick csPoint' : 'csTick';
      if (point) tick.textContent = POINTS[deg / 45];
      this.track.appendChild(tick);
      this.ticks.push({ deg, el: tick });
    }
    /** Marker elements, reused frame to frame. */
    this.pool = [];
  }

  /**
   * @param heading degrees, 0 north, 90 east
   * @param origin the player's position
   * @param markers [{label, kind, x, z, icon?}] in this dimension
   */
  update(heading, origin, markers, visible) {
    const show = visible && prefs.get('compass');
    this.root.classList.toggle('show', show);
    if (!show) return;

    for (const { deg, el } of this.ticks) {
      const rel = wrap(deg - heading);
      if (Math.abs(rel) > HALF_SPAN) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.left = `${50 + (rel / HALF_SPAN) * 50}%`;
      // Points fade toward the ends so the strip does not have hard edges.
      el.style.opacity = String(1 - Math.pow(Math.abs(rel) / HALF_SPAN, 3));
    }

    while (this.pool.length < markers.length) {
      const mark = document.createElement('div');
      mark.className = 'csMark';
      mark.innerHTML = '<i></i><span></span>';
      this.track.appendChild(mark);
      this.pool.push(mark);
    }

    this.pool.forEach((mark, i) => {
      const m = markers[i];
      if (!m) {
        mark.style.display = 'none';
        return;
      }
      const dx = m.x - origin.x;
      const dz = m.z - origin.z;
      const distance = Math.round(Math.hypot(dx, dz));
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      let rel = wrap(bearing - heading);
      // Anything behind you is pinned to the nearer end, so it is never lost.
      const behind = Math.abs(rel) > HALF_SPAN;
      if (behind) rel = Math.sign(rel) * HALF_SPAN;
      mark.style.display = '';
      mark.style.left = `${50 + (rel / HALF_SPAN) * 50}%`;
      mark.className = `csMark ${m.kind}${behind ? ' behind' : ''}`;
      const icon = mark.firstChild;
      icon.style.backgroundImage = m.icon ? `url(${m.icon})` : '';
      mark.lastChild.textContent = distance < 4 ? m.label : `${m.label} ${distance}m`;
    });
  }
}
