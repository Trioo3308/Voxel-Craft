/**
 * worldMap.js — The full-screen map, its waypoint editor, and the corner minimap.
 *
 * Jev's picks (see JEV_DECISIONS.md): a "satellite" map (the real top block of
 * every column, hill-shaded so ridges and valleys read, water darkening with
 * depth) framed as a pixel-art parchment sheet with a compass rose; opened
 * with a key at any time; showing only ground you have explored, with the
 * rest left as fog. The runner-up, a small minimap in the corner, is here too,
 * off by default.
 *
 * Terrain comes from `Exploration`: one 16x16 tile per explored chunk, drawn
 * once into a tiny canvas and cached, so panning the map is just drawing
 * those canvases scaled up with smoothing off.
 */

import { BLOCKS, FACE_PY } from '../world/blocks.js';
import { getTilePalette, getTileDataURL } from '../world/textures.js';
import { CHUNK_SX, CHUNK_SZ } from '../world/chunk.js';
import { COLUMN_BYTES } from '../world/exploration.js';
import { prefs } from '../engine/preferences.js';
import { audio } from '../engine/audio.js';

const ZOOMS = [1, 2, 3, 4, 6, 8];
const FOG = '#1d1a16';
const INK = '#2b1d10';
const SHALLOW_BED = [196, 180, 128];

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const colourCache = new Map();

/** A block's colour seen from above: the average of its top texture. */
function blockColour(id) {
  if (colourCache.has(id)) return colourCache.get(id);
  let rgb = null;
  const def = BLOCKS[id];
  if (def && id !== 0) {
    if (def.fluid && def.fluid.family === 'water') rgb = [48, 92, 178];
    else if (def.fluid && def.fluid.family === 'lava') rgb = [226, 104, 26];
    else {
      const palette = getTilePalette(def.tiles[FACE_PY]);
      if (palette.length) {
        let r = 0, g = 0, b = 0;
        for (const c of palette) { r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255; }
        rgb = [r / palette.length, g / palette.length, b / palette.length];
      }
    }
  }
  colourCache.set(id, rgb);
  return rgb;
}

// ---------------------------------------------------------------------------
// Tile cache: one 16x16 canvas per explored chunk
// ---------------------------------------------------------------------------

class TileCache {
  constructor(exploration) {
    this.exploration = exploration;
    this.canvases = new Map();
  }

  /** Forget tiles that have changed since last time. */
  sync() {
    for (const entry of this.exploration.changed) this.canvases.delete(entry);
    this.exploration.changed.clear();
  }

  get(dimension, cx, cz) {
    const key = `${dimension}|${cx},${cz}`;
    if (this.canvases.has(key)) return this.canvases.get(key);
    const tile = this.exploration.tile(dimension, cx, cz);
    const canvas = tile ? this._paint(dimension, tile, cx, cz) : null;
    this.canvases.set(key, canvas);
    return canvas;
  }

  _paint(dimension, tile, cx, cz) {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_SX;
    canvas.height = CHUNK_SZ;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(CHUNK_SX, CHUNK_SZ);
    const west = this.exploration.tile(dimension, cx - 1, cz);
    const north = this.exploration.tile(dimension, cx, cz - 1);

    // Height of a column, reaching into the neighbouring tile at the edges.
    const heightAt = (lx, lz) => {
      if (lx < 0) return west ? west[(CHUNK_SX - 1 + lz * CHUNK_SX) * COLUMN_BYTES + 1] : null;
      if (lz < 0) return north ? north[(lx + (CHUNK_SZ - 1) * CHUNK_SX) * COLUMN_BYTES + 1] : null;
      return tile[(lx + lz * CHUNK_SX) * COLUMN_BYTES + 1];
    };

    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const o = (lx + lz * CHUNK_SX) * COLUMN_BYTES;
        const top = tile[o], height = tile[o + 1], floor = tile[o + 2];
        const p = (lx + lz * CHUNK_SX) * 4;
        let rgb = blockColour(top);
        if (!rgb) {
          // Open sky over the void (the Aether): a pale blue, not fog.
          rgb = dimension === 'aether' ? [150, 184, 226] : [20, 18, 16];
        }
        let [r, g, b] = rgb;

        const def = BLOCKS[top];
        if (def && def.fluid && def.fluid.family === 'water') {
          // Deeper water is darker; the shallows show a little of the bed.
          const depth = Math.max(0, height - floor);
          // Only the bed's height is kept, not its block; sand is what most shallows are.
          const bed = SHALLOW_BED;
          const shallow = Math.max(0, 1 - depth / 3) * 0.25;
          const dark = 1 - Math.min(depth, 12) * 0.045;
          r = (r * (1 - shallow) + bed[0] * shallow) * dark;
          g = (g * (1 - shallow) + bed[1] * shallow) * dark;
          b = (b * (1 - shallow) + bed[2] * shallow) * dark;
        } else {
          // Hill shading: lit from the north-west, so a rise catches the light
          // on its near side and a drop falls into shade.
          const nw = heightAt(lx - 1, lz) ?? height;
          const nn = heightAt(lx, lz - 1) ?? height;
          const slope = (height - nw) + (height - nn);
          const shade = 1 + Math.max(-0.32, Math.min(0.26, slope * 0.07));
          r *= shade; g *= shade; b *= shade;
        }
        image.data[p] = r;
        image.data[p + 1] = g;
        image.data[p + 2] = b;
        image.data[p + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }
}

// ---------------------------------------------------------------------------
// Parchment and compass rose, painted once
// ---------------------------------------------------------------------------

function paintParchment() {
  const w = 96, h = 96;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = rnd() * 18 - 9;
      const blotch = Math.sin(x * 0.21) * Math.cos(y * 0.17) * 6;
      ctx.fillStyle = `rgb(${210 + n + blotch}, ${188 + n + blotch}, ${140 + n * 0.8})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL();
}

function paintCompassRose() {
  const s = 33;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  const c = 16;
  const px = (x, y, colour) => { ctx.fillStyle = colour; ctx.fillRect(x, y, 1, 1); };
  const fill = '#f1e2b8';
  // A four-pointed star: each arm a long thin diamond, drawn as an ink
  // outline around a pale fill, with the north arm in red.
  const arm = (dx, dy, length, colour) => {
    for (let i = 0; i <= length; i++) {
      const w = Math.round((1 - i / length) * 3);
      for (let d = -w - 1; d <= w + 1; d++) {
        const x = c + dx * i + (dy !== 0 ? d : 0);
        const y = c + dy * i + (dx !== 0 ? d : 0);
        px(x, y, Math.abs(d) === w + 1 ? INK : (d < 0 ? colour : fill));
      }
    }
  };
  arm(0, -1, 12, '#b3342a');
  arm(0, 1, 13, '#8a6a44');
  arm(1, 0, 9, '#8a6a44');
  arm(-1, 0, 9, '#8a6a44');
  px(c, c, INK);
  // A pixel N above the north point.
  for (const [x, y] of [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1], [2, 2], [3, 0], [3, 1], [3, 2], [3, 3]]) {
    px(c - 2 + x, 0 + y, INK);
  }
  return canvas.toDataURL();
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const iconCache = new Map();

function markerImage(src) {
  if (!src) return null;
  let img = iconCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    iconCache.set(src, img);
  }
  return img.complete ? img : null;
}

/** Draw every marker; returns the hit boxes for clicks. */
function drawMarkers(ctx, markers, toScreen, scale, labels) {
  ctx.imageSmoothingEnabled = false;
  for (const m of markers) {
    const [sx, sy] = toScreen(m.x, m.z);
    if (sx < -40 || sy < -40 || sx > ctx.canvas.width + 40 || sy > ctx.canvas.height + 40) continue;
    if (m.kind === 'death') {
      ctx.strokeStyle = 'rgba(120, 20, 16, 0.85)';
      ctx.lineWidth = Math.max(1, scale);
      const r = 3 * scale;
      ctx.beginPath();
      ctx.moveTo(sx - r, sy - r); ctx.lineTo(sx + r, sy + r);
      ctx.moveTo(sx + r, sy - r); ctx.lineTo(sx - r, sy + r);
      ctx.stroke();
      continue;
    }
    if (m.kind === 'waypoint') {
      const r = 4 * scale;
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.moveTo(sx, sy - r - scale); ctx.lineTo(sx + r + scale, sy); ctx.lineTo(sx, sy + r + scale); ctx.lineTo(sx - r - scale, sy);
      ctx.fill();
      ctx.fillStyle = m.colour ?? '#8be05a';
      ctx.beginPath();
      ctx.moveTo(sx, sy - r); ctx.lineTo(sx + r, sy); ctx.lineTo(sx, sy + r); ctx.lineTo(sx - r, sy);
      ctx.fill();
    } else {
      const img = markerImage(m.icon);
      const size = 12 * scale;
      if (img) {
        ctx.fillStyle = 'rgba(43, 29, 16, 0.55)';
        ctx.fillRect(sx - size / 2 - scale, sy - size / 2 - scale, size + 2 * scale, size + 2 * scale);
        ctx.drawImage(img, sx - size / 2, sy - size / 2, size, size);
      } else {
        ctx.fillStyle = INK;
        ctx.fillRect(sx - 3 * scale, sy - 3 * scale, 6 * scale, 6 * scale);
      }
    }
    if (labels && m.label) {
      ctx.font = `${Math.round(11 * scale)}px "Pixelify Sans", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3 * scale;
      ctx.strokeStyle = 'rgba(236, 220, 180, 0.9)';
      ctx.strokeText(m.label, sx, sy + 8 * scale);
      ctx.fillStyle = INK;
      ctx.fillText(m.label, sx, sy + 8 * scale);
    }
  }
}

/** The player: an arrow pointing where you face. */
function drawPlayer(ctx, sx, sy, yaw, scale) {
  ctx.save();
  ctx.translate(sx, sy);
  // Yaw 0 faces north (up the map); turning right is clockwise.
  ctx.rotate(-yaw);
  const s = 5 * scale;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(0, -s - scale * 2); ctx.lineTo(s + scale * 2, s + scale * 2); ctx.lineTo(0, s * 0.4); ctx.lineTo(-s - scale * 2, s + scale * 2);
  ctx.fill();
  ctx.fillStyle = '#f4ecd4';
  ctx.beginPath();
  ctx.moveTo(0, -s); ctx.lineTo(s, s); ctx.lineTo(0, s * 0.35); ctx.lineTo(-s, s);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export class WorldMap {
  /**
   * @param game the Game, for the player, exploration, markers and waypoints
   */
  constructor(game) {
    this.game = game;
    this.screen = document.getElementById('mapScreen');
    this.canvas = document.getElementById('mapCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.list = document.getElementById('mapWaypoints');
    this.titleEl = document.getElementById('mapTitle');
    this.coordsEl = document.getElementById('mapCoords');
    this.tiles = null;
    this.center = { x: 0, z: 0 };
    this.zoomIndex = 2;
    this._drag = null;
    this._hover = null;

    const frame = document.getElementById('mapFrame');
    frame.style.backgroundImage = `url(${paintParchment()})`;
    document.getElementById('mapRose').style.backgroundImage = `url(${paintCompassRose()})`;

    this._bind();

    // The corner minimap, optional and off by default.
    this.mini = document.getElementById('minimap');
    this.miniCanvas = document.getElementById('minimapCanvas');
    this.miniCtx = this.miniCanvas.getContext('2d');
    this._miniClock = 0;
  }

  get isOpen() {
    return this.screen.classList.contains('show');
  }

  _tiles() {
    const exploration = this.game.exploration;
    if (!this.tiles || this.tiles.exploration !== exploration) this.tiles = new TileCache(exploration);
    this.tiles.sync();
    return this.tiles;
  }

  open() {
    const p = this.game.player.position;
    this.center = { x: p.x, z: p.z };
    this.titleEl.textContent = this.game.dimensionName();
    this.screen.classList.add('show');
    audio.uiOpen();
    this._renderList();
    this.draw();
  }

  close() {
    if (!this.isOpen) return;
    this.screen.classList.remove('show');
    audio.uiClose();
  }

  get scale() {
    return ZOOMS[this.zoomIndex];
  }

  _bind() {
    const canvas = this.canvas;
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this._drag = { x: e.clientX, y: e.clientY, cx: this.center.x, cz: this.center.z };
    });
    window.addEventListener('mousemove', (e) => {
      if (this._drag) {
        const s = this.scale * this._dpr();
        this.center.x = this._drag.cx - ((e.clientX - this._drag.x) * this._dpr()) / s;
        this.center.z = this._drag.cz - ((e.clientY - this._drag.y) * this._dpr()) / s;
        this.draw();
      }
      if (this.isOpen && e.target === canvas) this._showCoords(e);
    });
    window.addEventListener('mouseup', () => { this._drag = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this._worldAt(e);
      this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + (e.deltaY < 0 ? 1 : -1)));
      // Zoom about the cursor, so the spot under it stays put.
      const after = this._worldAt(e);
      this.center.x += before.x - after.x;
      this.center.z += before.z - after.z;
      this.draw();
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      const at = this._worldAt(e);
      const w = this.game.addWaypoint(at.x, at.z);
      if (w) {
        this._renderList(w);
        this.draw();
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('mapZoomIn').addEventListener('click', () => { this.zoomIndex = Math.min(ZOOMS.length - 1, this.zoomIndex + 1); this.draw(); });
    document.getElementById('mapZoomOut').addEventListener('click', () => { this.zoomIndex = Math.max(0, this.zoomIndex - 1); this.draw(); });
    document.getElementById('mapCenter').addEventListener('click', () => {
      const p = this.game.player.position;
      this.center = { x: p.x, z: p.z };
      this.draw();
    });
    document.getElementById('mapAddHere').addEventListener('click', () => {
      const p = this.game.player.position;
      const w = this.game.addWaypoint(p.x, p.z);
      if (w) {
        this._renderList(w);
        this.draw();
      }
    });
    window.addEventListener('resize', () => { if (this.isOpen) this.draw(); });
  }

  _dpr() {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  /** World coordinates under a mouse event. */
  _worldAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const s = this.scale;
    return {
      x: this.center.x + (e.clientX - rect.left - rect.width / 2) / s,
      z: this.center.z + (e.clientY - rect.top - rect.height / 2) / s,
    };
  }

  _showCoords(e) {
    const at = this._worldAt(e);
    const x = Math.floor(at.x), z = Math.floor(at.z);
    const tile = this.game.exploration.tile(this.game.world.dimension, Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ));
    let place = 'Unexplored';
    if (tile) {
      const lx = ((x % CHUNK_SX) + CHUNK_SX) % CHUNK_SX, lz = ((z % CHUNK_SZ) + CHUNK_SZ) % CHUNK_SZ;
      const o = (lx + lz * CHUNK_SX) * COLUMN_BYTES;
      const def = BLOCKS[tile[o]];
      place = def ? `${def.displayName ?? def.name}, y ${tile[o + 1]}` : 'Open sky';
    }
    this.coordsEl.textContent = `${x}, ${z} · ${place}`;
  }

  /** Redraw the whole map. Cheap: the terrain is cached tiles. */
  draw() {
    if (!this.isOpen) return;
    const canvas = this.canvas;
    const dpr = this._dpr();
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = this.ctx;
    const s = this.scale * dpr;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = FOG;
    ctx.fillRect(0, 0, width, height);

    const dimension = this.game.world.dimension;
    const tiles = this._tiles();
    const left = this.center.x - width / 2 / s;
    const topZ = this.center.z - height / 2 / s;
    const cx0 = Math.floor(left / CHUNK_SX), cz0 = Math.floor(topZ / CHUNK_SZ);
    const cx1 = Math.floor((left + width / s) / CHUNK_SX), cz1 = Math.floor((topZ + height / s) / CHUNK_SZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const tile = tiles.get(dimension, cx, cz);
        if (!tile) continue;
        const sx = Math.round((cx * CHUNK_SX - left) * s);
        const sy = Math.round((cz * CHUNK_SZ - topZ) * s);
        const size = Math.ceil(CHUNK_SX * s);
        ctx.drawImage(tile, sx, sy, size, size);
      }
    }

    const toScreen = (x, z) => [(x - left) * s, (z - topZ) * s];
    const markers = this.game.mapMarkers();
    drawMarkers(ctx, markers, toScreen, dpr, this.scale >= 2);
    const p = this.game.player;
    const [px, py] = toScreen(p.position.x, p.position.z);
    drawPlayer(ctx, px, py, p.yaw, dpr);
  }

  /** The waypoint editor beside the map. */
  _renderList(focus = null) {
    const list = this.list;
    list.textContent = '';
    const dimension = this.game.world.dimension;
    const player = this.game.player;
    const waypoints = player.waypoints.filter((w) => w.dimension === dimension);
    if (waypoints.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mapEmpty';
      empty.textContent = 'No waypoints here yet. Double-click the map, or press N in the world.';
      list.appendChild(empty);
      return;
    }
    for (const w of waypoints) {
      const row = document.createElement('div');
      row.className = 'mapWaypoint';
      const swatch = document.createElement('i');
      swatch.style.background = w.colour ?? '#8be05a';
      swatch.title = 'Change colour';
      swatch.addEventListener('click', () => {
        const colours = ['#8be05a', '#ffd36b', '#ff7a45', '#7fc8ff', '#d6a8ff', '#ffffff'];
        const i = colours.indexOf(w.colour ?? '#8be05a');
        w.colour = colours[(i + 1) % colours.length];
        swatch.style.background = w.colour;
        this.draw();
      });
      const name = document.createElement('input');
      name.type = 'text';
      name.value = w.name;
      name.maxLength = 24;
      name.spellcheck = false;
      name.addEventListener('input', () => {
        w.name = name.value.trim() || w.name;
        this.draw();
      });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
      const distance = document.createElement('span');
      distance.className = 'mapDist';
      distance.textContent = `${Math.round(Math.hypot(w.x - player.position.x, w.z - player.position.z))}m`;
      const go = document.createElement('button');
      go.className = 'miniButton';
      go.textContent = 'Show';
      go.addEventListener('click', () => { this.center = { x: w.x, z: w.z }; this.draw(); });
      const del = document.createElement('button');
      del.className = 'miniButton';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        const i = player.waypoints.indexOf(w);
        if (i >= 0) player.waypoints.splice(i, 1);
        this._renderList();
        this.draw();
      });
      row.append(swatch, name, distance, go, del);
      list.appendChild(row);
      if (w === focus) setTimeout(() => { name.focus(); name.select(); }, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------

  updateMinimap(dt, visible) {
    const show = visible && prefs.get('minimap');
    this.mini.classList.toggle('show', show);
    if (!show) return;
    this._miniClock -= dt;
    if (this._miniClock > 0) return;
    this._miniClock = 0.2;

    const canvas = this.miniCanvas;
    const dpr = this._dpr();
    const size = Math.round(canvas.clientWidth * dpr);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = this.miniCtx;
    const s = 2 * dpr;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = FOG;
    ctx.fillRect(0, 0, size, size);

    const p = this.game.player.position;
    const dimension = this.game.world.dimension;
    const tiles = this._tiles();
    const left = p.x - size / 2 / s;
    const topZ = p.z - size / 2 / s;
    const cx0 = Math.floor(left / CHUNK_SX), cz0 = Math.floor(topZ / CHUNK_SZ);
    const cx1 = Math.floor((left + size / s) / CHUNK_SX), cz1 = Math.floor((topZ + size / s) / CHUNK_SZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const tile = tiles.get(dimension, cx, cz);
        if (!tile) continue;
        ctx.drawImage(tile, Math.round((cx * CHUNK_SX - left) * s), Math.round((cz * CHUNK_SZ - topZ) * s),
          Math.ceil(CHUNK_SX * s), Math.ceil(CHUNK_SX * s));
      }
    }
    const toScreen = (x, z) => [(x - left) * s, (z - topZ) * s];
    drawMarkers(ctx, this.game.mapMarkers(), toScreen, dpr * 0.75, false);
    drawPlayer(ctx, size / 2, size / 2, this.game.player.yaw, dpr * 0.8);
  }
}

export { getTileDataURL };
