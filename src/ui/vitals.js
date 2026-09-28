/**
 * vitals.js — Health, hunger, armour and air, drawn as pixel art.
 *
 * These used to be emoji, which looked like a different game from the one the
 * blocks are painted in, and could not show a half heart at all without
 * fading the whole glyph. The icons here are painted the same way as the
 * block textures, from little ASCII maps, at 9x9 and doubled on screen.
 *
 * On top of the classic look is one modern touch, which Jev picked over plain
 * icons (see JEV_DECISIONS.md): hearts you have just lost linger as white
 * "ghost" hearts for a moment before draining away, so every hit reads.
 */

import { MAX_AIR } from '../player/player.js';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** On-screen size of one icon, in CSS pixels (9 art pixels, doubled). */
const ICON_PX = 18;

const HEART = [
  '.KK...KK.',
  'KHRK.KRRK',
  'KHRRKRRRK',
  'KRRRRRRRK',
  'KRRRRRRDK',
  '.KRRRRDK.',
  '..KRRDK..',
  '...KDK...',
  '....K....',
];

const DRUMSTICK = [
  '....KKK..',
  '...KRRHK.',
  '..KRRRRHK',
  '..KRRRRRK',
  '..KRRRRDK',
  '.KWKRRDK.',
  'KWWWKKK..',
  'KWWK.....',
  '.KK......',
];

const CHESTPLATE = [
  'KKK...KKK',
  'KRRK.KRRK',
  'KRRRKRRRK',
  '.KRHRRRK.',
  '.KRRRRRK.',
  '.KRRRRRK.',
  '.KRRRRDK.',
  '.KRRRRDK.',
  '..KKKKK..',
];

const BUBBLE = [
  '..KKKKK..',
  '.KRRRRRK.',
  'KRHHRRRRK',
  'KRHRRRRRK',
  'KRRRRRRRK',
  'KRRRRRRDK',
  'KRRRRRDDK',
  '.KRRRDDK.',
  '..KKKKK..',
];

const BUBBLE_POP = [
  '.........',
  '..K...K..',
  '...K.K...',
  '.K.....K.',
  '.........',
  '.K.....K.',
  '...K.K...',
  '..K...K..',
  '.........',
];

/**
 * Colour schemes. K outline, R body, H highlight, D shade, W bone, and E the
 * dim interior of an empty container.
 */
const SCHEMES = {
  heart: { K: '#2b0505', R: '#e0231b', H: '#ff9d9d', D: '#9e1010' },
  heartGold: { K: '#2e1d00', R: '#f2c230', H: '#fff2a8', D: '#b07d10' },
  heartGhost: { K: '#2b0505', R: '#f4e9e9', H: '#ffffff', D: '#cfbcbc' },
  heartEmpty: { K: '#2b0505', R: 'rgba(58,12,12,0.78)', H: 'rgba(58,12,12,0.78)', D: 'rgba(58,12,12,0.78)' },
  food: { K: '#2a1405', R: '#c46a2a', H: '#eba15c', D: '#7c3a12', W: '#f2e6cc' },
  foodEmpty: { K: '#2a1405', R: 'rgba(52,30,12,0.78)', H: 'rgba(52,30,12,0.78)', D: 'rgba(52,30,12,0.78)', W: 'rgba(52,30,12,0.78)' },
  armor: { K: '#1d2127', R: '#c9cfd6', H: '#ffffff', D: '#8b9098' },
  armorEmpty: { K: '#1d2127', R: 'rgba(40,44,50,0.72)', H: 'rgba(40,44,50,0.72)', D: 'rgba(40,44,50,0.72)' },
  bubble: { K: '#1f4d7a', R: 'rgba(160,216,255,0.72)', H: '#ffffff', D: '#5aa8e6' },
  pop: { K: '#a9dcff' },
};

/**
 * Paint an icon to a data URL.
 * @param half 'left' or 'right' keeps only that half, for half hearts etc.
 */
function paintIcon(art, scheme, half = null) {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 9;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      if (half === 'left' && x > 4) continue;
      if (half === 'right' && x < 4) continue;
      const colour = scheme[art[y][x]];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return `url(${canvas.toDataURL()})`;
}

let ICONS = null;

/** Painted on first use, since it needs a document to paint into. */
function icons() {
  if (ICONS) return ICONS;
  ICONS = {
    heart: paintIcon(HEART, SCHEMES.heart),
    heartHalf: paintIcon(HEART, SCHEMES.heart, 'left'),
    heartGold: paintIcon(HEART, SCHEMES.heartGold),
    heartGoldHalf: paintIcon(HEART, SCHEMES.heartGold, 'left'),
    ghost: paintIcon(HEART, SCHEMES.heartGhost),
    ghostHalf: paintIcon(HEART, SCHEMES.heartGhost, 'left'),
    heartEmpty: paintIcon(HEART, SCHEMES.heartEmpty),
    food: paintIcon(DRUMSTICK, SCHEMES.food),
    // Hunger drains from the left, so a half shank keeps its meaty right end.
    foodHalf: paintIcon(DRUMSTICK, SCHEMES.food, 'right'),
    foodEmpty: paintIcon(DRUMSTICK, SCHEMES.foodEmpty),
    armor: paintIcon(CHESTPLATE, SCHEMES.armor),
    armorHalf: paintIcon(CHESTPLATE, SCHEMES.armor, 'left'),
    armorEmpty: paintIcon(CHESTPLATE, SCHEMES.armorEmpty),
    bubble: paintIcon(BUBBLE, SCHEMES.bubble),
    pop: paintIcon(BUBBLE_POP, SCHEMES.pop),
  };
  return ICONS;
}

// ---------------------------------------------------------------------------
// Behaviour tuning
// ---------------------------------------------------------------------------

/** Seconds a lost heart stays as a ghost before it starts to drain. */
const GHOST_HOLD = 0.55;
/** How fast ghost hearts drain once they go, in health points per second. */
const GHOST_DRAIN = 14;
/** Health at or below which the hearts shake: two hearts, as in Minecraft. */
const LOW_HEALTH = 4;
/** Jitter redraws per second. Every frame would read as a blur, not a shake. */
const JITTER_HZ = 12;
/** Speed of the bounce that ripples along the hearts while you regenerate. */
const WAVE_SPEED = 26;
/** How long a burst bubble shows before it disappears. */
const POP_SECONDS = 0.3;

function makeRow(className) {
  const row = document.createElement('div');
  row.className = 'vitalRow ' + className;
  return row;
}

function makeIcon(row) {
  const icon = document.createElement('div');
  icon.className = 'vital';
  icon.style.width = icon.style.height = ICON_PX + 'px';
  icon._key = '';
  row.appendChild(icon);
  return icon;
}

/** Set an icon's layers, touching the DOM only when they actually change. */
function setLayers(icon, layers) {
  const key = layers.join(',');
  if (icon._key === key) return;
  icon._key = key;
  icon.style.backgroundImage = key;
}

/** Which of full/half/none a two-point pip shows for this value. */
function level(value, index) {
  const threshold = (index + 1) * 2;
  if (value >= threshold) return 'full';
  if (value >= threshold - 1) return 'half';
  return null;
}

export class Vitals {
  /** @param root the #stats element, emptied and rebuilt */
  constructor(root) {
    this.root = root;
    root.textContent = '';

    const left = document.createElement('div');
    left.className = 'vitalsCol';
    const right = document.createElement('div');
    right.className = 'vitalsCol right';

    this.armorRow = makeRow('');
    this.heartRow = makeRow('hearts');
    // Hunger and air fill from the right-hand end, as in Minecraft.
    this.airRow = makeRow('reverse');
    this.foodRow = makeRow('reverse');
    left.append(this.armorRow, this.heartRow);
    right.append(this.airRow, this.foodRow);
    root.append(left, right);

    this.hearts = [];
    this.food = Array.from({ length: 10 }, () => makeIcon(this.foodRow));
    this.armor = Array.from({ length: 10 }, () => makeIcon(this.armorRow));
    this.bubbles = Array.from({ length: 10 }, () => makeIcon(this.airRow));

    this._lastHealth = null;
    this._ghost = 0;
    this._ghostHold = 0;
    /** Seconds since the regeneration wave started, or -1 when there is none. */
    this._wave = -1;
    this._jitterClock = 0;
    this._lastBubbles = 10;
    this._pops = new Float32Array(10);
  }

  update(dt, player) {
    const s = player.survival;
    const art = icons();

    this._trackGhost(dt, s.health);
    this._jitterClock += dt;
    const jitterFrame = this._jitterClock >= 1 / JITTER_HZ;
    if (jitterFrame) this._jitterClock = 0;

    // ---- Hearts ------------------------------------------------------------
    // The cap can pass twenty (an awakened Comb throne raises it), so the row
    // grows to fit; hearts past the first ten are gold so they read as a boon.
    const count = Math.ceil(s.maxHealth / 2);
    while (this.hearts.length < count) this.hearts.push(makeIcon(this.heartRow));

    const shaking = s.health <= LOW_HEALTH && !s.dead;
    if (this._wave >= 0) {
      this._wave += dt;
      if (this._wave * WAVE_SPEED > count + 2) this._wave = -1;
    }

    for (let i = 0; i < this.hearts.length; i++) {
      const icon = this.hearts[i];
      if (i >= count) {
        icon.style.display = 'none';
        continue;
      }
      icon.style.display = '';

      const gold = i >= 10;
      const fill = level(s.health, i);
      const ghost = level(this._ghost, i);
      const layers = [];
      if (fill === 'full') layers.push(gold ? art.heartGold : art.heart);
      else if (fill === 'half') layers.push(gold ? art.heartGoldHalf : art.heartHalf);
      // A ghost only shows where it covers more than the real value does.
      if (ghost && fill !== 'full' && !(ghost === 'half' && fill === 'half')) {
        layers.push(ghost === 'full' ? art.ghost : art.ghostHalf);
      }
      layers.push(art.heartEmpty);
      setLayers(icon, layers);

      let offset = 0;
      if (shaking && jitterFrame) offset = Math.round(Math.random() * 2 - 1);
      else if (shaking) offset = icon._offset ?? 0;
      if (this._wave >= 0 && Math.abs(this._wave * WAVE_SPEED - i) < 1) offset -= 2;
      if (offset !== icon._offset) {
        icon._offset = offset;
        icon.style.transform = offset ? `translateY(${offset}px)` : '';
      }
    }

    // ---- Hunger --------------------------------------------------------------
    // With no saturation left the bar trembles, which is Minecraft's warning that
    // hunger is about to start dropping for real.
    const hungry = s.saturation <= 0 && s.hunger < s.maxHunger;
    for (let i = 0; i < 10; i++) {
      const icon = this.food[i];
      const fill = level(s.hunger, i);
      setLayers(icon, fill === 'full' ? [art.food, art.foodEmpty]
        : fill === 'half' ? [art.foodHalf, art.foodEmpty] : [art.foodEmpty]);
      if (jitterFrame) {
        const offset = hungry ? Math.round(Math.random() * 2 - 1) : 0;
        if (offset !== icon._offset) {
          icon._offset = offset;
          icon.style.transform = offset ? `translateY(${offset}px)` : '';
        }
      }
    }

    // ---- Armour: only while you are wearing some -------------------------------
    const points = player.inventory.armorPoints;
    this.armorRow.style.visibility = points > 0 ? 'visible' : 'hidden';
    if (points > 0) {
      for (let i = 0; i < 10; i++) {
        const fill = level(points, i);
        setLayers(this.armor[i], fill === 'full' ? [art.armor]
          : fill === 'half' ? [art.armorHalf, art.armorEmpty] : [art.armorEmpty]);
      }
    }

    // ---- Air: only while it is not full -----------------------------------------
    const air = player.air ?? MAX_AIR;
    const showAir = air < MAX_AIR - 0.01 && !player.creative;
    this.airRow.style.visibility = showAir ? 'visible' : 'hidden';
    const bubbles = Math.ceil((air / MAX_AIR) * 10);
    // A bubble you just lost bursts rather than vanishing.
    if (bubbles < this._lastBubbles) {
      for (let i = bubbles; i < this._lastBubbles; i++) this._pops[i] = POP_SECONDS;
    }
    this._lastBubbles = bubbles;
    for (let i = 0; i < 10; i++) {
      if (this._pops[i] > 0) this._pops[i] -= dt;
      setLayers(this.bubbles[i], i < bubbles ? [art.bubble] : this._pops[i] > 0 ? [art.pop] : ['none']);
    }
  }

  /**
   * Ghost health follows the real value up at once, but on the way down it
   * holds for a moment and then drains, which is what draws the eye to a hit.
   */
  _trackGhost(dt, health) {
    if (this._lastHealth === null) {
      this._ghost = health;
    } else if (health < this._lastHealth) {
      this._ghost = Math.max(this._ghost, this._lastHealth);
      this._ghostHold = GHOST_HOLD;
    } else if (health > this._lastHealth && Math.floor(health) > Math.floor(this._lastHealth)) {
      // A whole point regained: ripple along the row.
      this._wave = 0;
    }
    this._lastHealth = health;

    if (this._ghostHold > 0) this._ghostHold -= dt;
    else this._ghost = Math.max(health, this._ghost - GHOST_DRAIN * dt);
    if (this._ghost < health) this._ghost = health;
  }
}
