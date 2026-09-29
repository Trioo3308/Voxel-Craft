/**
 * farWorker.js — Builds distant-terrain tiles (see engine/farTerrain.js).
 *
 * Jev's pick for Phase 3 (JEV_DECISIONS.md) was a ring of low-detail land past
 * the render distance, so mountains and coastlines show out to ~512 blocks.
 * Real chunks cost a full 3D volume each; a far tile is a heightfield read
 * straight off the terrain generator's column functions — height, biome,
 * surface block, tree density — on a coarse grid, with no caves, no blocks and
 * no voxels at all. That is what makes hundreds of them affordable.
 *
 * Runs in its own worker so it never delays chunk loading.
 *
 * Protocol
 *   in  { type: 'init', seed, terrainVersion, colors }   colors: id -> [r,g,b] linear
 *   in  { type: 'tile', key, tx, tz, step }
 *   out { type: 'tile', key, tx, tz, step, positions, normals, colors, indices }
 */

import { TerrainGenerator } from './terrain.js';
import { hash2i } from './noise.js';
import { LEAVES, SPRUCE_LEAVES, ACACIA_LEAVES, WATER } from './blocks.js';

/** Blocks along a tile's side. Four chunks, so tiles line up with chunk edges. */
export const FAR_TILE = 64;
/** How far a tile's skirt drops, hiding the cracks between tiles of different detail. */
const SKIRT = 24;

const LEAVES_BY_WOOD = { oak: LEAVES.id, spruce: SPRUCE_LEAVES.id, acacia: ACACIA_LEAVES.id };

let terrain = null;
let colors = {};

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    terrain = new TerrainGenerator(msg.seed, msg.terrainVersion);
    colors = msg.colors ?? {};
    return;
  }
  if (msg.type === 'tile' && terrain) {
    const tile = buildTile(msg.tx, msg.tz, msg.step);
    self.postMessage(
      { type: 'tile', key: msg.key, tx: msg.tx, tz: msg.tz, step: msg.step, ...tile },
      [tile.positions.buffer, tile.normals.buffer, tile.colors.buffer, tile.indices.buffer]
    );
  }
};

const GREY = [0.25, 0.25, 0.25];

/** One sample: the height of the land (or water, or canopy) and its colour. */
function sample(wx, wz, out, o) {
  const sea = terrain.seaLevel;
  const h = terrain.columnHeight(wx, wz);
  const biome = terrain.biomeAt(wx, wz, h);
  const ground = colors[terrain.surfacePalette(biome, h).top] ?? GREY;
  let y;
  let c;
  if (h < sea) {
    // Real water is see-through (terrainMaterial.js), and the floor under it
    // loses sky light two levels a block (light.js): shallows take on the
    // colour of their floor, and by five blocks down the floor is dark.
    // Matched by eye against the chunk water beside it.
    y = sea + 0.85;
    const water = colors[WATER.id] ?? [0.02, 0.06, 0.3];
    const floor = 0.55 * Math.max(0.05, 1 - (sea - h - 1) / 4);
    c = [0, 1, 2].map((i) => water[i] * 0.7 + ground[i] * floor);
  } else {
    y = h + 1;
    c = ground;
    // Trees as a canopy laid over the ground, as thick as the biome is wooded:
    // a forest becomes a raised blanket of leaves, a plain stays nearly bare.
    // Single trees would be spikes at this spacing. The hash roughens the top
    // a little, the way crowns of different heights do.
    const style = h > sea + 1 ? terrain.treeStyle(biome) : null;
    if (style) {
      const cover = Math.min(0.95, style.chance * 1.15);
      const crown = (hash2i(wx, wz, 0x7ee5) & 0xffff) / 0x10000;
      const [lo, hi] = style.height;
      y += cover * ((lo + hi) / 2 + (crown - 0.5) * 2.5);
      const leaf = colors[LEAVES_BY_WOOD[style.wood]] ?? ground;
      // Darker than a leaf on average: from afar you see the shade between crowns too.
      const shade = 0.7 + crown * 0.3;
      c = [0, 1, 2].map((i) => ground[i] + (leaf[i] * shade - ground[i]) * cover);
    }
  }
  out.heights[o] = y;
  out.cols[o * 3] = c[0];
  out.cols[o * 3 + 1] = c[1];
  out.cols[o * 3 + 2] = c[2];
}

function buildTile(tx, tz, step) {
  const n = FAR_TILE / step + 1;
  const baseX = tx * FAR_TILE;
  const baseZ = tz * FAR_TILE;
  const grid = { heights: new Float32Array(n * n), cols: new Float32Array(n * n * 3) };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) sample(baseX + i * step, baseZ + j * step, grid, j * n + i);
  }

  const edge = 4 * (n - 1);
  const vertexCount = n * n + edge * 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colours = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(((n - 1) * (n - 1) + edge) * 6);

  const H = (i, j) => grid.heights[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  let v = 0;
  const put = (x, y, z, nx, ny, nz, r, g, b) => {
    positions.set([x, y, z], v * 3);
    normals.set([nx, ny, nz], v * 3);
    colours.set([r, g, b], v * 3);
    return v++;
  };

  // The surface, with normals from the neighbouring heights.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
      const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      const len = Math.hypot(dx, 1, dz);
      const o = j * n + i;
      put(i * step, grid.heights[o], j * step, -dx / len, 1 / len, -dz / len,
        grid.cols[o * 3], grid.cols[o * 3 + 1], grid.cols[o * 3 + 2]);
    }
  }
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }

  // Skirts round the rim, hanging straight down, darker the way cliffs are.
  const rim = [];
  for (let i = 0; i < n - 1; i++) rim.push([i, 0]);
  for (let j = 0; j < n - 1; j++) rim.push([n - 1, j]);
  for (let i = n - 1; i > 0; i--) rim.push([i, n - 1]);
  for (let j = n - 1; j > 0; j--) rim.push([0, j]);
  const shade = 0.6;
  for (let e = 0; e < rim.length; e++) {
    const [i, j] = rim[e];
    const o = j * n + i;
    const [r, g, b] = [grid.cols[o * 3] * shade, grid.cols[o * 3 + 1] * shade, grid.cols[o * 3 + 2] * shade];
    const top = put(i * step, grid.heights[o], j * step, 0, 0.3, 0, r, g, b);
    const bottom = put(i * step, grid.heights[o] - SKIRT, j * step, 0, 0.3, 0, r, g, b);
    // A quad from this rim point to the next one round (wrapping at the end).
    const next = n * n + ((e + 1) % rim.length) * 2;
    indices.set([top, bottom, next, next, bottom, next + 1], k);
    k += 6;
  }

  return { positions, normals, colors: colours, indices: indices.subarray(0, k).slice() };
}
