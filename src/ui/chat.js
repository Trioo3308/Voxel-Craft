/**
 * chat.js — Talking to the other players.
 *
 * T opens a line to type on: Enter sends, Escape cancels. Messages collect
 * above the hotbar and fade after a while, and all come back while the line
 * is open. Only shown while playing with others (net/session.js).
 *
 * Other players' names and words go in as text, never as markup.
 */

const el = (id) => document.getElementById(id);

/** Seconds a line stays up before it starts to fade. */
const SHOW_FOR = 10;
const FADE = 1.5;
/** Lines kept for scrolling back while typing. */
const KEEP = 60;
export const MAX_CHAT_LENGTH = 200;

export class Chat {
  constructor(game) {
    this.game = game;
    this.root = el('chat');
    this.log = el('chatLog');
    this.input = el('chatInput');
    this.isOpen = false;
    /** Called with the text of a line the player sends. */
    this.onSend = null;
    this.lines = [];

    this.input.maxLength = MAX_CHAT_LENGTH;
    this.input.addEventListener('keydown', (event) => {
      // The game's own key handling must not see what is typed here.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        const text = this.input.value.trim();
        if (text && this.onSend) this.onSend(text);
        this.game._closeContainer();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.game._closeContainer();
      }
    });
  }

  /** Shown while playing with others, hidden otherwise. */
  setVisible(visible) {
    this.root.classList.toggle('active', visible);
    if (!visible) this.clear();
  }

  open() {
    this.isOpen = true;
    this.root.classList.add('open');
    this.input.value = '';
    this.input.focus();
    this._paint();
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.input.blur();
    this._paint();
  }

  /**
   * @param {string} text
   * @param {{from?: string, kind?: 'chat'|'sys'}} [options]
   */
  add(text, { from = null, kind = 'chat' } = {}) {
    const line = document.createElement('div');
    line.className = `chatLine ${kind}`;
    if (from) {
      const name = document.createElement('b');
      name.textContent = `${from}: `;
      line.append(name);
    }
    line.append(document.createTextNode(text));
    this.log.append(line);
    this.lines.push({ element: line, age: 0 });
    while (this.lines.length > KEEP) this.lines.shift().element.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this._paint();
  }

  clear() {
    for (const line of this.lines) line.element.remove();
    this.lines = [];
  }

  update(dt) {
    for (const line of this.lines) line.age += dt;
    this._paint();
  }

  _paint() {
    for (const line of this.lines) {
      const fade = this.isOpen ? 1 : Math.max(0, Math.min(1, (SHOW_FOR + FADE - line.age) / FADE));
      line.element.style.opacity = String(fade);
    }
  }
}
