/**
 * mesher.js — Turns a chunk of voxels into GPU-ready buffers.
 *
 * Strategy: hidden-face culling. Only faces touching a non-opaque neighbour are
 * emitted, which typically removes >90% of the theoretical triangle count.
 *
 * Lighting is *baked into vertex colours* at mesh time:
 *   - ambient occlusion, from the 3 voxels around each vertex corner
 *   - sky exposure, from a per-column heightmap
 *   - a fixed per-face tint so the six cube directions read distinctly
 *
 * That means the runtime material can be an unlit MeshBasicMaterial: no
 * per-fragment light maths, and day/night is a single material colour multiply.
 *
 * Runs inside the worker — no Three.js imports allowed here.
 */

import { CHUNK_SX, CHUNK_SY, CHUNK_SZ } from './chunk.js';
import { BLOCKS, AIR, ATLAS_COLS, FACE_PY, FACE_NY } from './blocks.js';

// ---------------------------------------------------------------------------
// Face table
// ---------------------------------------------------------------------------
// For each face: outward normal `n`, and two tangent axes `u`,`v` chosen so
// that u x v == n (giving counter-clockwise winding when viewed from outside)
// and `v` points up for the four side faces (so textures are never upside-down).
const FACES = [
  { n: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0],  tint: 0.82 }, // +X
  { n: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0],  tint: 0.82 }, // -X
  { n: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1], tint: 1.00 }, // +Y (brightest)
  { n: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1],  tint: 0.55 }, // -Y (darkest)
  { n: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0],  tint: 0.92 }, // +Z
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0],  tint: 0.92 }, // -Z
];

/** The four quad corners, as (su, sv) signs in the face's tangent plane. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** AO level -> brightness multiplier. Index 0 = fully occluded corner. */
const AO_LEVELS = [0.45, 0.62, 0.80, 1.0];

// ---------------------------------------------------------------------------
// Padded voxel snapshot
// ---------------------------------------------------------------------------
// Meshing needs to read one voxel *outside* the chunk in every direction (for
// face culling) and diagonally (for AO). Rather than paying a function call per
// lookup, we copy the chunk plus a 1-voxel skirt into a flat padded array once,
// then mesh from that with plain integer indexing.

const PAD_SX = CHUNK_SX + 2;
const PAD_SZ = CHUNK_SZ + 2;
const PAD_SY = CHUNK_SY + 2;
const PAD_VOLUME = PAD_SX * PAD_SY * PAD_SZ;

/** Index into the padded array. Local coords may range from -1 to SIZE. */
function padIndex(x, y, z) {
  return (x + 1) + PAD_SX * ((z + 1) + PAD_SZ * (y + 1));
}

// Reused across calls so we are not allocating ~42 KB per chunk mesh.
const padded = new Uint8Array(PAD_VOLUME);
// Highest opaque block per padded column, for the sky-exposure term.
const heightMap = new Int16Array(PAD_SX * PAD_SZ);

/**
 * Fill the padded snapshot.
 * @param {(wx:number,wy:number,wz:number)=>number} sampleBlock world-space getter
 */
function buildPaddedSnapshot(sampleBlock, cx, cz) {
  padded.fill(0);
  const baseX = cx * CHUNK_SX;
  const baseZ = cz * CHUNK_SZ;

  for (let z = -1; z <= CHUNK_SZ; z++) {
    for (let x = -1; x <= CHUNK_SX; x++) {
      let highest = -1;
      for (let y = -1; y <= CHUNK_SY; y++) {
        // The y = -1 skirt mirrors the floor block rather than reading as air.
        // Otherwise every chunk emits 256 downward faces beneath the bedrock
        // layer — geometry that is permanently invisible but still costs
        // 512 triangles per chunk to build, upload and cull.
        const id =
          y >= CHUNK_SY ? AIR
          : y < 0 ? sampleBlock(baseX + x, 0, baseZ + z)
          : sampleBlock(baseX + x, y, baseZ + z);
        if (id !== AIR) {
          padded[padIndex(x, y, z)] = id;
          const block = BLOCKS[id];
          if (block && block.opaque && y > highest) highest = y;
        }
      }
      heightMap[(x + 1) + PAD_SX * (z + 1)] = highest;
    }
  }
}

/**
 * How lit a voxel position is from the sky, based on how deeply buried it is.
 *
 * The floor is deliberately very dark. It used to be 0.32, which made caves
 * dim-but-navigable and left torches pointless; now an unlit cave really is
 * dark and a light source is worth carrying.
 */
function skyExposure(x, y, z) {
  const top = heightMap[(x + 1) + PAD_SX * (z + 1)];
  if (y > top) return 1.0; // open to the sky
  const depth = top - y;
  const light = 1.0 - depth * 0.11;
  return light < 0.10 ? 0.10 : light;
}

/** Block-light array for the chunk being meshed, or null if nothing lights it. */
let chunkLight = null;

/**
 * Combined lighting: the brighter of daylight reaching this cell and any
 * torchlight falling on it.
 */
function lightAt(x, y, z) {
  const sky = skyExposure(x, y, z);
  if (!chunkLight) return sky;

  // Block light is only stored for this chunk, so border samples clamp inward.
  // A one-voxel inaccuracy at a chunk seam is invisible next to the cost of
  // carrying a padded light volume around.
  const cx = x < 0 ? 0 : x >= CHUNK_SX ? CHUNK_SX - 1 : x;
  const cz = z < 0 ? 0 : z >= CHUNK_SZ ? CHUNK_SZ - 1 : z;
  if (y < 0 || y >= CHUNK_SY) return sky;

  const level = chunkLight[cx + CHUNK_SX * (cz + CHUNK_SZ * y)];
  if (level === 0) return sky;

  // Level 15 is not quite daylight — torchlight is warm and local, and letting
  // it hit 1.0 makes torch-lit rooms look flat.
  const block = 0.12 + (level / MAX_BLOCK_LIGHT) * 0.82;
  return sky > block ? sky : block;
}

const MAX_BLOCK_LIGHT = 15;

/**
 * Classic Minecraft-style vertex AO from the three voxels surrounding a corner.
 * Two occluding sides always fully darken the corner regardless of the diagonal.
 */
function vertexAO(side1, side2, corner) {
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + corner);
}

function isOpaqueId(id) {
  const b = BLOCKS[id];
  return b ? b.opaque : false;
}

/**
 * Render height of a fluid voxel, 0..1.
 *
 * A fluid with more of the same fluid directly above it is submerged, so it
 * fills its whole cube — that keeps a waterfall or a deep pool solid instead of
 * showing a stack of tapered slabs.
 */
function fluidHeightAt(x, y, z, fluid) {
  const above = BLOCKS[padded[padIndex(x, y + 1, z)]];
  if (above && above.fluid && above.fluid.family === fluid.family) return 1;
  return fluid.height;
}

// ---------------------------------------------------------------------------
// Mesh accumulator
// ---------------------------------------------------------------------------

class MeshBuffer {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.colors = [];
    this.indices = [];
    this.vertexCount = 0;
  }

  get isEmpty() {
    return this.indices.length === 0;
  }

  /** Pack into transferable typed arrays. */
  toGeometry() {
    if (this.isEmpty) return null;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      // >65535 vertices per chunk is common, so 32-bit indices always.
      indices: new Uint32Array(this.indices),
    };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build the render geometry for one chunk.
 *
 * @param {(wx:number,wy:number,wz:number)=>number} sampleBlock
 *        World-space block getter, valid one voxel beyond the chunk bounds.
 * @param {number} cx chunk X
 * @param {number} cz chunk Z
 * @returns {{opaque: object|null, water: object|null}} transferable geometry
 */
export function buildChunkMesh(sampleBlock, cx, cz, blockLight = null) {
  buildPaddedSnapshot(sampleBlock, cx, cz);
  chunkLight = blockLight;

  // Two passes share one traversal: solid/cutout blocks and liquids need
  // different materials (alpha-test vs. alpha-blend) so they get separate meshes.
  const opaque = new MeshBuffer();
  const water = new MeshBuffer();

  // Half-texel inset stops the sampler bleeding into neighbouring atlas tiles.
  const tileSpan = 1 / ATLAS_COLS;
  const inset = 0.5 / (ATLAS_COLS * 16);

  for (let y = 0; y < CHUNK_SY; y++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const id = padded[padIndex(x, y, z)];
        if (id === AIR) continue;

        const block = BLOCKS[id];
        if (!block) continue;

        // Water is alpha-blended; lava is opaque despite also being a fluid.
        const target = block.translucent ? water : opaque;

        // Partial blocks (slabs, stairs, fences, doors...) are built box by box
        // rather than as a single cube. Each box always emits all six of its
        // faces: a sub-box does not fill the cell, so there is no neighbour
        // relationship that could safely hide one.
        if (block.shape) {
          emitShape(target, block, x, y, z, tileSpan, inset);
          continue;
        }

        const fluid = block.fluid;
        const height = fluid ? fluidHeightAt(x, y, z, fluid) : 1;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nx = x + face.n[0];
          const ny = y + face.n[1];
          const nz = z + face.n[2];
          const neighborId = padded[padIndex(nx, ny, nz)];
          const neighbor = BLOCKS[neighborId];

          let emit;
          if (fluid && neighbor && neighbor.fluid && neighbor.fluid.family === fluid.family) {
            // Interface between two cells of the same fluid.
            if (f === FACE_PY || f === FACE_NY) {
              emit = false; // horizontal interfaces are always hidden
            } else {
              // Only the taller of the two draws the shared side wall. That
              // closes the gap a height difference would otherwise leave,
              // without double-drawing coplanar faces.
              emit = fluidHeightAt(nx, ny, nz, neighbor.fluid) < height - 1e-4;
            }
          } else {
            emit = shouldEmitFace(id, block, neighborId);
          }
          if (!emit) continue;

          emitFace(target, block, face, f, x, y, z, nx, ny, nz, tileSpan, inset, height);
        }
      }
    }
  }

  return { opaque: opaque.toGeometry(), water: water.toGeometry() };
}

/**
 * Emit every face of every box in a partial block's shape.
 *
 * Shading uses the block's own cell for sky exposure (rather than the air cell
 * a full face would look at), and skips ambient occlusion — a sub-box's corners
 * do not line up with the voxel grid, so grid-based AO would look wrong.
 */
function emitShape(buf, block, x, y, z, tileSpan, inset) {
  const sky = lightAt(x, y, z);

  for (const box of block.shape) {
    const [x0, y0, z0, x1, y1, z1] = box;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const tile = block.tiles[f];
      const tileCol = tile % ATLAS_COLS;
      const tileRow = Math.floor(tile / ATLAS_COLS);
      const u0 = tileCol * tileSpan;
      const v0 = 1 - (tileRow + 1) * tileSpan;

      const shade = block.emissive ? 1 : face.tint * sky;
      const [ax, ay, az] = face.n;

      const start = buf.vertexCount;
      for (let c = 0; c < 4; c++) {
        const su = CORNERS[c][0];
        const sv = CORNERS[c][1];

        // Corner in unit-cube space, then remapped into the box's extent.
        const unit = [
          0.5 + 0.5 * ax + 0.5 * su * face.u[0] + 0.5 * sv * face.v[0],
          0.5 + 0.5 * ay + 0.5 * su * face.u[1] + 0.5 * sv * face.v[1],
          0.5 + 0.5 * az + 0.5 * su * face.u[2] + 0.5 * sv * face.v[2],
        ];

        buf.positions.push(
          x + x0 + unit[0] * (x1 - x0),
          y + y0 + unit[1] * (y1 - y0),
          z + z0 + unit[2] * (z1 - z0)
        );
        buf.normals.push(ax, ay, az);
        buf.colors.push(shade, shade, shade);

        // Crop the texture to the box's extent so a slab shows the bottom half
        // of its side texture rather than a squashed copy of the whole thing.
        let lu = (su + 1) * 0.5;
        let lv = (sv + 1) * 0.5;
        if (ay === 0) {
          // Side face: V follows height, U follows whichever axis is tangent.
          lv = y0 + lv * (y1 - y0);
          const spanU = Math.abs(face.u[0]) > 0 ? [x0, x1] : [z0, z1];
          lu = spanU[0] + lu * (spanU[1] - spanU[0]);
        } else {
          lu = x0 + lu * (x1 - x0);
          lv = z0 + lv * (z1 - z0);
        }

        buf.uvs.push(
          u0 + inset + lu * (tileSpan - 2 * inset),
          v0 + inset + lv * (tileSpan - 2 * inset)
        );
      }

      buf.vertexCount += 4;
      buf.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
}

/** Face visibility rule — the heart of the culling. */
function shouldEmitFace(id, block, neighborId) {
  if (neighborId === AIR) return true;
  const neighbor = BLOCKS[neighborId];
  if (!neighbor) return true;
  // An opaque neighbour hides this face completely.
  if (neighbor.opaque) return false;
  // Two touching blocks of the same see-through type hide their shared face,
  // unless the block opted out (leaves keep interior faces so trees look full).
  if (neighborId === id) return !block.cullSameType;
  // Anything else against a see-through neighbour stays visible — culling here
  // would punch holes in water seen through glass or leaves.
  return true;
}

/**
 * Append one quad (4 verts, 2 tris) to the buffer.
 * `height` (0..1) squashes the cube vertically — used for tapered fluid levels.
 */
function emitFace(buf, block, face, faceIndex, x, y, z, nx, ny, nz, tileSpan, inset, height = 1) {
  const tile = block.tiles[faceIndex];
  const tileCol = tile % ATLAS_COLS;
  const tileRow = Math.floor(tile / ATLAS_COLS);
  const u0 = tileCol * tileSpan;
  // Canvas textures are uploaded flipped, so row 0 sits at the TOP of the atlas
  // but at V = 1 in UV space.
  const v0 = 1 - (tileRow + 1) * tileSpan;

  // Light is sampled on the *air* side of the face — that is the side the light
  // would actually arrive from.
  const sky = lightAt(nx, ny, nz);
  const base = face.tint * sky;

  const [ax, ay, az] = face.n;
  const [ux, uy, uz] = face.u;
  const [vx, vy, vz] = face.v;

  const startVertex = buf.vertexCount;
  const ao = [0, 0, 0, 0];

  for (let c = 0; c < 4; c++) {
    const su = CORNERS[c][0];
    const sv = CORNERS[c][1];

    // Position: block corner + half a unit along normal and each tangent.
    const px = x + 0.5 + 0.5 * ax + 0.5 * su * ux + 0.5 * sv * vx;
    let py = y + 0.5 + 0.5 * ay + 0.5 * su * uy + 0.5 * sv * vy;
    const pz = z + 0.5 + 0.5 * az + 0.5 * su * uz + 0.5 * sv * vz;
    // Squash toward the voxel floor. Bottom vertices (py == y) are unaffected,
    // top vertices (py == y + 1) land at y + height.
    if (height !== 1) py = y + (py - y) * height;
    buf.positions.push(px, py, pz);
    buf.normals.push(ax, ay, az);

    // AO samples live in the plane of the neighbouring (air) voxel.
    const s1 = isOpaqueId(padded[padIndex(nx + su * ux, ny + su * uy, nz + su * uz)]) ? 1 : 0;
    const s2 = isOpaqueId(padded[padIndex(nx + sv * vx, ny + sv * vy, nz + sv * vz)]) ? 1 : 0;
    const cn = isOpaqueId(
      padded[padIndex(nx + su * ux + sv * vx, ny + su * uy + sv * vy, nz + su * uz + sv * vz)]
    ) ? 1 : 0;

    const level = vertexAO(s1, s2, cn);
    ao[c] = level;
    // Emissive blocks (lava) ignore sky light and occlusion entirely.
    const shade = block.emissive ? 1 : base * AO_LEVELS[level];
    buf.colors.push(shade, shade, shade);

    // UV: (su,sv) in [-1,1] -> [0,1], then mapped into the atlas tile.
    const lu = (su + 1) * 0.5;
    // On side faces, shorten the texture along with the quad so a tapered
    // fluid does not look vertically stretched. `ay != 0` means top/bottom.
    const lv = ((sv + 1) * 0.5) * (height !== 1 && ay === 0 ? height : 1);
    buf.uvs.push(
      u0 + inset + lu * (tileSpan - 2 * inset),
      v0 + inset + lv * (tileSpan - 2 * inset)
    );
  }

  buf.vertexCount += 4;

  // Choose the diagonal that keeps the AO gradient smooth. Splitting a quad the
  // wrong way produces the classic dark-triangle seam on inside corners.
  if (ao[0] + ao[2] > ao[1] + ao[3]) {
    buf.indices.push(
      startVertex, startVertex + 1, startVertex + 2,
      startVertex, startVertex + 2, startVertex + 3
    );
  } else {
    buf.indices.push(
      startVertex + 1, startVertex + 2, startVertex + 3,
      startVertex + 1, startVertex + 3, startVertex
    );
  }
}
