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
| `L` | Achievements and statistics |
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

**Farming** is the one food source you can renew. Dig any grassy block and about
one in five yields seeds; a hoe turns grass or dirt into farmland; seeds go in,
wheat comes out, and three wheat bake into bread. Farmland within four blocks of
water is irrigated and grows roughly three times faster — measured at 91 seconds
to ripen against 299 dry — which is the whole reason to dig a channel down the
middle of a field. Harvesting early costs you the harvest but not the seed.

Crops advance on **random ticks** rather than a registry: nothing tracks where
your farms are, a planted crop is just a block id that occasionally gets poked.
That keeps the cost fixed no matter how much you plant.

**Trees are renewable.** Leaves drop saplings (about one in nine) and sticks;
plant a sapling on soil and it grows into a tree of its own species, given room
above it. Leaves cut off from a trunk **decay** rather than hanging in the air,
scattering their own drops as they go. The support check is a bounded flood
through connected leaves rather than a box scan — a box would count a
*different* tree's log nearby and keep a floating canopy alive forever, which is
precisely the artefact this exists to clear up.

**Livestock.** Feed two adult cows, sheep or pigs wheat (chickens take seeds) and
they breed; the calf is half-size and grows up on a timer. **Shears** yield wool
and leave the sheep visibly bare until its fleece regrows, so wool no longer
depends on killing spiders for string.

**Fishing.** Cast a rod into water, wait, and reel in during the bite window.
Deliberately a state machine on the player rather than a bobber entity — the
float never needs to collide, be hit, or outlive the cast.

**Ladders** climb by holding jump or forward against them; releasing slides you
down slowly rather than dropping.

**Tool repair.** Two worn copies of the same tool combine into one with their
durability summed plus a 5% bonus, capped at new. It cannot be an ordinary
recipe: the result depends on the *durability* of the inputs, which the pattern
matcher has no concept of, so it is checked before the recipe table.

**A locator readout** shows position, facing and biome — the world is infinite
with no map, and without it "walk back to the portal" is guesswork.

**Doors and beds have a facing.** A door turns to face whoever placed it, so its
panel is always across your path; a bed is a foot and a head laid along the way
you are looking, and you can sleep from either end.

**Food** is a small ladder of its own. Bread is the farmable staple; **mushroom
stew** is worth more and is made from what you find on forest floors rather than
what you grow, and eating it leaves the bowl behind. Oak leaves drop the odd
**apple** (about one in thirty), and eight gold ingots around one makes a
**golden apple** — the only food in the game that restores health as well as
hunger, priced so that using one is a decision.

**Wolves** spawn in forests. A wild one keeps its distance and has red eyes;
feed it a bone and it is yours — it follows you, bites whatever hurts you, and
right-clicking toggles between staying put and heeling. The taming state lives
on the animal rather than being a second species, so a tamed wolf keeps the
health and position it already had.

**Boats** cross water at 7.5 blocks/second against 2.4 swimming. Right-click
water with one to get in, `Space` to step out and take it with you. Like the
fishing bobber, a boat is state on the player rather than a free-floating
entity: it never needs to be hit, collided with, or outlive the person in it.

---

## Skating

A **skateboard** (three planks and two iron) turns movement into a scoring game.
Right-click to drop in, right-click again to step off.

- **Speed.** 9.5 blocks/second, faster than a sprint but much slower to build up
  and much slower to turn. An ollie pops 28% higher than a jump.
- **Tricks** are read from what you are already doing rather than from dedicated
  buttons: hold left or right in the air for a kickflip or heelflip, forward or
  back for a nose or tail grab, and swing the mouse for spins — 180 through 720.
  Hang in the air past 1.1 seconds and the hang time itself scores.
- **Combos.** Each landed trick raises the multiplier by one, capped at 8. The
  chain stays open for 2.5 seconds on the ground, and banks itself when it
  expires or when you step off.
- **Bails.** Land from more than 10 blocks up and you lose the whole chain. Under
  that, a landing on the board costs no fall damage at all — the board absorbs
  it, which is what makes the big-air tricks worth attempting.
- **Rails.** Craft grind rails from iron and sticks. Rolling along one grinds:
  style accrues per *second*, the rail holds your speed instead of bleeding it
  off, and it keeps the combo open — so a rail is how you link two jumps
  together. A four-second grind is an "Endless Grind" and scores accordingly.
- **Rockets** (sustingus jelly, gunpowder and a stick) are the launcher. On foot
  one goes straight up and bursts into fireworks; on the board it shoves you
  along your heading. Straight up that is 5.8 blocks and 1.25 seconds of hang
  time, comfortably past the Big Air threshold — the numbers are picked against
  gravity rather than by feel, because the first version was weaker than an
  ordinary jump and therefore pointless.

**Skate parks** generate rarely on flat ground: a levelled pad, a bowl whose
walls are rideable ramps, two rails spanning it and a torch on each corner. Like
dungeons they are gated on the terrain version, and more urgently — a park
flattens ground at the surface, which is exactly where people build.

---

## Underground

The caves were rebuilt in terrain v5 after measurement showed how bad they were:
the y1–16 band, where diamond and combium live, was **1.4% air**. Both ores were
generating perfectly well — 2.5 and 1.2 blocks per chunk — but only 0.11 and
0.03 of those ever touched an open face, so the only way to find either was to
strip mine and hope. "Diamonds don't exist" was a reasonable description.

Three systems now overlap:

- the **original worm tunnels**, kept so old and new worlds feel related, but
  widened — and widened further with depth;
- a second, coarser **gallery pair** weighted toward the bottom of the world,
  which produces the long runs the deep had none of;
- **open caverns** from a single low-frequency field, which is what gives a cave
  somewhere to stand rather than a tube to shuffle along.

Measured after: 12–15% air through the deep bands, one connected system rather
than isolated pockets, and 580 standable floor blocks per chunk against 437.
Exposed diamond went 0.11 → 0.48 per chunk and combium 0.03 → 0.33.

Caves fade out by **depth below their own column**, never by absolute height.
The first version of that rule used a fixed y band and punched holes through the
floor of any valley low enough — correct on a plateau, a crater everywhere else.

**Deepslate** replaces stone below y16, so how deep you are is readable without
checking the coordinates. **Dripstone** hangs from ceilings and stands on
floors, **glow lichen** grows in patches and gives just enough light to navigate
by, **lava** pools in the deepest galleries, and rare **geodes** — a shell, a
lining of crystal, a hollow middle — are the only source of cave crystal, which
makes a lantern brighter than a torch and needing no coal.

### Things live down there now

`_canStandAt` used to ask `getSurfaceY` and nothing else, which meant mobs could
only ever spawn on the roof of the world. Stand in a cave forty blocks down and
zombies would appear in the daylight above your head, count against the nearby
cap, and never come near you. That is the whole of why "mobs don't spawn".

Spawning now searches outward from **your own elevation** for a floor, so a wave
lands on the level you are exploring. Underground the time of day stops
mattering — a cave is dark whether or not the sun is up — and hostiles instead
need the dark, which means **torching a cave stops it spawning**. Measured: 28
spawnable spots around a base fell to 5 after eleven torches, and nothing
appeared within sixteen blocks.

Block light is computed in the worker and never comes back, so the main thread
cannot ask for a light level; it looks for a light *source* in range instead.
The threshold sits above glow lichen deliberately — lichen emits 7 and grows
everywhere, and the first attempt used 7 as the bar, which quietly marked the
entire cave system as lit and left it completely empty.

**Bats** are the harmless half of it: cave-only, no drops, and they bob around
where they spawned rather than pathing anywhere.

---

## Records, signs and plates

**Jukeboxes** (planks around a diamond) play **music discs**, which are the only
items in the game that cannot be crafted: they are dungeon and shrine loot, so a
jukebox is a reason to go somewhere. There are three, each a different tune, and
each is synthesised from a short interval table at runtime — like every other
sound here, there is no audio file anywhere in the project. A record fades with
distance and stops when you take it out or break the box.

**Signs** hold four lines of text you type in, stored as a block entity and
saved with the world. They cannot go through the chunk mesher — the text changes
without the block changing — so each visible sign gets one textured quad, built
from a canvas, only within 32 blocks and only redrawn when the text actually
changes.

**Pressure plates** open every door they touch while something is standing on
them, and close them again on the way off — mobs included. A plate remembers the
doors *it* opened and closes exactly those, so a door you opened by hand is not
slammed shut when someone steps off a plate three blocks away.

---

## Achievements and statistics

`L` opens a list of 25 achievements and eleven lifetime counters — blocks mined
and placed, distance walked, mobs defeated, days survived, best single skate run,
lifetime style. Both are saved per world.

Achievements are stored **by name, never by index**, for the same reason block
ids are remapped by name on load: reordering or inserting one must not silently
re-grant or revoke somebody's progress. A name from a newer build is dropped on
load rather than kept as a number that would later mean something else.

Counting goals ("mine 1,000 blocks", "walk 10,000 blocks") declare a `check`
against the statistics rather than needing a call site of their own, so adding
one is a single entry in a list.

---

## Weather

Rain, snow and thunderstorms, on a global state that ramps in and out rather
than snapping. What actually falls is decided per column from the biome beneath
you, so you can walk out of a snowfall into rain without the weather changing,
and deserts stay dry through the same storm.

Precipitation reuses the particle pool. Drops are ghosts — collision-testing a
few hundred a second against every ledge would cost more than the rest of the
effect layer — so instead each drop is handed the height of the ground below it
and given exactly enough life to reach it. That is what makes a roof shelter you
rather than rain falling straight through, and it is one height lookup instead of
a per-step sweep.

Storms grey the sky, drop the sun and mute the sunset band; lightning flashes
everything white and cracks with a rolling tail. Rain is one looping voice,
audible only when the sky above you is actually open. The weather is saved with
the world, so logging out in a storm means logging back into one.

---

## Effects and ambience

**Particles** all come from one pooled `InstancedMesh`, so the entire effect
layer is a single draw call however much is happening, and the pool recycles
rather than growing when an explosion overruns it. Shards are tinted by sampling
the broken block's own atlas tile, so stone throws grey chips and grass throws
green ones without the particle code knowing anything about blocks. They fire on
breaking, mining, landing, sprinting, splashing, damage from any source,
explosions, and lit portals.

**Ambience** is two long-lived voices whose gain is steered toward a target
rather than retriggered sounds — walking into a cave is a crossfade, not a cut.
Wind above ground, a sub-bass drone below that deepens with depth, and sparse
one-shots down in the dark: a drip, rock settling, a far-off groan.

---

## Dungeons

Small mossy-cobble rooms buried between y 14 and 40, roughly one per hundred
chunks, each holding one or two chests of mid-game loot — iron, coal, bread,
arrows, the occasional diamond or ready-made tool. Never combium: that gate stays
shut until you mine it yourself.

Placement is a pure function of the seed on a coarse grid, the same trick the
Comb's shrines use, so a room straddling a chunk border is written identically
from both sides.

Dungeons are gated behind **terrain v3**, and that gate matters more than it
looks. Chunks are regenerated from the seed every time they load rather than
stored — only your edits are saved — so adding room-carving to v2 generation
would retroactively hollow out ground beneath houses people had already built.
Worlds created before this update keep generating exactly as they did and get no
dungeons; new worlds get them everywhere.

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

**Materials.** Amber **resin seams** run through the comb stone — the dimension's
renewable material, and the base for **wax**, **comb glass** and a **lantern**
that outshines a torch. **Comb tile** and fluted **pillars** are the shrine's
architecture, and both are craftable once you have bricks.

**Flora and hazards.** Pale fronds scatter the plateau, **glowing fungus** lights
the hollow cells from the floor up, and **crimson spine thickets** hurt to walk
through — the Comb's one environmental hazard, and the reason to look where you
are sprinting.

**Natives.** **Comb mites** are small, fast, and come in groups of three to six;
individually trivial, but the open plateau gives you nowhere to put your back.
**Comb drifters** are placid and drop resin, so the dimension has something worth
farming as well as something worth fearing. Overworld animals never wander in —
each dimension draws from its own spawn pool.

**Crystal spires** are tall landmarks scattered across the plateau, and they
cluster two and a half times denser and taller near a shrine. That is the
navigation: a horizon thick with spires means you are close.

**Three regions.** The Comb was one uniform plateau, which made a long walk read
as no progress at all. Now a slow noise field divides it into the **Pale
Plateau**, **Moss Fields** and **Ashfall** — different ground, different flora,
and ash is too barren to grow anything.

**A deep stratum.** Below y 26 the comb stone gives way to darker, denser deep
stone. Fungus lights the shallow cells; **crystal clusters** take over down here,
so descending changes what the dark looks like. **Amber** is found only at this
depth.

**Hives** hang in the hollow cells, roughly one per 40 chunks — common enough to
find while you are hunting for something genuinely rare. A wax shell around a
hollow chamber, amber studding the walls, a cache below and a **hive core**
hanging from the roof. Breaking the core is the only source of **royal jelly**,
the strongest food in the game.

**Two more natives.** **Comb stalkers** are slow, heavy and short-sighted — they
notice you late and then close hard, which is the opposite pressure to the mites.
**Comb grubs** live in the deep and drop resin, so the material is renewable
below ground as well as above.

**Resin torches** light the Comb without coal, which the dimension has none of.
**Spore drift** fills its air — there is no weather here, and this is what stops
it reading as completely dead.

### Finding a shrine

Shrines are one per ~1,600 chunks. Spires cluster near them, but that is a hint,
not an answer — so the **shrine compass** makes it navigation rather than luck.

Craft it from **amber**, a **combium ingot** and a **comb shard**. Amber only
exists in the deep stratum and in hives, so the compass is a Comb craft made from
Comb finds: raid hives, go deep, then go looking.

Hold it and the HUD gives a live bearing and distance — *"Shrine 302m, bear right
20°"* — with a needle that turns as you do. Shrine placement is a pure function
of the seed, so the search walks the anchor grid outward without loading a single
chunk and the answer is exact rather than approximate. It works from anywhere,
including the overworld, and always finds one.

### Shrines and the throne

**Shrines** are rare on purpose. They sit on a 32-chunk grid offset from the
origin, and only about two thirds of anchor sites hold one — roughly one per
1,600 chunks, about 650 blocks apart, and *never* near where the portal drops
you. Finding one is a journey, not a stumble.

Each is a tiled platform with fluted pillars under lantern caps, a brick wall
with a glass clerestory, resin offerings set into the floor, a chest holding the
dimension's loot table, and the throne.

**The throne is the point of the dimension.** It sits cold and does nothing until
you set a **Comb Heart** into it — and the only Hearts in the world drop from the
Warden guarding that same shrine. Awakening one is permanent and one-time:

- the throne lights up and stays lit
- you are handed the **Crown of the Comb** — the strongest helmet in the game,
  not craftable and not in any loot table
- your **maximum health rises by two hearts, for good**, surviving death, saving
  and reloading

The extra hearts show as gold pips on a health bar that grows to fit them.

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
- **Mob AI is steering-based**, not A\* — they walk toward you and jump at
  obstacles, so they can get stuck on complex terrain.
- **No enchanting, potions or redstone circuitry.** Redstone and lapis generate
  and can be mined, but currently have no use beyond decoration.
- **Armour has no leather tier** — it starts at iron, so there is no early-game
  armour before your first smelt.
- **Wheat is the only crop.** The farming loop is complete (till, plant, grow,
  harvest, bake) but it grows exactly one thing.
- **Fishing catches only fish** — no junk, no treasure, no enchanted rods.
- **Ladders have no facing.** They render against one wall regardless of which
  side you placed them on.
- **Crops do not need light.** Block light lives in the worker and the growth
  tick runs on the main thread, so a crop underground in the pitch dark grows
  the same as one in a field. Irrigation is what matters instead.
- **Dungeons have no spawner.** They are a room and a reward, not an encounter;
  whatever wanders in is ordinary cave spawning.
- **Weather is global, not regional.** One storm covers the whole world at once
  — only *what falls* is decided locally, per biome.
- **A boat is state on the player, not an entity.** It cannot be left floating
  for later, pushed around, or shared — you carry it, put it down, and take it
  with you. Same trade as the fishing bobber, for the same reason.
- **Signs face one way.** Like ladders, they render against a fixed axis
  regardless of which side you placed them on.
- **Pressure plates only drive doors.** There is no wiring, no signal
  propagation and nothing else to connect them to; this is the first piece of
  world logic you can build with, not a redstone system.
- **A jukebox plays one record on a loop** until you take it out. There is no
  queue and no track-finished event.
- **Wolves are the only tameable animal**, and a tamed one cannot be healed,
  bred, or told to do anything beyond sit and heel.
- **Terrain generation is versioned, so an existing world keeps its old caves.**
  Chunks are rebuilt from the seed every load and only your *edits* are stored,
  which means changing generation would hollow out ground under things people
  had already built. A world made before this update keeps the terrain it had;
  the new caves want a new world. Ore rates are *not* gated — swapping stone for
  ore removes no support and cannot drop anyone's house — so an old world does
  get the better diamond and combium rates in rock it has not mined yet.
- **Bats do not really fly.** They cancel gravity and bob; the mob physics has
  one mode and teaching it a second was not worth it for ambience.
- **Cave light is approximated by proximity to a light source**, not by an
  actual light level — the worker owns block light and does not send it back.
  A torch behind a wall still holds a space clear.

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

**The Comb expansion** — all three regions appear (60/22/18%), hives generate at
about one per 40 chunks with walls, a core and a cache, and the deep stratum,
amber, crystal clusters and ash all generate. The compass finds a shrine from
every position tested including far out in the overworld, reads "dead ahead" when
you face one and "bear right 180°" when you turn your back, and hides itself when
not held.

Comb mites were tuned down after testing: seven of them at two damage a bite
killed a full-health player outright, which is not what an ambient swarm should
do. One damage, slower bites, smaller groups.

**Husbandry, forestry and fishing** — leaves drop saplings at the intended rate,
a sapling grows a tree with trunk and canopy, and a canopy whose trunk is removed
decays completely. Shearing yields wool once, is refused a second time, and
regrows on a timer. Two fed cows produce exactly one half-size calf and both go
on cooldown; the calf grows up. Repair sums durability, refuses mismatched tools,
and never exceeds new. Fishing casts only into water, catches nothing if you pull
early, and lands a fish inside the bite window. A ladder lifts you 5 blocks in
90 frames.

The import checker gained an **undefined-identifier pass** after `dimensionInfo`
and `Settings` were used in hud.js without being imported — the existing check
only proved that imports which *exist* resolve, and said nothing about names used
but never imported. It immediately caught a real bug in this batch: `BABY_SCALE`
referenced in mob.js but never declared.

**Plants and the Comb** — plants render as two crossed quads rather than a box.
A box maps the texture onto its lid, so a wheat field read as cubes with wheat
printed on top; the same bug made comb growth a solid cube you could walk
through. Asserted: every plant is cross-rendered, none also carries a box shape
(which would win over the cross path), and wheat gets taller each stage.

Shrines: 32-chunk spacing on a grid offset from the origin, verified across 40
seeds that none sits within three chunks of where the portal lands, and roughly
1 per 1,600 chunks — an order of magnitude rarer than before. Spires measured at
30% density near a shrine against 12% away, and taller with it. The throne
refuses an empty hand and the wrong item, consumes exactly one Comb Heart, grants
the Crown once, raises max health 20 → 24, and does nothing on a second use;
the boost survives save, reload and death, and a save predating the field
defaults cleanly to 20.

**The cave update** — 102 headless assertions plus an in-browser pass. Reported
as: caves too compact, mobs never spawning underground, diamonds and combium
"non-existent", doors glitching when walked into, and beds being a single block
with no orientation. All five were reproduced by measurement before anything was
changed, and the numbers are quoted above.

Two of them turned out to be the same bug. Diamond and combium were generating
fine; the deep was simply solid rock, so nothing was ever exposed. Printing more
ore into solid stone would have hidden that rather than fixed it.

Doors had no facing at all: the panel sat on a fixed side of its cell however
you placed one, so a door in a corridor running the other way had its collision
*parallel* to your travel and you walked straight through it. Now four facings
times open/closed, verified for every facing in the browser and pinned in the
shape suite by the invariant that broke — a panel must lie across its own
approach, never along it.

The block/item split moved from 128 to 256 to fit sixteen door and bed variants;
only two lines in the codebase ever depended on it, and voxels are a Uint8Array
so 128 was never a storage limit. Item ids are now **generated** from a list
rather than written by hand, which retires the collision that had been fixed
four separate times.

That move exposed a genuine save hazard. The palette matches by name precisely
so ids can move freely — but renaming `door` to `door_north` meant every door
and bed in an existing world failed to resolve and loaded as **air**. A rename
is a compatibility event, and `RENAMED` in save.js is where it gets paid for. A
world saved by the previous shipped build is now loaded item by item as a test.

**The sustingus, rockets and the skateboard** — 58 headless assertions plus a
full in-browser pass. Each spin milestone scores exactly one spin and the biggest
one wins; a flip registers once per jump rather than once per frame; the
multiplier caps at 8; standing still banks a chain rather than losing it, and a
hard landing bails and pays nothing. A rocket fired straight up while riding was
measured at 5.6 blocks and 1.25 seconds — enough to clear Big Air — against 2.8
blocks at 45° and a fast, low 7-block launch fired level.

Three bugs worth recording. The rotation tracker discarded the first frame of a
spin, which is a rounding error everywhere except exactly on a milestone
boundary — a clean 540 scored as a 360. There is now a regression case with a
margin *tighter* than one frame. The combo readout relied on the HUD reading a
one-frame flag before the board cleared it, which meant a run banked outside the
update loop (stepping off the board does exactly that) could be wiped before
anything had shown it; events now carry a sequence number the HUD compares
against. And the rocket boost was originally weaker than an ordinary jump —
gravity is 28, so the first value bought 0.8 blocks against a jump's 2.1 — which
is what comes of picking a number by feel instead of against the physics.

**Rails, parks, progress, boats, wolves, signs, records, plates and food** —
110 headless assertions plus an in-browser pass on each. Grinding starts on
contact and stops on leaving, ignores a rail you are parked on or merely brushed,
holds the combo open, and pays by the second: a five-second grind measured 550
against 110 for one second, with the name changing to match. In-browser, a
20-block rail carried the player its whole length at a held 9.5 blocks/second.

Terrain went to **v4** for skate parks and mushrooms, and v3 worlds were checked
to generate with neither — a park levels ground at the *surface*, which is
exactly where people build, so the gate matters more here than it did for
dungeons. Parks are deterministic per cell, land only where the ground is
already nearly flat, and are written identically from every chunk that touches
them.

Pressure plates opened both halves of a door and closed them again on stepping
off; the first version checked the block *below* the feet rather than the one
they are in, which is right for a solid block and wrong for a thin one you stand
inside. Boats needed their own water-finding: `raycastVoxels` deliberately
ignores fluids, so a boat walks the ray itself looking for a water cell with air
above it. Measured at 7.5 blocks/second down a channel against 4.3 walking.

Signs round-trip their text through the save and render it in the world from a
canvas; jukeboxes insert, play, fade with distance, eject, and hand the record
back when broken. The **gear ids moved for the fourth time** to make room for
boats, bowls, apples and records — a world saved under the previous numbering
was loaded and every tool, item and the style score came back intact.

**The batch before** — 137 headless assertions across four suites, plus
in-browser checks of each feature. Particles: shards take their colour from the broken
block, settle on ground, ghosts fall through it, the pool caps at capacity
instead of growing. Farming: seeds drop from grass at the intended rate, a hoe
tills only soil, seeds plant only on farmland, crops run all four stages, a ripe
harvest gives grain and an unripe one only the seed, a crop whose soil is removed
dies. Merging: 30 stacks become 1, 100 become 64+36, different items and anything
carrying durability never merge. Weather: zero drops leak under a roof, taiga
gives snow and desert gives nothing, the sun drops from 1.5 to 0.9 under storm.
Dungeons: rooms are hollow with solid shells, chests stock once, and **v2 worlds
generate byte-identically with no dungeons at all**. Ambience: wind fades and the
drone rises as you descend.

A static **import checker** was added after a missing `export` reached the browser
— `node --check` validates syntax per file and says nothing about whether an
imported name exists, so all 350 named imports are now verified against their
targets' actual exports.

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
