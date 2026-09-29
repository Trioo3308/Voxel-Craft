/**
 * mesher.js — Turns a chunk of voxels into GPU-ready buffers.
 *
 * Strategy: hidden-face culling, then greedy merging. Only faces touching a
 * non-opaque neighbour are emitted, which typically removes >90% of the
 * theoretical triangle count; flat runs of identical faces are then merged into
 * single quads (see "Greedy merging" below).
 *
 * Light is *measured* here and *applied* in the shader. Each vertex carries
 * three channels in its colour attribute:
 *   r  sky exposure, from a per-column heightmap
 *   g  torchlight, from the flood-filled block-light volume
 *   b  ambient occlusion, from the 3 voxels around the vertex corner
 *      (3.0 marks an emissive block, which ignores all three)
 * plus an `fx` byte pair for wind sway and water (see terrainMaterial.js).
 *
 * These used to be merged into one baked brightness. Keeping them apart is
 * what lets the renderer give torches warm light, the sky cool light, and the
 * sun real shadows on top.
 *
 * Texture coordinates are block-local rather than positions in the atlas: `uv`
 * counts blocks across the face, so a quad merged from five blocks runs 0..5,
 * and a `tile` attribute names the atlas tile to repeat across it. The shader
 * turns the pair into an atlas lookup (terrainMaterial.js). That is what lets
 * one quad cover many blocks, and it is also what let the atlas grow beyond a
 * square.
 *
 * Runs inside the worker — no Three.js imports allowed here.
 */

import {
  CHUNK_SX, CHUNK_SY, CHUNK_SZ, CHUNK_VOLUME,
  PAD_SX, PAD_SY, PAD_SZ, PAD_VOLUME, padIndex,
} from './chunk.js';
import {
  BLOCKS, AIR, FACE_PY, FACE_NY, ATLAS_COLS, ATLAS_ROWS,
  ALT_TILE_OFFSET, NATURAL_TILES, VARIANT_TILES, LEAF_TILES, TILE_NATURAL, TILE_VARIED,
} from './blocks.js';

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

/**
 * How far a quad's UVs are pulled in from its edges. The shader wraps block-
 * local UVs with fract(), which jumps from 1 back to 0 exactly on a block edge;
 * pulled in by a hair, the far edge of a face can never sample the near side of
 * its texture.
 */
const UV_EPS = 1e-3;

/** Clamp a 0..1 texture coordinate clear of the wrap at either end. */
function edgeSafe(t) {
  return t < UV_EPS ? UV_EPS : t > 1 - UV_EPS ? 1 - UV_EPS : t;
}

/** AO level -> brightness multiplier. Index 0 = fully occluded corner. */
const AO_LEVELS = [0.45, 0.62, 0.80, 1.0];

/**
 * What a full face writes to the `tile` attribute: the tile, plus flags telling
 * the shader it may turn, flip or swap the texture per block (see blocks.js).
 */
const TILE_CODE = new Uint16Array(ATLAS_COLS * ATLAS_ROWS);
for (let t = 0; t < TILE_CODE.length; t++) TILE_CODE[t] = t;
for (const t of NATURAL_TILES) TILE_CODE[t] |= TILE_NATURAL;
for (const t of VARIANT_TILES) TILE_CODE[t] |= TILE_VARIED;

/** Block ids drawn with a leaf texture, for fast leaves. */
const LEAF_BLOCK = new Uint8Array(256);
for (const block of BLOCKS) {
  if (block && block.tiles && LEAF_TILES.includes(block.tiles[FACE_PY])) LEAF_BLOCK[block.id] = 1;
}

/** Geometry options set from the main thread; see setMesherOptions. */
const options = { fastLeaves: false };

/**
 * fastLeaves: leaf-to-leaf faces are culled and leaves use their opaque
 * painting, so a canopy becomes one solid shell at a fraction of the triangles.
 * The Low graphics tier turns it on.
 */
export function setMesherOptions(next) {
  if (typeof next.fastLeaves === 'boolean') options.fastLeaves = next.fastLeaves;
}

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

/**
 * Torchlight at a padded position, 0..1.
 *
 * Kept apart from sky light now: the renderer lights the two differently (warm
 * torches, cool sky, a sun that casts shadows), so merging them here into one
 * brightness, as this used to, would throw that away.
 */
function torchAt(x, y, z) {
  if (!chunkLight) return 0;
  if (y < -1 || y > CHUNK_SY) return 0;
  if (x < -1 || x > CHUNK_SX || z < -1 || z > CHUNK_SZ) return 0;
  return chunkLight[padIndex(x, y, z)] / MAX_BLOCK_LIGHT;
}

/**
 * Sky and torch light for a partial block or plant: the brightest of its own
 * cell and its open neighbours, since its own cell reads as buried.
 */
function probeLight(x, y, z) {
  let sky = skyExposure(x, y, z);
  let torch = torchAt(x, y, z);
  for (const [dx, dy, dz] of SHAPE_LIGHT_PROBES) {
    const def = BLOCKS[padded[padIndex(x + dx, y + dy, z + dz)]];
    if (def && def.opaque) continue;
    const s = skyExposure(x + dx, y + dy, z + dz);
    const t = torchAt(x + dx, y + dy, z + dz);
    if (s > sky) sky = s;
    if (t > torch) torch = t;
  }
  return [sky, torch];
}

/** How a vertex sways and what surface it is on. See terrainMaterial.js. */
const FX_NONE = 0;
const FX_UNDERWATER = 128;
const FX_SURFACE = 255;
/** Leaves wobble as whole blocks; plants bend from the root. */
const SWAY_LEAVES = 80;
const SWAY_PLANT = 255;

function isWaterId(id) {
  const def = BLOCKS[id];
  return !!(def && def.fluid && def.fluid.family === 'water');
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
    /** Two bytes per vertex: sway weight, then surface flag. */
    this.fx = [];
    /** Atlas tile per vertex; the shader repeats it across the quad. */
    this.tiles = [];
    this.indices = [];
    this.vertexCount = 0;
  }

  get isEmpty() {
    return this.indices.length === 0;
  }

  /** Append one vertex. `u`,`v` are block-local; see the header. */
  vertex(px, py, pz, nx, ny, nz, u, v, sky, torch, occ, sway, flag, tile) {
    this.positions.push(px, py, pz);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.colors.push(sky, torch, occ);
    this.fx.push(sway, flag);
    this.tiles.push(tile);
    this.vertexCount++;
  }

  /** Pack into transferable typed arrays. */
  toGeometry() {
    if (this.isEmpty) return null;
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      fx: new Uint8Array(this.fx),
      tiles: new Uint16Array(this.tiles),
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
  resetMergeMask();

  // Two passes share one traversal: solid/cutout blocks and liquids need
  // different materials (alpha-test vs. alpha-blend) so they get separate meshes.
  const opaque = new MeshBuffer();
  const water = new MeshBuffer();

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
          emitCross(target, block, x, y, z);
          continue;
        }

        if (block.shape) {
          emitShape(target, block, x, y, z);
          continue;
        }

        const fluid = block.fluid;
        const height = fluid ? fluidHeightAt(x, y, z, fluid) : 1;
        const sway = block.decays === true ? SWAY_LEAVES : 0;
        // Only still, solid cubes merge. Fluids taper and ripple, translucent
        // blocks blend, and leaves sway block by block; each of those keeps
        // its own quads.
        const mergeable = !fluid && target === opaque && sway === 0;
        // Fast leaves: the canopy is one opaque shell.
        const solidLeaf = options.fastLeaves && LEAF_BLOCK[id] === 1;

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
          if (solidLeaf && LEAF_BLOCK[neighborId] === 1) continue;

          const tile = solidLeaf ? block.tiles[f] + ALT_TILE_OFFSET : TILE_CODE[block.tiles[f]];
          measureFace(face, nx, ny, nz);
          const flag = surfaceFlag(block, face, x, y, z, nx, ny, nz);
          if (mergeable && (block.emissive || cornersUniform())) {
            parkFace(tile, block.emissive, f, x, y, z, flag);
          } else {
            emitFace(target, block, face, tile, x, y, z, height, flag, sway);
          }
        }
      }
    }
  }

  sweepMergeMask(opaque);

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
function emitCross(buf, block, x, y, z) {
  const tile = block.tiles[FACE_PY];

  // Plants take their light from the cell they occupy plus its open
  // neighbours, the same as any other partial block. No face tint: a plant has
  // no single facing, and shading its two quads differently makes it flicker
  // as you walk around it (the shader tints by normal, and these point up).
  const [sky, torch] = block.emissive ? [1, 1] : probeLight(x, y, z);
  const occ = block.emissive ? 3 : 1;

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
        // A flat normal per plane; plants are unlit-ish so this only matters
        // for anything sampling normals later. Rooted at the bottom: only the
        // top edge moves in the wind.
        buf.vertex(
          x + cx, y + cy, z + cz, 0, 1, 0,
          edgeSafe(uu), edgeSafe(vv),
          sky, torch, occ,
          cy > 0 ? SWAY_PLANT : 0, FX_NONE, tile
        );
      }

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
function emitShape(buf, block, x, y, z) {
  // A partial block sits inside its own cell, and that cell reads as buried
  // because the height map counts it as ground. Sampling only there made slabs
  // and stairs noticeably darker than the full blocks beside them, so take the
  // brightest of the cell itself and its open neighbours instead.
  const [sky, torch] = block.emissive ? [1, 1] : probeLight(x, y, z);
  const occ = block.emissive ? 3 : 1;

  for (const box of block.shape) {
    const [x0, y0, z0, x1, y1, z1] = box;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const tile = block.tiles[f];
      const [ax, ay, az] = face.n;

      const start = buf.vertexCount;
      for (let c = 0; c < 4; c++) {
        const su = CORNERS[c][0];
        const sv = CORNERS[c][1];

        // Corner in unit-cube space, then remapped into the box's extent.
        const ux = 0.5 + 0.5 * ax + 0.5 * su * face.u[0] + 0.5 * sv * face.v[0];
        const uy = 0.5 + 0.5 * ay + 0.5 * su * face.u[1] + 0.5 * sv * face.v[1];
        const uz = 0.5 + 0.5 * az + 0.5 * su * face.u[2] + 0.5 * sv * face.v[2];

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

        buf.vertex(
          x + x0 + ux * (x1 - x0),
          y + y0 + uy * (y1 - y0),
          z + z0 + uz * (z1 - z0),
          ax, ay, az,
          edgeSafe(lu), edgeSafe(lv),
          sky, torch, occ,
          0, FX_NONE, tile
        );
      }

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

// ---------------------------------------------------------------------------
// Full faces
// ---------------------------------------------------------------------------

// Light at each corner of the face last measured. Filled by measureFace and
// read straight after, so measuring allocates nothing.
const cornerSky = new Float64Array(4);
const cornerTorch = new Float64Array(4);
const cornerAO = new Uint8Array(4);

/**
 * Measure the light at a full face's four corners, from the air cell
 * (nx, ny, nz) in front of it — that is the side the light would actually
 * arrive from.
 */
function measureFace(face, nx, ny, nz) {
  const [ux, uy, uz] = face.u;
  const [vx, vy, vz] = face.v;
  const faceSky = skyExposure(nx, ny, nz);
  const faceTorch = torchAt(nx, ny, nz);

  for (let c = 0; c < 4; c++) {
    const su = CORNERS[c][0];
    const sv = CORNERS[c][1];

    // AO samples live in the plane of the neighbouring (air) voxel: the two
    // cells beside the corner and the one diagonally across it.
    const ax = nx + su * ux, ay = ny + su * uy, az = nz + su * uz;
    const bx = nx + sv * vx, by = ny + sv * vy, bz = nz + sv * vz;
    const dx = ax + sv * vx, dy = ay + sv * vy, dz = az + sv * vz;
    const s1 = isOpaqueId(padded[padIndex(ax, ay, az)]) ? 1 : 0;
    const s2 = isOpaqueId(padded[padIndex(bx, by, bz)]) ? 1 : 0;
    const cn = isOpaqueId(padded[padIndex(dx, dy, dz)]) ? 1 : 0;
    cornerAO[c] = vertexAO(s1, s2, cn);

    // Smooth lighting: average the light of the four cells meeting at this
    // corner rather than using one value for the whole quad. A single per-face
    // value makes every block a flat tile and torchlight fall off in visible
    // steps; averaging turns it into a gradient. Occluded cells are skipped so
    // light does not bleed through solid corners.
    let skySum = faceSky;
    let torchSum = faceTorch;
    let count = 1;
    if (!s1) {
      skySum += skyExposure(ax, ay, az);
      torchSum += torchAt(ax, ay, az);
      count++;
    }
    if (!s2) {
      skySum += skyExposure(bx, by, bz);
      torchSum += torchAt(bx, by, bz);
      count++;
    }
    if (!cn && !(s1 && s2)) {
      skySum += skyExposure(dx, dy, dz);
      torchSum += torchAt(dx, dy, dz);
      count++;
    }
    cornerSky[c] = skySum / count;
    cornerTorch[c] = torchSum / count;
  }
}

/** True when the measured face has the same light at all four corners. */
function cornersUniform() {
  const ao = cornerAO[0], sky = cornerSky[0], torch = cornerTorch[0];
  for (let c = 1; c < 4; c++) {
    if (cornerAO[c] !== ao || cornerSky[c] !== sky || cornerTorch[c] !== torch) return false;
  }
  return true;
}

/**
 * What a face is, for the shader: a water surface, a floor under water that
 * catches caustics, or neither.
 */
function surfaceFlag(block, face, x, y, z, nx, ny, nz) {
  const water = isWaterId(block.id);
  if (water && face.n[1] === 1 && !isWaterId(padded[padIndex(x, y + 1, z)])) return FX_SURFACE;
  if (!water && isWaterId(padded[padIndex(nx, ny, nz)])) return FX_UNDERWATER;
  return FX_NONE;
}

/**
 * Append one full face as its own quad (4 verts, 2 tris), lit by the last
 * measureFace call. `tile` is the attribute value (tile plus flags); `height`
 * (0..1) squashes the cube vertically — used for tapered fluid levels.
 */
function emitFace(buf, block, face, tile, x, y, z, height, flag, sway) {
  const [ax, ay, az] = face.n;
  const [ux, uy, uz] = face.u;
  const [vx, vy, vz] = face.v;
  const start = buf.vertexCount;

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

    // Block-local UV: the position along the face's own tangent axes. That
    // keeps every texture the way up it always was, repeats it cleanly across
    // a merged quad, and crops (rather than squashes) the side of a tapered
    // fluid, since V follows the vertex's actual height.
    const u = px * ux + py * uy + pz * uz - su * UV_EPS;
    const v = px * vx + py * vy + pz * vz - sv * UV_EPS;

    // Emissive blocks (lava, torches) ignore lighting and occlusion entirely;
    // 3.0 in the occlusion channel is how the shader knows.
    if (block.emissive) {
      buf.vertex(px, py, pz, ax, ay, az, u, v, 1, 1, 3, sway, flag, tile);
    } else {
      buf.vertex(
        px, py, pz, ax, ay, az, u, v,
        cornerSky[c], cornerTorch[c], AO_LEVELS[cornerAO[c]],
        sway, flag, tile
      );
    }
  }

  // Choose the diagonal that keeps the AO gradient smooth. Splitting a quad the
  // wrong way produces the classic dark-triangle seam on inside corners.
  if (cornerAO[0] + cornerAO[2] > cornerAO[1] + cornerAO[3]) {
    buf.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  } else {
    buf.indices.push(start + 1, start + 2, start + 3, start + 1, start + 3, start);
  }
}

// ---------------------------------------------------------------------------
// Greedy merging
// ---------------------------------------------------------------------------
// A full face with the same light at all four corners looks exactly like any
// neighbour with the same tile, light and water flag, so a flat run of them can
// be drawn as one quad. Such faces are parked in a mask during the block pass,
// one layer per face direction, then swept slice by slice into the largest
// rectangles that fit.
//
// Anything with a gradient across it (an occluded corner, torchlight fading
// off) keeps its own quad, and those are exactly the faces whose look depends
// on per-vertex values. So merging never changes what the world looks like,
// only how many triangles it takes: open ground, cliff faces and cave walls
// collapse to a handful of quads.

/** The axis (0 = x, 1 = y, 2 = z) each face's normal and tangents run along. */
const FACE_AXES = FACES.map((face) => ({
  n: face.n.findIndex((c) => c !== 0),
  u: face.u.findIndex((c) => c !== 0),
  v: face.v.findIndex((c) => c !== 0),
}));

/** Mask cells run x fastest, then z, then y; one layer per face direction. */
const AXIS_STRIDE = [1, CHUNK_SX * CHUNK_SZ, CHUNK_SX];
const AXIS_SIZE = [CHUNK_SX, CHUNK_SY, CHUNK_SZ];
const MAX_SLICES = Math.max(CHUNK_SX, CHUNK_SY, CHUNK_SZ);

const MASK_SIZE = 6 * CHUNK_VOLUME;
/** Tile + 1 of the face parked in each cell and direction; 0 = none. */
const maskTile = new Uint16Array(MASK_SIZE);
const maskSky = new Float32Array(MASK_SIZE);
const maskTorch = new Float32Array(MASK_SIZE);
const maskOcc = new Float32Array(MASK_SIZE);
const maskFlag = new Uint8Array(MASK_SIZE);
/** Faces parked per direction and slice, so empty slices are skipped. */
const sliceCounts = new Uint16Array(6 * MAX_SLICES);
let parkedTotal = 0;

/**
 * The sweep consumes every face it is given, leaving the mask empty for the
 * next chunk; this only has work to do if a previous build was cut short.
 */
function resetMergeMask() {
  if (parkedTotal === 0) return;
  maskTile.fill(0);
  sliceCounts.fill(0);
  parkedTotal = 0;
}

/** Park the measured face `f` of the block at (x, y, z) for merging. */
function parkFace(tile, emissive, f, x, y, z, flag) {
  const i = f * CHUNK_VOLUME + x + AXIS_STRIDE[2] * z + AXIS_STRIDE[1] * y;
  maskTile[i] = tile + 1;
  if (emissive) {
    maskSky[i] = 1;
    maskTorch[i] = 1;
    maskOcc[i] = 3;
  } else {
    maskSky[i] = cornerSky[0];
    maskTorch[i] = cornerTorch[0];
    maskOcc[i] = AO_LEVELS[cornerAO[0]];
  }
  maskFlag[i] = flag;
  const slice = FACE_AXES[f].n === 0 ? x : FACE_AXES[f].n === 1 ? y : z;
  sliceCounts[f * MAX_SLICES + slice]++;
  parkedTotal++;
}

/** Whether mask cells i and j hold faces that would look identical. */
function sameFace(i, j) {
  return maskTile[j] === maskTile[i] &&
    maskSky[j] === maskSky[i] &&
    maskTorch[j] === maskTorch[i] &&
    maskOcc[j] === maskOcc[i] &&
    maskFlag[j] === maskFlag[i];
}

/** Merge every parked face into rectangles and emit them. */
function sweepMergeMask(buf) {
  if (parkedTotal === 0) return;

  for (let f = 0; f < 6; f++) {
    const axes = FACE_AXES[f];
    const strideA = AXIS_STRIDE[axes.u], sizeA = AXIS_SIZE[axes.u];
    const strideB = AXIS_STRIDE[axes.v], sizeB = AXIS_SIZE[axes.v];
    const strideS = AXIS_STRIDE[axes.n], sizeS = AXIS_SIZE[axes.n];

    for (let s = 0; s < sizeS; s++) {
      const countIndex = f * MAX_SLICES + s;
      if (sliceCounts[countIndex] === 0) continue;
      sliceCounts[countIndex] = 0;
      const sliceBase = f * CHUNK_VOLUME + s * strideS;

      for (let b = 0; b < sizeB; b++) {
        for (let a = 0; a < sizeA; a++) {
          const i = sliceBase + a * strideA + b * strideB;
          if (maskTile[i] === 0) continue;

          // Widen along A while the faces match, then extend along B while the
          // whole row does.
          let w = 1;
          while (a + w < sizeA && sameFace(i, i + w * strideA)) w++;
          let h = 1;
          grow: while (b + h < sizeB) {
            const row = i + h * strideB;
            for (let k = 0; k < w; k++) {
              if (!sameFace(i, row + k * strideA)) break grow;
            }
            h++;
          }

          emitMerged(buf, f, s, a, b, w, h, i);
          for (let r = 0; r < h; r++) {
            for (let k = 0; k < w; k++) maskTile[i + r * strideB + k * strideA] = 0;
          }
          a += w - 1;
        }
      }
    }
  }
  parkedTotal = 0;
}

/**
 * How far a merged quad reaches past its own edges. Where its edge runs past
 * the corners of smaller neighbouring quads (a T-junction), rounding in the
 * projection can open a hairline crack that shows the sky as a sparkling pixel.
 * Overlapping by a hair closes it; the overlap is far below a pixel and shows
 * the same surface it covers.
 */
const SEAM_OVERLAP = 2e-4;

// The merged rectangle's low and high corner, per axis. Scratch for emitMerged.
const rectLo = [0, 0, 0];
const rectHi = [0, 0, 0];

/**
 * Where a merged quad's corner (su, sv) sits along axis k: the low or high end
 * of the rectangle, whichever way the face's tangent points. That is the same
 * corner order a single face uses, so winding and texture direction match.
 */
function rectCorner(k, face, axes, su, sv) {
  if (k === axes.u) return face.u[k] * su > 0 ? rectHi[k] : rectLo[k];
  if (k === axes.v) return face.v[k] * sv > 0 ? rectHi[k] : rectLo[k];
  return rectLo[k];
}

/** Emit the w x h rectangle of faces whose first cell is mask index i. */
function emitMerged(buf, f, s, a, b, w, h, i) {
  const face = FACES[f];
  const axes = FACE_AXES[f];
  const [ax, ay, az] = face.n;
  const [ux, uy, uz] = face.u;
  const [vx, vy, vz] = face.v;

  // A face with a positive normal sits on the far side of its slice.
  rectLo[axes.n] = rectHi[axes.n] = s + (face.n[axes.n] > 0 ? 1 : 0);
  rectLo[axes.u] = a;
  rectHi[axes.u] = a + w;
  rectLo[axes.v] = b;
  rectHi[axes.v] = b + h;

  const tile = maskTile[i] - 1;
  const sky = maskSky[i], torch = maskTorch[i], occ = maskOcc[i], flag = maskFlag[i];
  const grow = w > 1 || h > 1 ? SEAM_OVERLAP : 0;
  const start = buf.vertexCount;

  for (let c = 0; c < 4; c++) {
    const su = CORNERS[c][0];
    const sv = CORNERS[c][1];
    const px = rectCorner(0, face, axes, su, sv);
    const py = rectCorner(1, face, axes, su, sv);
    const pz = rectCorner(2, face, axes, su, sv);
    // UVs come from the true corner, so the overlap does not stretch the texture.
    const u = px * ux + py * uy + pz * uz - su * UV_EPS;
    const v = px * vx + py * vy + pz * vz - sv * UV_EPS;
    buf.vertex(
      px + grow * (su * ux + sv * vx),
      py + grow * (su * uy + sv * vy),
      pz + grow * (su * uz + sv * vz),
      ax, ay, az, u, v, sky, torch, occ, 0, flag, tile
    );
  }

  // Light is the same at every corner, so either diagonal will do.
  buf.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}
