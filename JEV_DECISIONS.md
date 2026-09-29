# Design decisions made by Jev

Jev (TypeSafe System One, `jev-1.13.0`) makes the design calls on this project;
Claude drafts the options and implements the pick. Probabilities are Jev's.

## QoL and detailing update (2026-09-28)

| Question | Pick | p | Runner-up | Applied as |
|---|---|---|---|---|
| Death penalty | Gravestone | 0.79 | Drop at death (0.17) | Everything carried goes into a gravestone at the death spot; never expires; one right-click returns it; compass marker |
| Sky | Hybrid | 0.91 | Classic pixel (0.08) | Pixel sun and moon with phases, painted gradient + horizon glow, stars and faint milky way, 3D voxel clouds with sunset-lit undersides |
| Health/hunger HUD | Pixel icons with ghost hearts | 0.90 | Pixel icons (0.10) | Procedurally painted hearts, drumsticks, armour and air bubbles; lost hearts linger as white ghosts, then drain |
| Recipe discovery | Browser + recipe book | 0.82 | Recipe book (0.16) | Searchable browser; craftable-now pinned first; click a recipe to fill the grid; click an item for how it is made and what it is used for |
| Navigation | Compass strip | 0.68 | World map (0.20) | Strip across the top: directions, bed, gravestone, lit portals and named waypoints with distances |
| Title screen | Panorama + thumbnails | 0.76 | Panorama (0.21) | Live orbit over a generated world behind the menu; each world row gets a thumbnail from its last save |
| Starvation | Stops at half a heart | 0.48 | Kills (0.42) | Close call. Starvation can no longer kill on its own, but at half a heart any other damage still does |

### Priority scores (0 = unnoticed, 4 = highlight of the update)

| Change | Score | Shipped |
|---|---|---|
| Ambient particles (falling leaves, fireflies, Nether ash, Aether sparkles) | 2.57 | yes |
| Wind sway on leaves and plants | 2.40 | yes |
| Drowning and air meter | 2.31 | yes |
| Cracks on the block while mining | 2.26 | yes |
| Rippling water and caustics | 2.20 | yes |
| Item magnet pickup | 2.15 | yes |
| Mob hit flash and death puff | 2.09 | yes |
| Pick block (middle click) | 2.04 | yes |
| Damage direction indicator | 1.91 | yes |
| First-person hand animation | 1.91 | yes |
| Hunger cost of healing matched to Minecraft | 1.80 | yes |
| FOV kick when sprinting / boosting | 1.62 | yes |
| Achievement toasts with icons | 1.51 | yes |
| Optional auto-jump | 1.50 | yes |
| Sound captions | 1.16 | no, below the cut |

### Second round: direction (2026-09-28)

Asked once the owner opened up a full visual rework and called the synthesised
audio "literally the worst".

| Question | Pick | p | Runner-up | Applied as |
|---|---|---|---|---|
| Visual direction | Modern voxel | 0.95 | Storybook (0.05) | Sun/moon shadow map following the player, HDR with Neutral tone mapping, bloom on emissive blocks, sun-tinted fog, time-of-day grade; Graphics option (auto/high/medium/low) |
| Audio | Hybrid | 0.75 | CC0 recordings only (0.25) | 155 recordings from three Kenney CC0 packs for all foley and menus; synthesis kept for jukebox tunes and invented creatures; cave reverb and distance filtering |
| Menu style | Pixel glass | 0.92 | Crafted wood (0.07) | Dark glass panels with a pixel bevel, Pixelify Sans, sunken slots, accent colour per dimension |

### Third round: map, difficulty and captions (2026-09-28)

| Question | Pick | p | Runner-up | Applied as |
|---|---|---|---|---|
| World map style | Satellite on parchment | 0.57 | Plain satellite (0.40) | Top-down view of explored ground, hill-shaded, water darkening with depth, on a painted parchment sheet with a compass rose |
| Opening the map | A key, any time | 0.60 | Key plus minimap (0.29) | `M` opens it anywhere; the runner-up's minimap became an Interface option, off by default |
| What the map shows | Explored only | 0.95 | Explored plus rumours (0.03) | Only ground you have been near is drawn; the rest stays fog |
| Difficulty | Presets, changeable any time | 0.70 | Fixed at creation (0.18) | Peaceful, Easy, Normal, Hard: picked when creating a world, changeable from the pause menu |
| Caption style | List in the corner | 0.49 | Placed at the screen edge (0.29) | Bottom-right list, newest last; each caption keeps an arrow pointing at its source, folded in from the runner-up |
| Captions on by default | No | 0.54 | Yes (0.46) | Off by default, one switch in Interface settings |

Extras, on the first round's scale (0 = unnoticed, 4 = highlight of the update):

| Change | Score | Shipped |
|---|---|---|
| Mobs and items lit by the light where they stand; glowing mobs cast light | 2.96 | yes |
| Structures marked on the map and compass when first found | 2.75 | yes |
| A held torch lights the area around you | 2.60 | yes |
| The map keeps every death, not just the latest grave | 1.55 | yes, nearly free once the map existed |

### Fourth round: spending the renderer's headroom (2026-09-28)

Asked after greedy meshing landed and the shader took over the atlas lookup.
Scale: 0 = not worth doing now, 3 = clearly worth doing now.

| Change | Score | Shipped |
|---|---|---|
| Per-block turning and flipping of ground textures | 2.39 | yes |
| Fast leaves on the Low graphics tier | 2.30 | yes |
| Second paintings of the commonest ground blocks | 1.99 | yes, as re-seeded paintings rather than hand-drawn ones |
| Merging faces whose light varies along one axis only | 0.79 | no; about 4% fewer triangles for real mesher complexity |

## Phase 3: depth, distance and company (2026-09-29)

Five reworks from the roadmap, asked together.

| Question | Pick | p | Runner-up | Applied as |
|---|---|---|---|---|
| How much content moves into data | Content packs | 0.88 | Recipes and loot only (0.10) | Built-in blocks stay in code; a JSON pack loader adds blocks (painted from a small spec or a pixel grid), items, recipes, smelting, fuels, loot, mining XP and advancements. The game's own recipes, smelting and loot moved into `content/core.json`; `content/decor.json` is the worked example |
| XP and enchanting | Classic | 0.87 | Pick-your-enchantment (0.08) | Orbs from mobs, ores, smelting, breeding and fishing; a level bar; an enchanting table offering three rolls boosted by up to fifteen bookshelves, paid in levels and lapis; an anvil for books, merging and repairs; fifteen enchantments, Mending only as loot |
| Progression | Advancement tree with recipe discovery | 0.85 | Tree with "new" badges (0.12) | Tabs per stage and dimension, nodes hidden until their parent is earned, drag to look around; recipes appear in the book when you first hold their telling ingredient |
| Far rendering | Distant terrain | 0.92 | Simplified far chunks (0.06) | Heightfield tiles from the seed out to 512 blocks, coarser with distance, masked chunk by chunk under real terrain; a second, coarser shadow map over the loaded area on High |
| Multiplayer transport | Both | 0.71 | Join codes only (0.22) | WebRTC with six-character join codes through a Netlify Function mailbox, plus a WebSocket relay in `npm run host` for same-network play; one protocol over either |
| Multiplayer scope | Building and presence | 0.88 | Full co-op (0.12) | Shared block edits in every dimension, one-at-a-time chests and furnaces, avatars with name tags and held items, chat, and the host's clock and weather; mobs, drops and survival stay each player's own, with guests' belongings kept in the host's save by name |
