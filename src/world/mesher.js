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

import {
  CHUNK_SX, CHUNK_SY, CHUNK_SZ,
  PAD_SX, PAD_SY, PAD_SZ, PAD_VOLUME, padIndex,
} from './chunk.js';
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

/** Neighbours a partial block samples for light, since its own cell reads dark. */
const SHAPE_LIGHT_PROBES = [
  [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
];

// ---------------------------------------------------------------------------
// Padded voxel snapshot
// ---------------------------------------------------------------------------
// Meshing needs to read one voxel *outside* the chunk in every direction (for
// face culling) and diagonally (for AO). Rather than paying a function call per
// lookup, we copy the chunk plus a 1-voxel skirt into a flat padded array once,
// then mesh from that with plain integer indexing.

// Padded addressing is shared with the light engine via chunk.js so the two
// index the same volume identically.

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

/** Padded block-light volume for the chunk being meshed, or null if unlit. */
let chunkLight = null;

const MAX_BLOCK_LIGHT = 15;

/**
 * Combined lighting: the brighter of daylight reaching this cell and any
 * torchlight falling on it.
 *
 * The light volume is padded, so border samples are exact rather than clamped
 * back inside the chunk — clamping produced a visible seam wherever a torch sat
 * near a chunk edge.
 */
function lightAt(x, y, z) {
  const sky = skyExposure(x, y, z);
  if (!chunkLight) return sky;
  if (y < -1 || y > CHUNK_SY) return sky;
  if (x < -1 || x > CHUNK_SX || z < -1 || z > CHUNK_SZ) return sky;

  const level = chunkLight[padIndex(x, y, z)];
  if (level === 0) return sky;

  // Level 15 is not quite daylight — torchlight is warm and local, and letting
  // it hit 1.0 makes torch-lit rooms look flat.
  const block = 0.12 + (level / MAX_BLOCK_LIGHT) * 0.82;
  return sky > block ? sky : block;
}

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
        // Plants are two crossed quads, not a box. A crop drawn as a cube wraps
        // its texture onto the top and sides, so a wheat field reads as a wall
        // of blocks with wheat printed on the lid.
        if (block.cross) {
          emitCross(target, block, x, y, z, tileSpan, inset);
          continue;
        }

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
 * Emit a plant: two quads crossing diagonally through the cell, each drawn
 * from both sides.
 *
 * This is how Minecraft draws grass, crops and saplings, and the reason is
 * visual rather than technical — a plant rendered as a box shows its texture on
 * the lid, so a field of wheat looks like cubes with wheat printed on top
 * instead of stalks you can see between.
 *
 * The quads are inset from the cell walls so neighbouring plants do not sit
 * flush against each other, and `height` lets a young crop be short without
 * needing its own geometry.
 */
function emitCross(buf, block, x, y, z, tileSpan, inset) {
  const tile = block.tiles[FACE_PY];
  const tileCol = tile % ATLAS_COLS;
  const tileRow = Math.floor(tile / ATLAS_COLS);
  const u0 = tileCol * tileSpan;
  const v0 = 1 - (tileRow + 1) * tileSpan;

  // Plants take their light from the cell they occupy plus its open
  // neighbours, the same as any other partial block.
  let sky = lightAt(x, y, z);
  for (const [dx, dy, dz] of SHAPE_LIGHT_PROBES) {
    const neighbour = padded[padIndex(x + dx, y + dy, z + dz)];
    const def = BLOCKS[neighbour];
    if (def && def.opaque) continue;
    const value = lightAt(x + dx, y + dy, z + dz);
    if (value > sky) sky = value;
  }
  // No face tint: a plant has no single facing, and shading the two quads
  // differently makes it flicker as you walk around it.
  const shade = block.emissive ? 1 : sky;

  const h = block.crossHeight ?? 1;
  const m = 0.1;          // inset from the cell wall
  const lo = m, hi = 1 - m;

  // Two diagonals, each emitted twice with opposite winding so the plant is
  // visible from every angle without needing a double-sided material.
  const planes = [
    [[lo, lo], [hi, hi]],   // -X-Z to +X+Z
    [[hi, lo], [lo, hi]],   // +X-Z to -X+Z
  ];

  for (const [[ax, az], [bx, bz]] of planes) {
    for (let side = 0; side < 2; side++) {
      const start = buf.vertexCount;

      // Corner order: bottom-a, bottom-b, top-b, top-a.
      const corners = [
        [ax, 0, az, 0, 0],
        [bx, 0, bz, 1, 0],
        [bx, h, bz, 1, 1],
        [ax, h, az, 0, 1],
      ];

      for (const [cx, cy, cz, uu, vv] of corners) {
        buf.positions.push(x + cx, y + cy, z + cz);
        // A flat normal per plane; plants are unlit-ish so this only matters
        // for anything sampling normals later.
        buf.normals.push(0, 1, 0);
        buf.colors.push(shade, shade, shade);
        buf.uvs.push(
          u0 + inset + uu * (tileSpan - 2 * inset),
          v0 + inset + vv * (tileSpan - 2 * inset)
        );
      }

      buf.vertexCount += 4;
      if (side === 0) {
        buf.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      } else {
        buf.indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
      }
    }
  }
}

/**
 * Emit every face of every box in a partial block's shape.
 *
 * Shading uses the block's own cell for sky exposure (rather than the air cell
 * a full face would look at), and skips ambient occlusion — a sub-box's corners
 * do not line up with the voxel grid, so grid-based AO would look wrong.
 */
function emitShape(buf, block, x, y, z, tileSpan, inset) {
  // A partial block sits inside its own cell, and that cell reads as buried
  // because the height map counts it as ground. Sampling only there made slabs
  // and stairs noticeably darker than the full blocks beside them, so take the
  // brightest of the cell itself and its open neighbours instead.
  let sky = lightAt(x, y, z);
  for (const [dx, dy, dz] of SHAPE_LIGHT_PROBES) {
    const neighbour = padded[padIndex(x + dx, y + dy, z + dz)];
    const def = BLOCKS[neighbour];
    if (def && def.opaque) continue;
    const value = lightAt(x + dx, y + dy, z + dz);
    if (value > sky) sky = value;
  }

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
  const faceLight = lightAt(nx, ny, nz);

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

    // Smooth lighting: average the light of the four cells meeting at this
    // corner rather than using one value for the whole quad. A single per-face
    // value makes every block a flat tile and torchlight fall off in visible
    // steps; averaging turns it into a gradient. Occluded cells are skipped so
    // light does not bleed through solid corners.
    let sum = faceLight;
    let count = 1;
    if (!s1) { sum += lightAt(nx + su * ux, ny + su * uy, nz + su * uz); count++; }
    if (!s2) { sum += lightAt(nx + sv * vx, ny + sv * vy, nz + sv * vz); count++; }
    if (!cn && !(s1 && s2)) {
      sum += lightAt(nx + su * ux + sv * vx, ny + su * uy + sv * vy, nz + su * uz + sv * vz);
      count++;
    }
    const cornerLight = sum / count;

    // Emissive blocks (lava, torches) ignore lighting and occlusion entirely.
    const shade = block.emissive ? 1 : face.tint * cornerLight * AO_LEVELS[level];
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
