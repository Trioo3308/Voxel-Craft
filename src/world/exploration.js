/**
 * exploration.js — What you have seen, for the world map.
 *
 * The map shows only ground you have actually been near (Jev's pick; see
 * JEV_DECISIONS.md), so it has to remember what it saw. Every chunk that
 * streams in around you leaves a 16x16 summary of its columns: which block is
 * on top, how high that is, and where the ground is under any water. Three
 * bytes a column, 768 a chunk, saved with the world.
 *
 * The block ids are stored raw and translated through the save's palette on
 * load, exactly like block edits, so a later build that renumbers blocks
 * still draws old maps in the right colours.
 */

import { CHUNK_SX, CHUNK_SZ, voxelIndex, chunkKey } from './chunk.js';
import { AIR, BLOCKS } from './blocks.js';
import { NETHER_CEILING } from './netherTerrain.js';

const COLUMN_BYTES = 3;
const TILE_BYTES = CHUNK_SX * CHUNK_SZ * COLUMN_BYTES;
/** Stop recording new chunks past this many in one dimension. */
const MAX_TILES = 40000;

/** Summarise one column: [top block, its height, the ground under water]. */
function summariseColumn(voxels, lx, lz, dimension, out, offset) {
  let y = 127;
  // In the Nether the top of every column is the bedrock roof, so look past
  // it to the cavern floor.
  if (dimension === 'nether') {
    y = NETHER_CEILING - 1;
    while (y > 0 && voxels[voxelIndex(lx, y, lz)] !== AIR) y--;
  }
  while (y > 0 && voxels[voxelIndex(lx, y, lz)] === AIR) y--;
  const top = voxels[voxelIndex(lx, y, lz)];
  let floor = y;
  if (BLOCKS[top]?.fluid) {
    while (floor > 0 && BLOCKS[voxels[voxelIndex(lx, floor, lz)]]?.fluid) floor--;
  }
  out[offset] = top;
  out[offset + 1] = Math.max(0, y);
  out[offset + 2] = Math.max(0, floor);
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class Exploration {
  constructor() {
    /** dimension -> Map(chunkKey -> Uint8Array(768)) */
    this.dims = new Map();
    /** Bumped on every change, so views know when to redraw. */
    this.version = 0;
    /** Chunks changed since a view last asked, as "dimension|key". */
    this.changed = new Set();
    /**
     * Each tile's base64, kept until the tile changes, so an autosave only
     * re-encodes the chunks that moved rather than the whole map every time.
     */
    this._encoded = new Map();
  }

  _dim(dimension) {
    let tiles = this.dims.get(dimension);
    if (!tiles) {
      tiles = new Map();
      this.dims.set(dimension, tiles);
    }
    return tiles;
  }

  /** A chunk streamed in: remember what it looks like from above. */
  record(dimension, chunk) {
    if (!chunk.voxels) return;
    const tiles = this._dim(dimension);
    const key = chunkKey(chunk.cx, chunk.cz);
    let tile = tiles.get(key);
    if (!tile) {
      if (tiles.size >= MAX_TILES) return;
      tile = new Uint8Array(TILE_BYTES);
      tiles.set(key, tile);
    }
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        summariseColumn(chunk.voxels, lx, lz, dimension, tile, (lx + lz * CHUNK_SX) * COLUMN_BYTES);
      }
    }
    this.version++;
    this.changed.add(`${dimension}|${key}`);
    this._encoded.delete(`${dimension}|${key}`);
  }

  /** A block changed: refresh that one column, if the chunk has been seen. */
  updateColumn(dimension, chunk, wx, wz) {
    const tile = this._dim(dimension).get(chunkKey(chunk.cx, chunk.cz));
    if (!tile || !chunk.voxels) return;
    const lx = ((wx % CHUNK_SX) + CHUNK_SX) % CHUNK_SX;
    const lz = ((wz % CHUNK_SZ) + CHUNK_SZ) % CHUNK_SZ;
    summariseColumn(chunk.voxels, lx, lz, dimension, tile, (lx + lz * CHUNK_SX) * COLUMN_BYTES);
    this.version++;
    this.changed.add(`${dimension}|${chunkKey(chunk.cx, chunk.cz)}`);
    this._encoded.delete(`${dimension}|${chunkKey(chunk.cx, chunk.cz)}`);
  }

  tile(dimension, cx, cz) {
    return this.dims.get(dimension)?.get(chunkKey(cx, cz)) ?? null;
  }

  /** Every explored chunk in a dimension, as [cx, cz] pairs. */
  *chunks(dimension) {
    for (const key of this.dims.get(dimension)?.keys() ?? []) {
      const [cx, cz] = key.split(',').map(Number);
      yield [cx, cz];
    }
  }

  serialize() {
    const out = {};
    for (const [dimension, tiles] of this.dims) {
      const entries = {};
      for (const [key, tile] of tiles) {
        const id = `${dimension}|${key}`;
        let text = this._encoded.get(id);
        if (text === undefined) {
          text = toBase64(tile);
          this._encoded.set(id, text);
        }
        entries[key] = text;
      }
      out[dimension] = entries;
    }
    return out;
  }

  /**
   * @param translate maps an id from the save's palette to this build's id
   */
  load(data, translate = (id) => id) {
    this.dims.clear();
    this.changed.clear();
    // Loaded ids are translated below, so the saved text is not reusable.
    this._encoded.clear();
    this.version++;
    if (!data || typeof data !== 'object') return;
    for (const [dimension, entries] of Object.entries(data)) {
      const tiles = this._dim(dimension);
      for (const [key, text] of Object.entries(entries ?? {})) {
        try {
          const tile = fromBase64(text);
          if (tile.length !== TILE_BYTES) continue;
          for (let i = 0; i < tile.length; i += COLUMN_BYTES) tile[i] = translate(tile[i]);
          tiles.set(key, tile);
        } catch {
          // A damaged tile is just unexplored again.
        }
      }
    }
  }
}

export { COLUMN_BYTES };
