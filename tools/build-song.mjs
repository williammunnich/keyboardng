// Build songs/song-of-storms.json from the reference MIDI transcription.
// Usage: node tools/build-song.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantizeNotes, trimOverlaps, finalizeSong } from '../js/songmodel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'songs/reference/windmill-hut-vgmusic.mid');

// ---- minimal SMF parser -> tracks of {t,d,p,v} in quarters ----
function parseMidi(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  p = 4; const hl = u32(); u16(); const ntr = u16(); const div = u16(); p = 8 + hl;
  const tracks = []; let bpm = 120, timeSig = null;
  for (let t = 0; t < ntr; t++) {
    p += 4; const len = u32(); const end = p + len; let tick = 0, rs = 0;
    const tr = { name: '', program: null, channel: null, notes: [] }; const on = new Map();
    while (p < end) {
      tick += vlq(); let st = buf[p];
      if (st & 0x80) { p++; if (st < 0xf0) rs = st; } else st = rs;
      if (st === 0xff) {
        const ty = buf[p++]; const l = vlq(); const d = buf.subarray(p, p + l); p += l;
        if (ty === 3) tr.name = d.toString('latin1');
        if (ty === 0x51) bpm = Math.round(60e6 / ((d[0] << 16) | (d[1] << 8) | d[2]));
        if (ty === 0x58 && !timeSig) timeSig = { num: d[0], den: 1 << d[1] };
      } else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
      else {
        const hi = st & 0xf0, ch = st & 0x0f;
        if (hi === 0xc0) { tr.program = buf[p++]; tr.channel = ch; }
        else if (hi === 0xd0) p++;
        else {
          const a = buf[p++], b = buf[p++];
          if (hi === 0x90 && b > 0) { on.set(a, [tick, b]); tr.channel = tr.channel ?? ch; }
          else if (hi === 0x80 || (hi === 0x90 && b === 0)) {
            const s = on.get(a);
            if (s) { tr.notes.push({ t: s[0] / div, d: (tick - s[0]) / div, p: a, v: s[1] }); on.delete(a); }
          }
        }
      }
    }
    p = end;
    tracks.push(tr);
  }
  return { tracks, bpm, timeSig };
}

const { tracks, bpm, timeSig } = parseMidi(fs.readFileSync(src));
const clean = i => trimOverlaps(quantizeNotes(tracks[i].notes, 0.5)).map(n => ({ t: n.t, d: n.d, p: n.p, v: n.v }));

// Reference track map (see analysis). The melody alternates instruments per pass:
//   3 accordion (bars 9-23, 53-67)  6 strings (bars 31-45, 75-89)
// and is doubled an octave up throughout: 4 flute (with the accordion), 7 music box (with the strings).
//   1 bass, 2 accordion chord vamp, 5 tambourine
// Piano reduction: the left-hand parts sit an octave below the accordion transcription so the chord vamp
// reads in the bass clef and the hands don't collide (chords D3–C4 region, bass D2–Bb2).
const down8 = notes => notes.map(n => ({ ...n, p: n.p - 12 }));
const bass = down8(clean(1));
const chords = down8(clean(2));
const withInstr = (notes, instr) => notes.map(n => ({ ...n, instr }));
const melody = [...withInstr(clean(3), 'accordion'), ...withInstr(clean(6), 'string_ensemble_1')].sort((a, b) => a.t - b.t);
const doubling = [...withInstr(clean(4), 'flute'), ...withInstr(clean(7), 'music_box')].sort((a, b) => a.t - b.t);
const perc = quantizeNotes(tracks[5].notes, 0.5).map(n => ({ t: n.t, d: 0.5, p: 54, v: n.v })); // tambourine

// Fix durations: the transcription cuts notes slightly short (e.g. 2.75 beats for a dotted half); restore full values.
function restore(notes, barLen = 3) {
  for (const n of notes) {
    const posInBar = n.t % barLen;
    const toBarEnd = barLen - posInBar;
    if (n.d > toBarEnd - 0.26 && n.d <= toBarEnd) n.d = toBarEnd; // held to the bar line
  }
  return notes;
}
restore(bass); restore(melody); restore(doubling); restore(chords);
// chord stabs are true eighths; the pickup E before Em is also an eighth (already)

// ---- hand-written fingering for the 15-bar melody phrase (43 notes), applied to every repetition ----
const PHRASE_FINGERS = [
  1, 2, 5, // D F D'
  1, 2, 5, // D F D'
  3, 4, 3, 4, // E' F' E' F'
  3, 2, 1, // E' C' A
  5, 1, 2, 3, // A D F G  (thumb lands on D)
  4, // A (held)
  4, 1, 2, 3, // A D F G
  2, // E (held)
  1, 2, 5,
  1, 2, 5,
  3, 4, 3, 4,
  3, 2, 1,
  5, 1, 2, 3,
  4, 4, // A A
  1, // D (held)
];
function fingerPhrases(notes) {
  // phrases start at bar 8, 30, 52 (74 for the music box): group notes into consecutive runs separated by gaps > 1 bar
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  let run = [];
  const flush = () => {
    if (run.length === PHRASE_FINGERS.length) run.forEach((n, i) => { n.f = PHRASE_FINGERS[i]; });
    run = [];
  };
  for (let i = 0; i < sorted.length; i++) {
    if (run.length && sorted[i].t - (run[run.length - 1].t + run[run.length - 1].d) > 3) flush();
    run.push(sorted[i]);
  }
  flush();
}
fingerPhrases(melody);
fingerPhrases(doubling);

// Left-hand fingering for bass notes
const BASS_FINGER = { 38: 5, 40: 4, 41: 3, 43: 2, 45: 1, 46: 1 }; // D2 E2 F2 G2 A2 Bb2
for (const n of bass) n.f = BASS_FINGER[n.p] ?? null;

// Chord vamp: left hand 5-3-1 (set by autoFinger for 3-note chords); lone pickup E gets finger 5
for (const n of chords) {
  const same = chords.filter(m => Math.abs(m.t - n.t) < 1e-6);
  if (same.length === 1) n.f = 5;
}

const song = {
  title: 'Song of Storms (Windmill Hut)',
  composer: 'Koji Kondo',
  source: 'Transcribed from the Ocarina of Time track; note data derived from the vgmusic.com Windmill Hut MIDI (songs/reference/windmill-hut-vgmusic.mid).',
  video: 'https://www.youtube.com/watch?v=UtgHZaq0EGs',
  bpm: bpm || 200,
  timeSig: timeSig || { num: 3, den: 4 },
  key: { fifths: -1, mode: 'minor' },
  bars: 88,
  sections: [
    { bar: 0, label: 'Intro vamp (accordion chords, bass, tambourine)' },
    { bar: 8, label: 'Melody 1 — accordion, flute an octave up' },
    { bar: 23, label: 'Vamp' },
    { bar: 30, label: 'Melody 2 — strings, music box an octave up' },
    { bar: 45, label: 'Vamp' },
    { bar: 52, label: 'Melody 3 — accordion, flute an octave up' },
    { bar: 67, label: 'Vamp' },
    { bar: 74, label: 'Melody 4 — strings, music box an octave up' },
  ],
  parts: [
    { id: 'melody', name: 'Melody', gmName: 'Accordion (passes 1 & 3), strings (passes 2 & 4)', instrument: 'accordion', clef: 'treble', hand: 'R', color: '#e4572e', playable: true, notes: melody },
    { id: 'doubling', name: 'Melody doubling, octave up', gmName: 'Flute / music box 8va — backing only, muted while you play the melody', instrument: 'music_box', clef: 'treble', hand: 'R', color: '#17bebb', playable: false, doubles: 'melody', notes: doubling },
    { id: 'chords', name: 'Chord vamp', gmName: 'Tango Accordion', instrument: 'tango_accordion', clef: 'bass', hand: 'L', color: '#ffc914', playable: true, notes: chords },
    { id: 'bass', name: 'Bass', gmName: 'Accordion bass', instrument: 'acoustic_bass', clef: 'bass', hand: 'L', color: '#76b041', playable: true, notes: bass },
    { id: 'perc', name: 'Tambourine', gmName: 'Tambourine', instrument: 'percussion', perc: true, playable: false, color: '#999999', notes: perc },
  ],
};

finalizeSong(song);
const out = path.join(root, 'songs/song-of-storms.json');
fs.writeFileSync(out, JSON.stringify(song));
console.log('wrote', out, 'bars', song.bars, 'bpm', song.bpm, song.timeSig, 'parts:', song.parts.map(p => `${p.id}=${p.notes.length}`).join(' '));
