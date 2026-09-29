/**
 * packs.js — Game content described as data.
 *
 * A content pack is one JSON file in /content, listed in content/packs.json.
 * It can add blocks and items (with textures painted from a small spec or a
 * pixel grid), recipes, smelting, fuels and loot tables, all referring to
 * things by their stable *names* — the same names saves use — so a pack never
 * needs to know an id. Jev's pick for Phase 3 (see JEV_DECISIONS.md): the
 * game's own recipes, smelting, fuels and loot moved into content/core.json as
 * the first users; anything generated from a material table (tools, armour,
 * slabs and stairs) stays in code beside that table.
 *
 * Loaded once, with top-level await, by every thread that needs content: the
 * page and the world worker both import blocks.js, which imports this, so a
 * pack block has an id and a texture before anything asks for one. A pack that
 * fails to load, or an entry naming something that does not exist, is skipped
 * with a console warning rather than stopping the game.
 */

const INDEX = new URL('../../content/packs.json', import.meta.url);

async function loadJson(url) {
  const module = await import(url.href, { with: { type: 'json' } });
  return module.default;
}

/** Every loaded pack, in load order. */
export const PACKS = [];

try {
  const index = await loadJson(INDEX);
  for (const file of index.packs ?? []) {
    try {
      const pack = await loadJson(new URL(file, INDEX));
      pack.name ??= file.replace(/\.json$/, '');
      PACKS.push(pack);
    } catch (error) {
      console.warn(`[packs] skipped ${file}: ${error.message}`);
    }
  }
} catch (error) {
  console.warn(`[packs] no pack index (${error.message}); running without content packs`);
}

/**
 * Every entry of one list kind ('blocks', 'items', 'recipes', 'smelting',
 * 'fuels') across all packs, in load order, each tagged with its pack.
 */
export function packEntries(kind) {
  const out = [];
  for (const pack of PACKS) {
    for (const entry of pack[kind] ?? []) {
      if (entry && typeof entry === 'object') out.push({ ...entry, pack: pack.name });
    }
  }
  return out;
}

/** Loot tables by name across all packs; a later pack replaces an earlier table. */
export function packLootTables() {
  const tables = {};
  for (const pack of PACKS) Object.assign(tables, pack.loot ?? {});
  return tables;
}
