// songmodel.js — pure data helpers shared by the node build script and the browser app.
// All times are in quarter-note units ("beats"); internally we use integer ticks (TPQ per quarter).

export const TPQ = 48; // ticks per quarter note (divisible by 16ths and triplets)

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function midiToName(p, flats = false) {
  const names = flats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return names[p % 12] + (Math.floor(p / 12) - 1);
}

export function isBlackKey(p) {
  return [1, 3, 6, 8, 10].includes(p % 12);
}

// VexFlow key signature name for a {fifths, mode} key.
const MAJOR_KEYS = { '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' };
const MINOR_KEYS = { '-7': 'Abm', '-6': 'Ebm', '-5': 'Bbm', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm', 0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m', 6: 'D#m', 7: 'A#m' };
export function keyName(key) {
  const k = key || { fifths: 0, mode: 'major' };
  return (k.mode === 'minor' ? MINOR_KEYS : MAJOR_KEYS)[String(k.fifths)] || 'C';
}

// Spell a MIDI pitch for a key: returns {letter, acc, octave, vexKey, name}
export function spellPitch(p, key) {
  const k = key || { fifths: 0, mode: 'major' };
  const pc = p % 12;
  let octave = Math.floor(p / 12) - 1;
  const useFlats = k.fifths < 0;
  let letter, acc = '';
  if (!isBlackKey(pc)) {
    letter = LETTERS[[0, 2, 4, 5, 7, 9, 11].indexOf(pc)];
  } else {
    // leading-tone exceptions in flat minor keys: Dm -> C#, Gm -> F#
    const sharpException = k.mode === 'minor' && ((k.fifths === -1 && pc === 1) || (k.fifths === -2 && pc === 6));
    if (useFlats && !sharpException) {
      letter = LETTERS[[0, 2, 4, 5, 7, 9, 11].indexOf(pc + 1)];
      acc = 'b';
    } else {
      letter = LETTERS[[0, 2, 4, 5, 7, 9, 11].indexOf(pc - 1)];
      acc = '#';
    }
  }
  return { letter, acc, octave, vexKey: `${letter}${acc}/${octave}`, name: `${letter.toUpperCase()}${acc}${octave}` };
}

// Diatonic (white-key) index of a pitch: used for fingering distances.
export function whiteIndex(p) {
  const pc = p % 12;
  const oct = Math.floor(p / 12);
  const w = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc];
  return oct * 7 + w;
}

export function barLengthQuarters(timeSig) {
  return timeSig.num * 4 / timeSig.den;
}

// Snap note starts/durations to a grid (in quarters). Keeps playback-friendly values.
export function quantizeNotes(notes, grid = 0.25) {
  return notes.map(n => {
    const t = Math.round(n.t / grid) * grid;
    let d = Math.round(n.d / grid) * grid;
    if (d < grid) d = grid;
    return { ...n, t, d };
  });
}

// For monophonic lines, shorten notes that overlap the next note start (legato clean-up).
export function trimOverlaps(notes) {
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.p - b.p);
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    let j = i + 1;
    while (j < sorted.length && sorted[j].t === n.t) j++;
    if (j < sorted.length && n.t + n.d > sorted[j].t && sorted[j].t > n.t) n.d = sorted[j].t - n.t;
  }
  return sorted;
}

// Renderable durations in quarters -> VexFlow duration codes.
const DUR_TABLE = [
  [4, 'w', 0], [3, 'h', 1], [2, 'h', 0], [1.5, 'q', 1], [1, 'q', 0],
  [0.75, '8', 1], [0.5, '8', 0], [0.375, '16', 1], [0.25, '16', 0],
];

// Decompose a duration starting at offset `pos` (quarters within the bar) into renderable chunks.
export function decompose(pos, len, barLen) {
  const chunks = [];
  let p = pos, remaining = len;
  let guard = 0;
  while (remaining > 1e-6 && guard++ < 64) {
    let pick = null;
    for (const [d, code, dots] of DUR_TABLE) {
      if (d > remaining + 1e-6) continue;
      if (d > barLen + 1e-6) continue;
      // alignment rules
      if (d >= 3 && Math.abs(p % 3) > 1e-6 && Math.abs(p) > 1e-6) continue;
      if (d >= 1 && Math.abs(p % 1) > 1e-6) continue;
      if (d >= 0.5 && Math.abs(p % 0.5) > 1e-6) continue;
      if (d >= 0.375 && Math.abs(p % 0.25) > 1e-6) continue;
      // a 4/4 half note should not straddle the middle unless it starts on beat 0 or 2
      if (barLen === 4 && d === 2 && Math.abs(p % 2) > 1e-6) continue;
      if (barLen === 4 && d === 3 && Math.abs(p) > 1e-6 && Math.abs(p - 1) > 1e-6) continue;
      pick = [d, code, dots];
      break;
    }
    if (!pick) pick = [0.25, '16', 0];
    chunks.push({ len: pick[0], dur: pick[1], dots: pick[2] });
    p += pick[0];
    remaining -= pick[0];
  }
  return chunks;
}

// Build measures for score rendering.
// part.notes: [{t, d, p, v, f, i}] with t/d in quarters. Returns array of measures:
// { bar, events: [{ pos, len, dur, dots, rest, keys, notes:[note], tieFrom, tieTo }] }
export function buildMeasures(part, song) {
  const barLen = barLengthQuarters(song.timeSig);
  const totalBars = song.bars;
  const key = song.key;
  const byBar = Array.from({ length: totalBars }, () => []);
  for (const n of part.notes) {
    let start = n.t, end = n.t + n.d;
    let first = true;
    while (start < end - 1e-6) {
      const bar = Math.floor(start / barLen + 1e-6);
      if (bar >= totalBars) break;
      const barEnd = (bar + 1) * barLen;
      const segEnd = Math.min(end, barEnd);
      byBar[bar].push({ pos: start - bar * barLen, len: segEnd - start, note: n, tieFrom: !first, tieTo: segEnd < end - 1e-6 });
      start = segEnd;
      first = false;
    }
  }
  const measures = [];
  for (let bar = 0; bar < totalBars; bar++) {
    const segs = byBar[bar].sort((a, b) => a.pos - b.pos || a.note.p - b.note.p);
    // group by start position
    const groups = [];
    for (const s of segs) {
      const g = groups.length && Math.abs(groups[groups.length - 1].pos - s.pos) < 1e-6 ? groups[groups.length - 1] : null;
      if (g) g.segs.push(s); else groups.push({ pos: s.pos, segs: [s] });
    }
    const events = [];
    let cursor = 0;
    const pushRests = (from, to) => {
      if (to - from < 1e-6) return;
      for (const c of decompose(from, to - from, barLen)) {
        events.push({ pos: from, len: c.len, dur: c.dur, dots: c.dots, rest: true, keys: [], notes: [] });
        from += c.len;
      }
    };
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.pos > cursor + 1e-6) pushRests(cursor, g.pos);
      // chord duration: shortest segment, but never past the next group start
      let len = Math.min(...g.segs.map(s => s.len));
      const nextPos = gi + 1 < groups.length ? groups[gi + 1].pos : barLen;
      if (g.pos + len > nextPos + 1e-6) len = nextPos - g.pos;
      if (len < 0.25 - 1e-6) len = 0.25;
      const chunks = decompose(g.pos, len, barLen);
      let pos = g.pos;
      chunks.forEach((c, ci) => {
        events.push({
          pos, len: c.len, dur: c.dur, dots: c.dots, rest: false,
          keys: g.segs.map(s => spellPitch(s.note.p, key).vexKey),
          notes: g.segs.map(s => s.note),
          tieFrom: ci > 0 || g.segs.some(s => s.tieFrom),
          tieTo: ci < chunks.length - 1 || (ci === chunks.length - 1 && g.segs.some(s => s.tieTo)),
          first: ci === 0,
        });
        pos += c.len;
      });
      cursor = g.pos + len;
    }
    if (cursor < barLen - 1e-6) pushRests(cursor, barLen);
    if (!events.length) {
      for (const c of decompose(0, barLen, barLen)) events.push({ pos: 0, len: c.len, dur: c.dur, dots: c.dots, rest: true, keys: [], notes: [] });
    }
    measures.push({ bar, events });
  }
  return measures;
}

// ---------- Fingering ----------
// Simple heuristic fingering for a part. hand: 'R' or 'L'. Only fills notes without an explicit `f`.
export function autoFinger(part) {
  const hand = part.hand || (part.clef === 'bass' ? 'L' : 'R');
  const notes = [...part.notes].sort((a, b) => a.t - b.t || a.p - b.p);
  // group chords
  const groups = [];
  for (const n of notes) {
    const g = groups.length && Math.abs(groups[groups.length - 1].t - n.t) < 1e-6 ? groups[groups.length - 1] : null;
    if (g) g.notes.push(n); else groups.push({ t: n.t, notes: [n] });
  }
  let thumbW = null; // white index under the thumb
  for (const g of groups) {
    if (g.notes.length > 1) {
      const sorted = [...g.notes].sort((a, b) => a.p - b.p);
      const span = whiteIndex(sorted[sorted.length - 1].p) - whiteIndex(sorted[0].p);
      let fingers;
      if (sorted.length === 2) fingers = span <= 2 ? [1, 3] : span <= 4 ? [1, 4] : [1, 5];
      else if (sorted.length === 3) fingers = span <= 4 ? [1, 3, 5] : [1, 2, 5];
      else if (sorted.length === 4) fingers = [1, 2, 3, 5];
      else fingers = [1, 2, 3, 4, 5];
      if (hand === 'R') sorted.forEach((n, i) => { if (n.f == null) n.f = fingers[i]; });
      else sorted.forEach((n, i) => { if (n.f == null) n.f = fingers[sorted.length - 1 - i]; });
      thumbW = hand === 'R' ? whiteIndex(sorted[0].p) : whiteIndex(sorted[sorted.length - 1].p);
      continue;
    }
    const n = g.notes[0];
    const w = whiteIndex(n.p);
    if (n.f != null) {
      thumbW = hand === 'R' ? w - (n.f - 1) : w + (n.f - 1);
      continue;
    }
    if (thumbW == null) {
      // first note: put it under a comfortable finger
      n.f = hand === 'R' ? 1 : 5;
      thumbW = hand === 'R' ? w : w + 4;
      continue;
    }
    let off = hand === 'R' ? w - thumbW : thumbW - w; // 0..4 fits the hand
    if (off >= 0 && off <= 4) {
      n.f = off + 1;
    } else if (off > 4) {
      // move up: land on finger 5 if small jump else thumb repositions
      if (off <= 6) { n.f = 5; thumbW = hand === 'R' ? w - 4 : w + 4; }
      else { n.f = hand === 'R' ? 1 : 1; thumbW = hand === 'R' ? w : w; }
    } else {
      // below the thumb
      if (off >= -2) { n.f = 1; thumbW = hand === 'R' ? w : w; }
      else { n.f = hand === 'R' ? 2 : 5; thumbW = hand === 'R' ? w - 1 : w + 4; }
    }
    if (isBlackKey(n.p) && n.f === 1 && off !== 0) {
      // avoid thumb on a black key when possible
      n.f = 2; thumbW = hand === 'R' ? w - 1 : w + 1;
    }
  }
  return part;
}

// Guess a key from note content: the tonic is taken from the lowest note near the end of the piece,
// then major vs. minor on that tonic is decided by whichever scale needs fewer accidentals.
export function guessKey(notes) {
  if (!notes.length) return { fifths: 0, mode: 'major' };
  const hist = new Array(12).fill(0);
  let maxT = 0;
  for (const n of notes) { hist[n.p % 12] += n.d || 1; maxT = Math.max(maxT, n.t + n.d); }
  const tail = notes.filter(n => n.t + n.d >= maxT - 4);
  const tonic = tail.length ? Math.min(...tail.map(n => n.p)) % 12 : notes.reduce((a, n) => hist[n.p % 12] > hist[a] ? n.p % 12 : a, 0);
  const outside = (fifths) => {
    const t = ((fifths * 7) % 12 + 12) % 12;
    const scale = [0, 2, 4, 5, 7, 9, 11].map(x => (x + t) % 12);
    let out = 0;
    for (let pc = 0; pc < 12; pc++) if (!scale.includes(pc)) out += hist[pc];
    return out;
  };
  const norm = f => ((f + 6) % 12 + 12) % 12 - 6; // keep within -6..6
  // fifths for major key with this tonic: tonic pc = (fifths*7) mod 12  =>  fifths = tonic*7 mod 12
  const majorF = norm((tonic * 7) % 12);
  const minorF = norm(majorF - 3);
  const major = outside(majorF), minor = outside(minorF);
  return minor < major ? { fifths: minorF, mode: 'minor' } : { fifths: majorF, mode: 'major' };
}

// ---------- General MIDI helpers ----------
export const GM_NAMES = ['Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet', 'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer', 'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion', 'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics', 'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2', 'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani', 'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Choir', 'Orchestra Hit', 'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2', 'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet', 'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina', 'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)', 'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)', 'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)', 'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai', 'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal', 'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'];

// Soundfont file name (gleitz midi-js-soundfonts naming) for a GM program number.
export function gmToSoundfont(program) {
  const name = GM_NAMES[program] || GM_NAMES[0];
  return name.toLowerCase().replace(/[()+-]/g, '').replace(/\s+/g, '_').replace(/_+$/, '').replace('honkytonk_piano', 'honkytonk_piano');
}

// Describe where a key is relative to middle C, for beginners.
export function describeKey(p) {
  const name = midiToName(p);
  const black = isBlackKey(p);
  const w = whiteIndex(p) - whiteIndex(60); // white keys from middle C
  let where;
  if (p === 60) where = 'middle C';
  else if (!black) where = `${Math.abs(w)} white key${Math.abs(w) === 1 ? '' : 's'} ${w > 0 ? 'right' : 'left'} of middle C`;
  else {
    const lower = midiToName(p - 1), upper = midiToName(p + 1);
    where = `black key between ${lower} and ${upper}`;
  }
  const oct = Math.floor(p / 12) - 1;
  const octHint = oct === 4 ? 'middle-C octave' : oct === 5 ? 'one octave above middle C' : oct === 3 ? 'one octave below middle C' : oct === 6 ? 'two octaves above middle C' : oct === 2 ? 'two octaves below middle C' : `octave ${oct}`;
  return { name, where, octHint, black };
}

// Normalize a loaded song: assign note indices, sort, compute bars, fill fingering.
export function finalizeSong(song) {
  const barLen = barLengthQuarters(song.timeSig);
  let maxEnd = 0;
  for (const part of song.parts) {
    part.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    part.notes.forEach((n, i) => { n.i = i; maxEnd = Math.max(maxEnd, n.t + n.d); });
    if (part.playable !== false && !part.perc) autoFinger(part);
    if (!part.clef) {
      const avg = part.notes.reduce((s, n) => s + n.p, 0) / Math.max(1, part.notes.length);
      part.clef = avg < 60 ? 'bass' : 'treble';
    }
    if (!part.hand) part.hand = part.clef === 'bass' ? 'L' : 'R';
  }
  song.bars = Math.max(song.bars || 0, Math.ceil(maxEnd / barLen - 1e-6));
  song.length = song.bars * barLen;
  return song;
}

// Convert generic parsed MIDI tracks into a song. tracks: [{name, program, channel, notes:[{t,d,p,v}] (quarters)}]
export function midiToSong(meta, tracks, opts = {}) {
  const grid = opts.grid || 0.25;
  const timeSig = meta.timeSig || { num: 4, den: 4 };
  const parts = [];
  const colors = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#a26ad0', '#ff7f50', '#2e86ab', '#f06292'];
  let ci = 0;
  for (const tr of tracks) {
    if (!tr.notes.length) continue;
    const perc = tr.channel === 9;
    let notes = quantizeNotes(tr.notes, grid);
    if (!perc) notes = trimOverlaps(notes);
    const program = tr.program ?? 0;
    parts.push({
      id: `t${parts.length}`,
      name: tr.name || (perc ? 'Percussion' : GM_NAMES[program]),
      instrument: perc ? 'percussion' : gmToSoundfont(program),
      gmName: perc ? 'Drums' : GM_NAMES[program],
      program,
      perc,
      playable: !perc,
      color: colors[ci++ % colors.length],
      notes: notes.map(n => ({ t: n.t, d: n.d, p: n.p, v: n.v ?? 90 })),
    });
  }
  return finalizeSong({
    title: meta.title || 'Imported MIDI',
    bpm: meta.bpm || 120,
    timeSig,
    key: meta.key || { fifths: 0, mode: 'major' },
    sections: [],
    parts,
  });
}
