/**
 * difficulty.js — Peaceful, Easy, Normal and Hard.
 *
 * Chosen when a world is created and changeable at any time from the pause
 * menu, as in Minecraft; Jev's pick (see JEV_DECISIONS.md). Everything that
 * cares reads the one shared `difficulty` object, so a change applies the
 * moment it is made, with nothing to re-wire.
 *
 * Normal is the game as it has always been balanced.
 */

export const DIFFICULTIES = {
  peaceful: {
    label: 'Peaceful',
    blurb: 'No monsters. Hunger never drops, and health comes back on its own.',
    hostiles: false,
    damage: 0.5,
    spawnScale: 0,
    hunger: false,
    starveFloor: 20,
    passiveRegen: true,
  },
  easy: {
    label: 'Easy',
    blurb: 'Monsters hit for half as much and turn up less. Starving stops at five hearts.',
    hostiles: true,
    damage: 0.5,
    spawnScale: 0.6,
    hunger: true,
    starveFloor: 10,
    passiveRegen: false,
  },
  normal: {
    label: 'Normal',
    blurb: 'The game as it is balanced. Starving stops at half a heart.',
    hostiles: true,
    damage: 1,
    spawnScale: 1,
    hunger: true,
    starveFloor: 1,
    passiveRegen: false,
  },
  hard: {
    label: 'Hard',
    blurb: 'Monsters hit half as hard again and come in bigger groups. Starving can kill.',
    hostiles: true,
    damage: 1.5,
    spawnScale: 1.35,
    hunger: true,
    starveFloor: 0,
    passiveRegen: false,
  },
};

export const DIFFICULTY_ORDER = ['peaceful', 'easy', 'normal', 'hard'];

/** The current world's difficulty. One shared object, read wherever it matters. */
export const difficulty = {
  id: 'normal',
  get rules() {
    return DIFFICULTIES[this.id] ?? DIFFICULTIES.normal;
  },
};

/** Set the difficulty; anything unknown (an old or edited save) becomes Normal. */
export function setDifficulty(id) {
  difficulty.id = DIFFICULTIES[id] ? id : 'normal';
  return difficulty.id;
}

/** The next difficulty along, for a button that cycles through them. */
export function nextDifficulty(id) {
  const i = DIFFICULTY_ORDER.indexOf(id);
  return DIFFICULTY_ORDER[(i + 1) % DIFFICULTY_ORDER.length];
}
