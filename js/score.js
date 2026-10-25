// score.js — renders song parts as sheet music with VexFlow (loaded globally as Vex.Flow) on a grand staff:
// right-hand parts become voices on a treble staff, left-hand parts voices on a bass staff. Includes fingering,
// ties, beams, section labels, bar numbers, note highlighting and a moving cursor.
import { buildMeasures, keyName, barLengthQuarters } from './songmodel.js';

const STAVE_H = 115;      // vertical space per staff
const SYSTEM_PAD = 40;    // extra space above each system for section labels
const BOTTOM_PAD = 40;    // room under the lowest staff for ledger lines and fingering
const LEFT_PAD = 20;

export class Score {
  constructor(container) {
    this.container = container;
    this.noteEls = new Map();   // `${partId}:${i}` -> [{el, note}]
    this.systems = [];          // [{bar0, bar1, y, h, measures:[{bar, x, w, x0, x1, events:[{pos, x}]}]}]
    this.cursorEl = null;
    this.song = null;
  }

  clear() {
    this.container.innerHTML = '';
    this.noteEls.clear();
    this.systems = [];
  }

  // opts: { parts: [partId...], fingerParts: Set, barsPerLine, zoom, startBar, endBar }
  render(song, opts) {
    const VF = window.Vex.Flow;
    this.clear();
    this.song = song;
    const parts = opts.parts.map(id => song.parts.find(p => p.id === id)).filter(Boolean);
    if (!parts.length) { this.container.innerHTML = '<p class="muted">No part selected to display.</p>'; return; }
    const zoom = opts.zoom || 1;
    const barsPerLine = opts.barsPerLine || 4;
    const widthPx = Math.max(480, this.container.clientWidth - 24);
    const width = widthPx / zoom;
    const startBar = opts.startBar ?? 0;
    const endBar = opts.endBar ?? song.bars;

    // staff layout: treble for right-hand parts, bass for left-hand parts
    const staffOf = p => (p.hand === 'L' || p.clef === 'bass') ? 'bass' : 'treble';
    const staffDefs = [];
    if (parts.some(p => staffOf(p) === 'treble')) staffDefs.push({ clef: 'treble', parts: parts.filter(p => staffOf(p) === 'treble') });
    if (parts.some(p => staffOf(p) === 'bass')) staffDefs.push({ clef: 'bass', parts: parts.filter(p => staffOf(p) === 'bass') });
    const measuresByPart = new Map(parts.map(p => [p.id, buildMeasures(p, song)]));

    const nSystems = Math.ceil((endBar - startBar) / barsPerLine);
    const systemH = staffDefs.length * STAVE_H + SYSTEM_PAD + BOTTOM_PAD;
    const totalH = nSystems * systemH + 40;

    const renderer = new VF.Renderer(this.container, VF.Renderer.Backends.SVG);
    renderer.resize(width * zoom, totalH * zoom);
    const ctx = renderer.getContext();
    ctx.scale(zoom, zoom);
    this.svg = this.container.querySelector('svg');
    this.svg.classList.add('score-svg');
    this.zoom = zoom;

    const key = keyName(song.key);
    const timeStr = `${song.timeSig.num}/${song.timeSig.den}`;
    const barLen = barLengthQuarters(song.timeSig);
    const beamGroups = VF.Beam.getDefaultBeamGroups(timeStr);
    const sectionAt = new Map((song.sections || []).map(s => [s.bar, s.label]));
    const REST_KEYS = { treble: ['b/4', 'd/5', 'g/4'], bass: ['d/3', 'f/3', 'b/2'] }; // single voice, upper voice, lower voice

    const pendingTie = new Map(parts.map(p => [p.id, null]));

    for (let s = 0; s < nSystems; s++) {
      const bar0 = startBar + s * barsPerLine;
      const bar1 = Math.min(endBar, bar0 + barsPerLine);
      const y0 = 20 + s * systemH + SYSTEM_PAD;
      const system = { bar0, bar1, y: y0 - SYSTEM_PAD, h: systemH, measures: [] };
      const firstW = 70 + (s === 0 ? 30 : 0);
      const inner = width - LEFT_PAD * 2;
      const mw = (inner - firstW) / (bar1 - bar0);
      let x = LEFT_PAD;
      for (let bar = bar0; bar < bar1; bar++) {
        const w = mw + (bar === bar0 ? firstW : 0);
        const staves = [];
        const allVoices = [];
        const voiceInfos = []; // {part, voice, evNotes, staffIdx, stemDir}
        staffDefs.forEach((sd, si) => {
          const stave = new VF.Stave(x, y0 + si * STAVE_H, w);
          if (bar === bar0) {
            stave.addClef(sd.clef).addKeySignature(key);
            if (s === 0) stave.addTimeSignature(timeStr);
          }
          if (si === 0) {
            stave.setMeasure(bar + 1);
            if (sectionAt.has(bar)) stave.setSection(sectionAt.get(bar), 0, 0, 11);
          }
          if (bar === bar1 - 1 && bar === song.bars - 1) stave.setEndBarType(VF.Barline.type.END);
          stave.setContext(ctx).draw();
          staves.push(stave);

          // parts with notes in this bar become voices; if none, a single whole rest
          const partMeasures = sd.parts.map(p => ({ part: p, measure: measuresByPart.get(p.id)[bar] }));
          const active = partMeasures.filter(pm => pm.measure.events.some(e => !e.rest));
          const toRender = active.length ? active : [partMeasures[0]];
          const multi = toRender.length > 1;
          const staffVoices = [];
          toRender.forEach((pm, vi) => {
            const { part, measure } = pm;
            const stemDir = multi ? (vi === 0 ? VF.Stem.UP : VF.Stem.DOWN) : null;
            const restKey = REST_KEYS[sd.clef][multi ? (vi === 0 ? 1 : 2) : 0];
            const showFingers = opts.fingerParts ? opts.fingerParts.has(part.id) : true;
            const notes = [];
            const evNotes = [];
            const emptyBar = !measure.events.some(e => !e.rest);
            const events = emptyBar ? [{ rest: true, whole: true, pos: 0, len: barLen, dur: 'w', dots: 0 }] : measure.events;
            for (const ev of events) {
              let sn;
              if (ev.whole) {
                sn = new VF.StaveNote({ keys: [restKey], duration: 'wr', clef: sd.clef });
                sn.setCenterAlignment(true);
              } else if (ev.rest) {
                sn = new VF.StaveNote({ keys: [restKey], duration: ev.dur + 'r', clef: sd.clef });
              } else {
                const cfg = { keys: ev.keys, duration: ev.dur, clef: sd.clef };
                if (stemDir) cfg.stem_direction = stemDir; else cfg.auto_stem = true;
                sn = new VF.StaveNote(cfg);
                if (showFingers && ev.first) {
                  ev.notes.forEach((n, idx) => {
                    if (n.f == null) return;
                    const fh = new VF.FretHandFinger(String(n.f));
                    const below = multi ? vi > 0 : part.hand === 'L';
                    fh.setPosition(below ? VF.Modifier.Position.BELOW : VF.Modifier.Position.ABOVE);
                    sn.addModifier(fh, idx);
                  });
                }
              }
              if (ev.dots) VF.Dot.buildAndAttach([sn], { all: true });
              notes.push(sn);
              evNotes.push({ ev, sn });
            }
            const voice = new VF.Voice({ num_beats: song.timeSig.num, beat_value: song.timeSig.den }).setStrict(false);
            voice.addTickables(notes);
            staffVoices.push(voice);
            allVoices.push(voice);
            voiceInfos.push({ part, voice, evNotes, staffIdx: si, stemDir });
          });
          VF.Accidental.applyAccidentals(staffVoices, key);
          sd._voices = staffVoices;
        });

        // format all voices of this measure together so the staves line up
        const formatter = new VF.Formatter();
        staffDefs.forEach(sd => formatter.joinVoices(sd._voices));
        const noteAreaW = w - (bar === bar0 ? firstW : 0) - 14;
        formatter.format(allVoices, Math.max(40, noteAreaW));
        const beamsAll = [];
        for (const vi of voiceInfos) {
          const cfg = { groups: beamGroups };
          if (vi.stemDir) cfg.stem_direction = vi.stemDir;
          beamsAll.push(...VF.Beam.generateBeams(vi.voice.getTickables(), cfg));
        }
        for (const vi of voiceInfos) vi.voice.draw(ctx, staves[vi.staffIdx]);
        beamsAll.forEach(b => b.setContext(ctx).draw());

        // ties, element map, cursor anchors
        const measureInfo = { bar, x, w, x0: staves[0].getNoteStartX() + 6, x1: staves[0].getNoteEndX() - 4, events: [] };
        const anchorSeen = new Set();
        const tiedParts = new Set();
        for (const vi of voiceInfos) {
          const part = vi.part;
          tiedParts.add(part.id);
          let prev = pendingTie.get(part.id);
          for (const { ev, sn } of vi.evNotes) {
            if (!ev.rest) {
              const el = sn.getSVGElement();
              if (el) {
                el.classList.add('part-' + part.id);
                for (const n of ev.notes) {
                  const k = `${part.id}:${n.i}`;
                  if (!this.noteEls.has(k)) this.noteEls.set(k, []);
                  this.noteEls.get(k).push({ el, system: s, note: n });
                }
              }
              const idx = ev.keys.map((_, i) => i);
              if (ev.tieFrom && prev) new VF.StaveTie({ first_note: prev.sn, last_note: sn, first_indices: idx, last_indices: idx }).setContext(ctx).draw();
              else if (ev.tieFrom && !prev) new VF.StaveTie({ last_note: sn, last_indices: idx }).setContext(ctx).draw();
              prev = ev.tieTo ? { sn, ev } : null;
              const pk = ev.pos.toFixed(3);
              if (!anchorSeen.has(pk)) { anchorSeen.add(pk); measureInfo.events.push({ pos: ev.pos, x: sn.getAbsoluteX() }); }
            } else if (!ev.whole) prev = null;
          }
          if (prev && bar === bar1 - 1) new VF.StaveTie({ first_note: prev.sn, first_indices: prev.ev.keys.map((_, i) => i) }).setContext(ctx).draw();
          pendingTie.set(part.id, prev);
        }
        for (const p of parts) if (!tiedParts.has(p.id)) pendingTie.set(p.id, null);
        measureInfo.events.sort((a, b) => a.pos - b.pos);

        // connectors
        if (staves.length > 1) {
          const top = staves[0], bottom = staves[staves.length - 1];
          if (bar === bar0) {
            new VF.StaveConnector(top, bottom).setType(VF.StaveConnector.type.BRACE).setContext(ctx).draw();
            new VF.StaveConnector(top, bottom).setType(VF.StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
          }
          new VF.StaveConnector(top, bottom).setType(VF.StaveConnector.type.SINGLE_RIGHT).setContext(ctx).draw();
        }
        system.measures.push(measureInfo);
        x += w;
      }
      this.systems.push(system);
    }
    this.barLen = barLen;
    // cursor
    const ns = 'http://www.w3.org/2000/svg';
    this.cursorEl = document.createElementNS(ns, 'rect');
    this.cursorEl.setAttribute('class', 'cursor');
    this.cursorEl.setAttribute('width', 2);
    this.cursorEl.setAttribute('rx', 1);
    this.svg.appendChild(this.cursorEl);
    this.setCursor(startBar * barLen, false);
  }

  elementsFor(partId, i) { return this.noteEls.get(`${partId}:${i}`) || []; }

  setClass(partId, i, cls, on) {
    for (const { el } of this.elementsFor(partId, i)) el.classList.toggle(cls, on);
  }

  clearClass(cls) {
    if (!this.svg) return;
    for (const el of this.svg.querySelectorAll('.' + cls)) el.classList.remove(cls);
  }

  // Find x for a beat position: the cursor glides linearly between bar start, note onsets and bar end.
  locate(beat) {
    if (!this.systems.length) return null;
    const bar = Math.floor(beat / this.barLen + 1e-6);
    const sys = this.systems.find(s => bar >= s.bar0 && bar < s.bar1) || (bar >= this.systems[this.systems.length - 1].bar1 ? this.systems[this.systems.length - 1] : this.systems[0]);
    const m = sys.measures.find(mm => mm.bar === bar) || sys.measures[sys.measures.length - 1];
    const pos = Math.max(0, Math.min(this.barLen, beat - bar * this.barLen));
    const anchors = [{ pos: 0, x: m.x0 }];
    for (const e of m.events) {
      if (e.pos < 1e-6) anchors[0] = { pos: 0, x: e.x };
      else if (e.pos < this.barLen - 1e-6) anchors.push({ pos: e.pos, x: e.x });
    }
    anchors.push({ pos: this.barLen, x: m.x1 });
    let a = anchors[0], b = anchors[anchors.length - 1];
    for (let i = 0; i + 1 < anchors.length; i++) {
      if (pos >= anchors[i].pos - 1e-6 && pos <= anchors[i + 1].pos + 1e-6) { a = anchors[i]; b = anchors[i + 1]; break; }
    }
    const span = b.pos - a.pos;
    const frac = span > 1e-6 ? Math.max(0, Math.min(1, (pos - a.pos) / span)) : 0;
    return { x: a.x + (b.x - a.x) * frac, sys };
  }

  setCursor(beat, scroll = true) {
    const loc = this.locate(beat);
    if (!loc || !this.cursorEl) return;
    this.cursorEl.setAttribute('x', (loc.x - 1) * this.zoom);
    this.cursorEl.setAttribute('y', (loc.sys.y + SYSTEM_PAD - 10) * this.zoom);
    this.cursorEl.setAttribute('height', (loc.sys.h - SYSTEM_PAD - BOTTOM_PAD + 30) * this.zoom);
    if (scroll && loc.sys !== this._scrolledSys) {
      this._scrolledSys = loc.sys;
      const wrap = this.container.parentElement;
      const top = loc.sys.y * this.zoom;
      wrap.scrollTo({ top: Math.max(0, top - 10), behavior: 'smooth' });
    }
  }
}
