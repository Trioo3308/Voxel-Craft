# Voxel Craft

A Minecraft-style voxel game in JavaScript + Three.js. Infinite procedural
terrain, block building, a day/night survival loop, and mobs — with no build
step and no asset files.

Chose the web stack because it needs zero install, has direct GPU access for
chunk meshing, and gives you Web Workers for off-thread world generation.

---

## Running it

The game uses ES modules and a Web Worker, so it must be served over HTTP
(opening `index.html` from the filesystem will not work — module and worker
loading are blocked on `file://`).

```bash
npm run dev
```

Then open <http://localhost:5173>. Any static server works — `python -m http.server 5173`
is fine too.

Three.js loads from a CDN via the import map in `index.html`. To go offline,
download `three.module.js` into `vendor/` and point the import map at it.

---

## Playing with other people

### On your own network (easiest)

```bash
npm run host
```

It prints the exact link to send, binds to every network interface, and refuses
to start if the port is busy (rather than silently moving to a random port and
invalidating the link you just shared). Use a different port with
`npm run host -- 5174`.

To re-check at any time, including whether the server is actually reachable from
the network rather than only from your own machine:

```bash
npm run whoami
```

#### Send the `192.168.x.x` link, never `localhost`

This trips everyone up once. `localhost` always means *"the computer I am typing
on."* When your friend opens a `localhost` link, their browser tries to reach a
server on **their** machine, which does not exist. Only the
`http://192.168.x.x:5173` form reaches you.

#### If they get a timeout

1. **Windows Firewall** is the usual cause. In an **Administrator** PowerShell,
   once:

   ```bash
   New-NetFirewallRule -DisplayName "Voxel Craft 5173" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow -Profile Private
   ```

   `-Profile Private` keeps the rule to networks you have marked trusted, so it
   does not expose the port on public Wi-Fi. Remove it later with
   `Remove-NetFirewallRule -DisplayName "Voxel Craft 5173"`.

   The rule is **per port** — if you changed the port, change it here too.

2. **Same network?** Not one of you on Wi-Fi and the other on a guest network,
   a different band that isolates clients, or a phone hotspot.

3. **Port already taken?** `npm run host` tells you what to do. To find the
   culprit yourself:

   ```bash
   Get-Process -Id (Get-NetTCPConnection -LocalPort 5173 -State Listen).OwningProcess
   ```

### Over the internet

The game is 100% static files — no server code, no database — so any static host
works. Drop the folder on GitHub Pages, Netlify, Cloudflare Pages or Vercel and
share the URL. Nothing in the project needs configuring first.

### What this is and is not

Everyone gets **their own independent world**, saved in their own browser. This
is shared *access*, not shared *play*: you will not see each other's characters
or edits.

Real-time multiplayer is a much larger piece of work — it needs an authoritative
server, per-player state and edit replication. The groundwork is there, though:
terrain is a pure function of the seed, so a networked version only ever has to
sync *edits*, never terrain. `world.setBlock()` is the single choke point where
that broadcast would go.

---

## Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| `Space` | Jump / swim up / fly up |
| `Shift` | Crouch — shorter hitbox, and you cannot walk off a ledge |
| `Ctrl` | Sprint (works while jumping) |
| `Q` / `Sprint+Q` | Drop one item / the whole stack |
| `M` | Mute sound |
| `F1` | Settings — full control list, and rebind anything |

Every key above is rebindable in Settings, reachable from the title screen, the
pause menu or `F1`. Bindings persist in `localStorage`, and assigning a key that
is already in use swaps the two rather than leaving one action unreachable.
Sprinting also works by double-tapping forward, so no modifier is strictly needed.

### Browser shortcuts

While the pointer is locked, key events are suppressed wholesale apart from a
short allowlist (`Escape`, `F5`, `F11`, `F12`). Without that, `Ctrl` being the
sprint key meant every `Ctrl`+movement combination reached the browser —
bookmarking the page, opening find, or worse, mid-fight.

A handful of combinations (`Ctrl+W`, `Ctrl+T`, `Ctrl+N`) are reserved by the
browser and `preventDefault` cannot touch them. Settings offers a **Capture all
keys** button which uses the Keyboard Lock API in fullscreen — the only way to
intercept those. It is opt-in, since it takes over the whole keyboard.
| Left click | Hold to mine · click to attack a mob |
| Right click | Place block · eat held food |
| `1`–`9`, mouse wheel | Select hotbar slot |
| `E` | Inventory (creative palette appears in creative mode) |

### Inventory handling

Slot interaction follows Minecraft, which is what makes distributing ingredients
across a crafting grid practical later:

| | Empty hand | Holding a stack |
| --- | --- | --- |
| **Left click** | Take the whole stack | Drop it all — merging into a matching stack, otherwise swapping |
| **Right click** | Take half (rounded up) | Place **one** item; swap if the types differ |

In the creative palette, left click takes a full stack and right click takes a
single item. Closing the inventory while holding a stack returns it rather than
destroying it.
| `G` | Toggle creative / survival |
| `F` | Toggle flight (creative only) |
| `F3` | Debug overlay |
| `Esc` | Pause |

---

## Game mode is chosen once

You pick **Survival** or **Creative** when creating a world, and that choice is
permanent. A survival world can never be switched to creative — the mode key does
nothing, the creative palette stays hidden, and flight is unavailable. A creative
world can switch freely between the two.

The lock is enforced in three places rather than one, because a single check is
easy to route around later:

- the hotkey refuses and says so
- `toggleCreative()` takes the world's permission and refuses without it
- **loading** forces survival regardless of what the save file claims, so a
  stale or hand-edited save cannot promote a world

Saving takes the mode from the world's metadata rather than the live player, so a
bug elsewhere cannot quietly change it either.

This was a save-format change, so `SAVE_FORMAT_VERSION` went to 2 with a
migration. Worlds created before the choice existed are **grandfathered in as
creative-capable** — they always could toggle, and retroactively locking them into
survival would take away something people already had.

---

## The survival loop

- **Health** (20) and **hunger** (20). Moving, sprinting, jumping and fighting
  burn *exhaustion*, which drains saturation, then hunger. A full hunger bar
  regenerates health; an empty one starves you.
- **Fall damage** past ~3.5 blocks. Water breaks a fall.
- Death drops your inventory and respawns you at your spawn point.

### Creatures

| | Behaviour | Drops |
| --- | --- | --- |
| **Zombie** | Melee, burns in sunlight, **calls nearby zombies** when it spots you | Rotten flesh |
| **Skeleton** | **Ranged** — keeps its distance, circles, and shoots arrows | Bones, arrows |
| **Spider** | Fast, **pounces** from range; goes timid in daylight rather than burning | String, spider eye |
| **Creeper** | Silent approach, then hisses and **explodes**, cratering terrain. Backing off defuses it. Does not burn, so it is a daytime threat too | Gunpowder |
| **Pig** | Grazes, flees when hit | Porkchop |
| **Cow** | Grazes, flees when hit | Beef, leather |
| **Sheep** | Grazes, flees when hit | Mutton, wool |
| **Chicken** | Grazes, **flaps** so it never takes fall damage | Chicken, feathers |

All seven share one state machine (`idle → wander → chase → attack`, plus
`flee`). Behaviour is *declared* per species in `mobTypes.js` rather than coded,
so the brain handles line of sight, target memory, melee, ranged fire, leaping,
cliff avoidance and sunlight burning generically.

Two details worth knowing:

- **Line of sight is real.** Hostiles need to actually see you to acquire you —
  and then keep hunting for a few seconds after losing sight, so breaking eye
  contact matters but ducking behind one block does not erase you. Glass and
  leaves do not block sight.
- **Entities are solid.** Mobs push each other apart and cannot stand inside you
  or each other, so a crowd spreads out instead of merging into one spot.

Night is deliberately not a swarm: one species spawns per wave (chosen by
weight) every 6 seconds, with a global cap of 26 and a cap of 9 within 24 blocks
of you.

Mining drops the right block (stone → cobblestone, grass → dirt) as a physical
item entity you walk over to collect.

**Lava** burns: standing in it deals 4 damage every half-second and ignores
invulnerability frames, so it is reliably lethal.

---

## Flowing fluids

Water and lava spread like early Minecraft. Both are placeable from the creative
palette — drop a source and watch it run.

A fluid cell is either a **source** (level 0, permanent) or a **flow**
(level 1..max, which exists only while something upstream feeds it). Each tick a
flow recomputes the level it is entitled to:

- fed from directly above → level 1, so waterfalls stay at full strength
- otherwise `min(horizontal neighbour levels) + 1`
- if that exceeds the family maximum, the cell dries up

Then it spreads: straight down if there is room, otherwise outward one level
weaker. Because levels only grow as you move away from a source, the system
always settles — and **removing a source makes the whole pool recede on its own**,
with no bookkeeping.

| | Spread | Tick rate |
| --- | --- | --- |
| Water | 7 blocks | every tick (0.2 s) |
| Lava | 3 blocks | every 3rd tick (viscous) |

Water meeting lava turns to stone. Fluid never replaces solid blocks.

Flowing levels render at reduced height so a stream visibly tapers, while a cell
with more fluid above it fills its whole cube — otherwise a waterfall would look
like a stack of disconnected slabs.

Two things make this affordable in an infinite world:

1. **It is event-driven, not a per-frame sweep.** Only cells adjacent to a change
   are queued, so a static ocean of source blocks costs nothing until you disturb
   it. Digging next to the sea *does* correctly let it pour in.
2. **Worker sync is batched per tick.** A spreading pool changes dozens of voxels;
   `world.flushBlockChanges()` sends them as one message so each affected chunk is
   remeshed once rather than once per block.

---

## Saved worlds, and why updates won't break them

Worlds live in your browser's IndexedDB. The menu lists them with their seed,
play time and edit count; you can create, delete, **export** to a `.json` file
and **import** one back. The game autosaves every 30 seconds, on pause, on death
and when you close the tab.

Three separate hazards could corrupt a world when the game is updated, so there
are three separate defences:

| Hazard | Defence |
| --- | --- |
| The save layout changes | Every save records `formatVersion`. `MIGRATIONS` in `world/save.js` holds one function per version step, applied in order on load. Old saves are upgraded, never rejected. Used twice so far: v1→v2 added the fixed game mode, v2→v3 added dimensions. |
| Terrain generation changes | Every save records `terrainVersion`, and the generator is built with **that** version, not the newest. A world keeps the landscape rules it was born with, so newly explored chunks still match the ones you already walked through. |
| Block or item ids get renumbered | Saves store a **palette** mapping id → stable name, and loading remaps by name. Ids can be reshuffled freely; only *renaming* or *deleting* a block loses data, and that is reported to the console rather than applied silently. |

The third one is the sneaky one. Saved edits are just numbers — without a
palette, inserting one new block in the middle of the registry would silently
turn someone's cobblestone house into dirt.

A world saved by a **newer** build than you are running is detected and refused
with an explanation, rather than being loaded and mangled.

**If you change terrain generation later:** bump `TERRAIN_VERSION` in
`world/terrain.js` and branch on `this.version` where behaviour differs. Never
edit v1 behaviour in place — that is exactly what silently reshapes existing
worlds.

This has already been exercised. Terrain is at **v2**, which added the occasional
rough/cliffy ground; the v1 code path is untouched and verified byte-identical,
so a world created before that change still generates exactly the landscape it
always did.

The save format is at **v3**. A v2 world's flat edit list is filed under the
overworld and its block-entity keys gain a dimension prefix, so an existing world
opens with its buildings, chests and furnaces intact and simply gains access to
the Comb.

One deliberate exception to the terrain rule: **combium ore is not gated behind a
terrain version**. Gating it would lock every existing world out of the dimension
permanently. Leaving it ungated only means chunks you explored before this update
contain none — the same seam Minecraft accepts whenever it adds an ore, and it
reshapes nothing you have already built in.

### Sound

All audio is synthesised at runtime from Web Audio oscillators and noise buffers
— there are no sound files, matching how the textures are painted rather than
shipped. Footsteps, digging and block breaks are **material-aware** (stone rings,
sand hisses, wool thuds), each species has its own voice, and glass gets a
shatter tail. `M` mutes.

Animal calls went through a round of rework after they turned out to be shrill
and relentless. Three things were wrong: raw square and sawtooth waves at
340–620 Hz are all upper harmonics and read as electronic beeps; every mob called
every 6–18 seconds, which with a herd of eight meant a noise every second or two;
and nothing accounted for distance. Now every voice runs through a lowpass filter
with pitches roughly halved, vibrato carries the bleats and moos instead of
harshness, idle calls fire every 22–50 seconds and compete for a single global
slot, and anything past 24 blocks is attenuated or dropped outright.

---

## Progression

Mining is gated by tool tier, which is what gives the game a spine:

| Ore | Depth | Needs |
| --- | --- | --- |
| Coal | y 5–118 | wooden pickaxe |
| Iron | y 3–62 | stone pickaxe |
| Lapis | y 2–34 | stone pickaxe |
| Gold | y 3–32 | iron pickaxe |
| Redstone | y 2–22 | iron pickaxe |
| Diamond | y 1–16 | iron pickaxe |
| Emerald | y 4–40, **mountains only** | iron pickaxe |
| Combium | y 1–14 | **diamond pickaxe** |

Mining a diamond with a stone pickaxe destroys the block and gives you nothing,
so the loop is: wood → stone → iron (smelted in a furnace) → diamond → combium.

**Tools** come in wood, stone, iron, gold, diamond and combium — pickaxe, axe,
shovel and sword each. The right tool class multiplies mining speed; the wrong
one is no better than bare hands. Gold keeps its Minecraft quirk: very fast, very
fragile. Tools wear out and break.

**Armour** comes in iron, gold, diamond and combium. Each armour point removes 4% of
incoming damage, capped at 80%, so full diamond (20 points) blocks four fifths of
a hit. Armour wears down when it saves you, and does not protect against
starvation or falling out of the world.

**Furnaces** smelt iron and gold ore into ingots, sand into glass, cobblestone
back into stone and raw meat into a much better meal. Coal, logs, planks and
sticks all burn. Smelting continues while the menu is closed.

**The bow** is drawn by holding right click and fired on release. Damage and
arrow speed both scale with the draw — a snap shot is nearly useless, a full draw
hits for 9. Arrows are spent from anywhere in your inventory, and a charge
indicator under the crosshair turns green at full power.

---

## The Comb

A second dimension, reached the way the Nether is: build a frame and light it.

**Combium** is the deepest ore, needs a diamond pickaxe, and is slightly rarer
than diamond — about 1.3 blocks per chunk in the y 1–14 band, dropping 2–3 raw
each. Smelt it into ingots, then craft **blocks of combium** four ingots at a
time. Ten of those make a portal frame.

**Buckets** are crafted from three iron and carry one of three things. Right
click a water or lava *source* block to fill, right click anywhere to pour it
back out, and right click a cow for milk.

**The portal** is a frame in nether-portal proportions — 2–4 wide, 3–5 tall,
corners optional — lit with a **bucket of milk**. Detection floods the enclosed
gap and verifies the ring, so any legal size and either orientation works.
Breaking a single frame block collapses the whole portal. Standing in one whites
out the screen over about a second, then you travel; coordinates scale 4:1, so
the Comb is a compressed map of the overworld, same as the Nether.

**The dimension itself** is a pale rolling plateau of comb stone riddled with
hollow cells, veined with crimson crystal that glows. No day cycle, no sun, no
overworld wildlife — a permanent bone-white haze.

**Shrines** sit on a coarse grid, roughly one per 12×12 chunks: a stepped brick
platform, crystal-capped pillars, a throne, and a chest behind it holding the
dimension's loot table (guaranteed combium ingots and shards, with diamond gear
and a combium sword as rare rolls).

**The Comb Warden** guards each one. 220 health, three phases that get faster and
hit harder as it drops, a roar that shoves you back on every phase change, and a
leash that pulls it home — and regenerates it — if you try to fight from range
and run. Its health shows across the top of the screen while you are near it. It
drops a **Comb Heart**, 6–12 ingots, and rolls from its own table. One per
shrine, and it stays dead.

---

## Building and light

**Slabs, stairs and fences** exist for stone, cobblestone, planks and sandstone.
These required generalising blocks away from implicit unit cubes: every block now
optionally carries a list of collision/render boxes, which both the physics and
the mesher read. A `null` shape means "ordinary full cube" and takes the fast
path, so the overwhelming majority of blocks cost nothing extra.

**Doors** are two blocks tall and swing on right click, with both halves kept in
step. **Beds** set your spawn point and skip to dawn — but only at night, and only
with no hostiles within 12 blocks, so a bed is not simply a danger-skip button.
**Chests** hold 27 slots and keep their contents when you close them, spilling
into your inventory if broken.

**Torches** are the important one. Caves were previously lit only by a sky-exposure
floor, which made them dim-but-navigable and left nothing to solve. That floor is
now genuinely dark, and torches (coal + stick) provide a real block-light channel:
a breadth-first flood fill from each emitter, losing one level per block, sampled
by the mesher alongside daylight. Lava emits too. Glass passes light, water dims
it, opaque blocks stop it.

Removing a light source is the subtle half — you cannot just clear its cell,
because everything it lit must be un-lit and then re-lit from any *other* source
still in range. That runs as its own BFS which erases the affected region and
collects surviving neighbours as seeds for a refill.

Three things had to be fixed before it looked right:

- **Light stopped dead at chunk edges.** Edits only marked neighbouring chunks
  dirty when the block sat *on* a border, but a torch reaches 15 blocks in every
  direction from anywhere in a chunk. Changing an emitter now dirties every chunk
  its glow can touch.
- **Chunk seams.** The light volume was chunk-sized, so a face on a border
  sampled the neighbouring cell by clamping back inside — visibly wrong wherever
  a torch sat near an edge. It is now padded by one voxel, sharing its addressing
  with the mesher via `chunk.js`.
- **Slabs and stairs rendered too dark.** A partial block sampled its own cell,
  which the height map counts as buried ground. It now takes the brightest of
  its own cell and its open neighbours.

Lighting is also **smoothed per vertex** rather than per face: each corner
averages the four cells meeting there, skipping occluded ones so light does not
bleed through solid corners. A single value per quad made every block a flat tile
and torchlight fall off in visible steps.

---

## Architecture

```
src/
├─ main.js                 Game loop + state machine (loading/menu/playing/paused/dead)
├─ settings.js             All tunables in one place
├─ engine/
│  ├─ renderer.js          Three.js scene, camera, lights, block highlight
│  ├─ input.js             Keyboard/mouse state + edges, pointer lock
│  ├─ audio.js             Procedural Web Audio synthesis (no sound files)
│  ├─ viewmodel.js         First-person hand + held item overlay pass
│  └─ sky.js               Day/night cycle; authority on isDay/isNight
├─ world/
│  ├─ blocks.js            Block + item registry  ← add content here
│  ├─ textures.js          Procedurally painted texture atlas
│  ├─ noise.js             Seeded Perlin noise + hashing
│  ├─ chunk.js             Chunk constants and indexing math
│  ├─ terrain.js           Terrain, biomes, caves, ores, trees
│  ├─ fluids.js            Flowing water & lava automaton
│  ├─ light.js             Block light propagation (BFS flood fill)
│  ├─ save.js              Persistence + version/palette migration
│  ├─ mesher.js            Voxels → vertex buffers (culling + ambient occlusion)
│  ├─ worker.js            Worker entry: owns generation and meshing
│  └─ world.js             Main-thread chunk streaming + block read/write
├─ player/
│  ├─ physics.js           AABB vs. voxel collision (shared with mobs)
│  ├─ raycast.js           Voxel DDA ray traversal
│  ├─ player.js            First-person controller + block interaction
│  ├─ inventory.js         Hotbar, backpack, armour, durability
│  ├─ crafting.js          Recipes, grid matching, furnace smelting
│  └─ survival.js          Health, hunger, armour mitigation, death
├─ entities/
│  ├─ mob.js               Base mob: physics, health, animation, AI brain
│  ├─ mobTypes.js          Mob registry  ← add creatures here
│  ├─ itemEntity.js        Dropped items
│  ├─ projectile.js        Arrows
│  └─ entityManager.js     Spawning, separation, despawning, ray picking
└─ ui/
   └─ hud.js               All DOM UI
```

### How performance is achieved

The world is infinite, so the work has to be bounded at every stage:

1. **Everything expensive runs in a Web Worker.** Noise sampling, chunk assembly
   and vertex-buffer construction all happen off the render thread. Finished
   geometry comes back as transferable `ArrayBuffer`s (zero-copy).
2. **Hidden-face culling.** Only faces touching a non-opaque neighbour are
   emitted — about **1,860 triangles per chunk**, where a naive "six quads per
   block" mesher would emit nearly 200,000. The padded snapshot mirrors the
   floor block into its `y = -1` skirt so chunks do not emit the permanently
   invisible underside of the world (another 512 triangles each).
3. **One draw call per chunk.** A single procedural texture atlas plus one
   material means each chunk is one `Mesh`, and Three.js frustum-culls it for free.
4. **Baked lighting.** Ambient occlusion, sky exposure and per-face shading are
   computed once at mesh time and stored in vertex colours, so the runtime
   material is unlit `MeshBasicMaterial` — no per-fragment lighting cost. Day/night
   is a single material colour multiply.
5. **Budgeted uploads.** At most 2 chunk meshes are pushed to the GPU per frame
   (`Settings.maxUploadsPerFrame`) and at most 6 generation jobs are in flight,
   so streaming never causes a frame hitch.
6. **Circular load area with hysteresis**, so walking back and forth across a
   boundary does not thrash chunks.

Terrain generation measures ~8 ms/chunk, entirely on the worker thread.

### Two design decisions worth knowing

**Generation is a pure function of `(x, z, seed)`.** No chunk ever reads its
neighbours' stored state. That is what makes trees straddling a chunk border line
up perfectly — both sides compute the identical answer. It also means the worker
can cheaply generate the 8 neighbours it needs for correct edge culling and
ambient occlusion, so chunk seams are right on the *first* draw and never need a
second "seam fix" pass.

**Voxel data is deliberately duplicated.** The worker owns the authoritative copy
for meshing; the main thread keeps its own copy for collision, raycasting and
instant edit feedback. Round-tripping to the worker for those would add a frame
of latency to every block you place.

---

## Extending it

### Add a block

1. Add a tile id to `TILE` in `world/blocks.js`.
2. Paint it in `PAINTERS` in `world/textures.js` (16×16 pixels, `set(x,y,r,g,b,a)`).
3. Add a `defineBlock(...)` line.

Terrain, mesher, inventory, hotbar icons, drops and the creative palette all read
from the registry — nothing else needs touching.

### Add a mob

Append one object to `MOB_TYPES` in `entities/mobTypes.js` with `buildModel()`
and `ai(mob, dt, ctx)`. Physics, animation, combat, spawning and despawning are
generic. The `steerToward` / `wander` / `avoidCliffs` helpers are already there.

### Add a recipe

One line in `player/crafting.js`:

```js
shaped(['DDD', ' S ', ' S '], { D: DIAMOND_BLOCK.id, S: ITEM_ID.STICK },
       { id: someItemId, count: 1 });
```

Patterns are auto-trimmed, so they match anywhere in the grid, and a 3×3 recipe
is automatically unavailable in the 2×2 inventory grid. `shapeless([...], result)`
ignores arrangement. Smelting is two `Map` entries: `SMELTING` and `FUELS`.

### Add a biome

Add an entry to `BIOME`, a case in `surfacePalette()` for its ground blocks and
one in `treeStyle()` for its trees, then a branch in `biomeAt()` deciding when it
appears from the temperature / humidity / weirdness fields.

Note that raw fBm noise clusters near zero — the climate axes are amplified by
~2.2 before thresholding for exactly this reason. Without that, almost the whole
map comes out as one biome.

### Add multiplayer

The clean seam is `world.setBlock()`. It applies locally, then posts to the
worker. Add a network broadcast at the same point and apply remote edits through
the same function, and terrain stays consistent because generation is seed-pure —
you only ever need to sync *edits*, never terrain.

---

## Known simplifications

These are deliberate scope choices, not bugs:

- **Fluid is not simulated on chunk load**, only on change. Terrain-generated
  oceans and cave water sit still until you disturb them — which is both the
  cheap option and roughly how early Minecraft behaved.
- **No buckets.** Water and lava sources are placed from the creative palette.
- **Zombie AI is steering-based**, not A\* — they walk toward you and jump at
  obstacles, so they can get stuck on complex terrain.
- **No enchanting, potions or redstone circuitry.** Redstone and lapis generate
  and can be mined, but currently have no use beyond decoration.
- **Armour comes in iron, gold and diamond only** — the three metal tiers, as in
  Minecraft. There is no leather (no cows) and no wood or stone armour.
- Dropped item stacks do not merge with each other.

---

## Verified behaviour

Checked against a running instance plus headless harnesses for the generator,
the fluid automaton and the mesher.

**World** — terrain layering (grass → dirt ×4 → stone → bedrock), caves, ore
blobs; chunk seams continuous; identical seed reproduces a chunk exactly; trees
stand on dirt with canopy above, none floating.

**Controls** — W/S/A/D move in the correct directions at yaw 0 and rotated;
right click places (middle click does not); breaking yields the correct drop;
solid blocks cannot be placed inside the player, non-solid ones can.

**Inventory** — right click takes half (rounding up) and deposits one at a time;
left click still moves whole stacks and merges with overflow retained; full
stacks reject deposits; closing while holding returns the stack.

**Fluids** — water spreads exactly 7 blocks in a concentric diamond
(1/4/8/12/16/20/24/28 cells by level) and lava exactly 3; pools recede fully when
the source is removed; water falls off ledges and pools below; water + lava makes
stone; fluid never overwrites solids; the automaton goes quiescent rather than
churning.

**Rendering** — flowing fluid is tapered, submerged cells fill their cube, lava
renders opaque and unshaded while normal blocks keep their baked AO, and a solid
chunk emits only its 256 top faces.

**Survival** — night spawns zombies, day spawns pigs; zombies chase and deal 3
damage with knockback; player attacks apply damage and knockback; pigs drop
porkchops; zombies burn in direct sunlight; lava damages the player; the player
rests exactly flush on the block surface.

**Ores & biomes** — all eight ores generate and stay inside their depth bands;
emerald appears only in mountains and is the rarest; diamond is rarer than iron
which is rarer than coal; all ten biomes appear with a sane spread (36% plains
down to 0.9% mountains); savanna/taiga/swamp surface blocks and acacia/spruce
trees all reachable.

**Crafting & gear** — all 49 recipes match, including all 20 tools, all 12
armour pieces and the mirrored axe layout; 3×3 recipes are correctly rejected by
the 2×2 grid; nonsense layouts produce nothing; bare hands drop no stone; a
wooden pickaxe cannot harvest diamond but an iron one can; tools wear down and
break; a diamond pickaxe mines ~8× faster than fists; furnaces smelt, keep
running with the menu closed, and return their contents when broken; full
diamond armour blocks 80% of damage but none of starvation.

**The Comb** — 94 headless assertions plus a full in-browser playthrough. Every
block, item and gear id is unique and resolves, and no two items share an icon.
A diamond pickaxe mines combium for 2–3 drops while an iron one destroys it for
nothing; ore → ingot → block → frame → portal runs end to end. Frames light at
2×3 through 4×5 on either axis, missing corners are tolerated, a hole in a wall
or an oversized opening is refused, and breaking one frame block collapses the
whole portal. Travel scales coordinates 4:1, builds a return portal, and lands
you *beside* it rather than inside — standing in the arrival portal used to send
you straight back once the cooldown lapsed. Comb terrain is deterministic per
seed, every column has ground, shrines straddling a chunk border are written
identically from both sides, and shrine chests and the Warden are placed exactly
once per shrine and survive a save/load round trip. The Warden escalates through
three phases (8→10→12 damage, 1.6→0.9s cooldown), drops its loot table, and does
not respawn. Buckets fill from sources only, pour water and lava, and milk a cow.

**Held tools and the swing** — a tool is carried by its handle, not by the middle
of its blade. The grip point is *measured* from the icon (the midpoint of its
lowest opaque row) rather than tabulated per tool, so redrawing a sprite cannot
leave a stale offset behind; a diagonal pickaxe grips at u=0.19, a straight
shovel at u=0.47, and the hand-drawn combium sword at u=0.09, all correct from
the same rule. The sprite is shifted inside a holder so the grip sits at the
holder's origin, which also makes the tool rotate about the hand instead of about
its own centre. A bow is excluded — it is gripped mid-limb, and the rule would
put the hand on its bottom tip.

Mining sets `didSwing` every frame it is held, and the view model restarted the
swing on each one, pinning progress at 0 so the arm sat frozen mid-mine. A swing
in flight is now left alone and reloops only once a cycle completes: holding to
mine runs 7 strokes in 2 seconds, and releasing lets the stroke in flight finish
within 0.25s and stop. The arm sweeps 0.9 rad through the stroke.

**Shapes, textures and walk-through blocks** — `emitShape` *crops* a partial
block's tile to the box extent rather than squashing the whole tile into it, so
a torch only ever shows columns 7–9 and rows 6–15. Art drawn outside that window
is silently invisible, which is why torches rendered as bare sticks with the
flame at rows 2–5. A check now asserts no torch pixel falls outside the visible
rows and that the flame sits at the top of them. Torches and comb growth are
walk-through, verified by walking a lane past both with a stone wall as the
control that must still stop you; both remain targetable, placeable and
breakable, since raycasting keys off "not air, not liquid" rather than solidity.
The combium sword uses its supplied sprite, asserted pixel for pixel against the
original and confirmed distinct from the generic tinted sword.

**Save format v3** — a v2 world migrates with its edits filed under the
overworld, block-entity keys prefixed, and its creative lock preserved; a v1
world walks all the way to v3. Both dimensions' chests and furnaces coexist and
survive travel in both directions — block entities used to be wiped on every
portal trip, which emptied every overworld container the moment you left.
Breaking a chest or furnace returns everything inside it — and when the inventory
is full the remainder falls on the floor instead of being destroyed, which is the
case that was still losing furnace contents.

**Movement & controls** — sprinting works while jumping (this was a real bug:
`input.js` bailed out of keydown whenever Ctrl was held, so the sprint key
silently swallowed WASD and Space); crouching shrinks the hitbox and lowers the
eye; crouching at a ledge stops you walking off while walking normally still
falls; standing up is refused when a ceiling overlaps the taller box; Q drops one
item and Ctrl+Q the stack.

**Mobs** — all seven species build models and brains; stacked mobs push apart to
zero residual overlap; a mob coincident with the player is ejected; a wall blocks
line of sight but open ground does not; skeletons hold range and land arrows for
damage; zombies land melee; a zombie alerts its pack; spiders hunt at night and
go timid by day; struck animals flee; sheep drop mutton and wool.

**Terrain v2** — v1 chunks remain byte-identical across generators, v2 differs
from v1 in 13/36 sampled chunks, roughness affects 14% of columns with up to 10
blocks of relief, local relief measurably increases, and the bedrock floor and
height limits still hold.

**Block shapes** — a box resting on a slab does not collide while one sunk into
it does; slabs support at half height and not a block up; a fence is 1.5 tall but
narrow enough to slip past at the cell edge; a closed door blocks a doorway an
open one does not; a shaped block emits all six faces of each box and stops at the
right height; shaped blocks are forced non-opaque. **Landing was a real bug** —
the downward snap used `Math.ceil(y)`, assuming integer block tops, so landing on
a slab overshot to the top of the cell and jittered. Now rests at exactly 101.501
with zero variance over 60 frames, and full cubes still land correctly.

**Bow** — holding right click draws to full in one second; releasing fires and
consumes one arrow; damage scales 1 → 9 with draw (verified 2.28 at 40%); no
arrows means no shot.

**Lighting** — falls off exactly one level per block and reaches exactly 15;
opaque walls cast shadow with no leakage; light bends through a gap and spreads
beyond it; glass passes light, water dims it; **removing a torch clears everything
it lit** while a second source correctly re-lights the region to its own level;
an unlit chunk allocates nothing at all; a torch outside a chunk still lights its
edge.

**Building & containers** — doors toggle both halves together; chests keep
contents across close/reopen and spill when broken; beds set spawn, skip to dawn
at night, and refuse with monsters within 12 blocks; explosions crater terrain
(49 → 28 solid blocks), hurt the player with falloff, and leave bedrock intact;
creepers start their fuse on approach.

**Game mode** — a survival world refuses the mode key, refuses a direct
`toggleCreative()`, hides the creative palette, and still refuses after a full
page reload; a creative world toggles both ways; a save claiming `creative: true`
loads as survival anyway if the world is survival; saving reads the mode from the
world rather than the player; and a v1 save migrates to v2 grandfathered as
creative-capable with everything else intact.

**Persistence** — a full round trip through a page reload restores position,
health, hunger, time of day, every inventory slot in place, tool durability,
worn armour, block edits and furnace contents; saves from a newer build are
refused rather than mangled; block ids can be renumbered without corrupting a
save.
