// keyboard.js — on-screen piano (SVG). Shows pressed keys, target keys with finger numbers, wrong notes, note names.
import { isBlackKey, spellPitch, midiToName } from './songmodel.js';

const WHITE_W = 26, WHITE_H = 120, BLACK_W = 16, BLACK_H = 76;
const BLACK_OFFSET = { 1: 0.62, 3: 0.72, 6: 0.60, 8: 0.66, 10: 0.73 }; // visual offsets within octave

export class PianoKeyboard {
  constructor(container, { lo = 36, hi = 84, onPress, onRelease, key } = {}) {
    this.container = container;
    this.lo = lo; this.hi = hi;
    this.onPress = onPress; this.onRelease = onRelease;
    this.key = key || { fifths: 0, mode: 'major' };
    this.pressed = new Set();
    this.wrong = new Set();
    this.targets = new Map(); // pitch -> {finger, color}
    this.showNames = true;
    this.middleC = 60;
    this.render();
  }

  setKey(key) { this.key = key; this.render(); }
  setRange(lo, hi) { this.lo = lo; this.hi = hi; this.render(); }

  render() {
    const whites = [];
    for (let p = this.lo; p <= this.hi; p++) if (!isBlackKey(p)) whites.push(p);
    const width = whites.length * WHITE_W;
    const svg = [`<svg viewBox="0 0 ${width} ${WHITE_H + 18}" width="100%" preserveAspectRatio="xMidYMid meet" class="piano">`];
    const xOf = new Map();
    whites.forEach((p, i) => xOf.set(p, i * WHITE_W));
    // whites
    for (const p of whites) {
      const x = xOf.get(p);
      const nm = spellPitch(p, this.key).name;
      svg.push(`<g class="key white" data-p="${p}"><rect x="${x + 0.5}" y="0" width="${WHITE_W - 1}" height="${WHITE_H}" rx="3"/>` +
        `<text class="kname" x="${x + WHITE_W / 2}" y="${WHITE_H - 8}">${p % 12 === 0 ? nm : nm.replace(/\d/, '')}</text>` +
        `<text class="finger" x="${x + WHITE_W / 2}" y="${WHITE_H - 30}"></text></g>`);
      if (p === this.middleC) svg.push(`<circle class="midc" cx="${x + WHITE_W / 2}" cy="${WHITE_H - 48}" r="3"/>`);
    }
    // blacks
    for (let p = this.lo; p <= this.hi; p++) {
      if (!isBlackKey(p)) continue;
      const below = p - 1; // white key to the left
      if (!xOf.has(below)) continue;
      const x = xOf.get(below) + WHITE_W * BLACK_OFFSET[p % 12] + (WHITE_W - BLACK_W) / 2 - WHITE_W * 0.5 + WHITE_W * 0.5;
      const bx = xOf.get(below) + WHITE_W - BLACK_W / 2 + (BLACK_OFFSET[p % 12] - 0.66) * WHITE_W;
      void x;
      const nm = spellPitch(p, this.key).name.replace(/\d/, '');
      svg.push(`<g class="key black" data-p="${p}"><rect x="${bx}" y="0" width="${BLACK_W}" height="${BLACK_H}" rx="2"/>` +
        `<text class="kname" x="${bx + BLACK_W / 2}" y="${BLACK_H - 6}">${nm}</text>` +
        `<text class="finger" x="${bx + BLACK_W / 2}" y="${BLACK_H - 22}"></text></g>`);
    }
    // octave labels under C keys
    for (const p of whites) if (p % 12 === 0) svg.push(`<text class="oct" x="${xOf.get(p) + WHITE_W / 2}" y="${WHITE_H + 14}">${midiToName(p)}</text>`);
    svg.push('</svg>');
    this.container.innerHTML = svg.join('');
    this.svg = this.container.querySelector('svg');
    this.keys = new Map();
    for (const g of this.svg.querySelectorAll('g.key')) this.keys.set(+g.dataset.p, g);
    // mouse / touch input
    const down = (ev) => {
      const g = ev.target.closest('g.key'); if (!g) return;
      ev.preventDefault();
      const p = +g.dataset.p;
      this._mouseHeld = p;
      this.onPress?.(p);
    };
    const up = () => { if (this._mouseHeld != null) { this.onRelease?.(this._mouseHeld); this._mouseHeld = null; } };
    this.svg.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    this.svg.addEventListener('pointerleave', up);
    this.svg.classList.toggle('names', this.showNames);
    this.update();
  }

  setShowNames(v) { this.showNames = v; this.svg?.classList.toggle('names', v); }

  press(p) { this.pressed.add(p); this.update(); }
  release(p) { this.pressed.delete(p); this.wrong.delete(p); this.update(); }
  markWrong(p) { this.wrong.add(p); this.update(); }
  setTargets(list) {
    this.targets = new Map();
    for (const t of list) this.targets.set(t.p, t);
    this.update();
  }

  update() {
    if (!this.keys) return;
    for (const [p, g] of this.keys) {
      const t = this.targets.get(p);
      g.classList.toggle('pressed', this.pressed.has(p));
      g.classList.toggle('wrong', this.wrong.has(p));
      g.classList.toggle('target', !!t);
      g.classList.toggle('hit', !!t && this.pressed.has(p));
      const ft = g.querySelector('.finger');
      ft.textContent = t && t.finger ? String(t.finger) : '';
      if (t && t.color) g.style.setProperty('--target', t.color); else g.style.removeProperty('--target');
    }
  }
}
