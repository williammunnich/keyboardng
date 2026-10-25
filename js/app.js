// app.js — main controller: song loading, part roles, transport/scheduler, practice modes, MIDI handling, UI.
import { AudioEngine } from './synth.js';
import { MidiInput } from './midi-in.js';
import { PianoKeyboard } from './keyboard.js';
import { Score } from './score.js';
import { midiToSong, describeKey, spellPitch, barLengthQuarters, finalizeSong, guessKey } from './songmodel.js';

const $ = id => document.getElementById(id);
const LOOKAHEAD = 0.18; // seconds of audio scheduled ahead
const STORE_KEY = 'pianotrainer.v1';

// ---------- debug logging ----------
const DEBUG = { on: new URL(location.href).searchParams.has('debug'), lines: [], max: 400 };
const t0 = performance.now();
function dbg(...args) {
  if (!DEBUG.on) return;
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const line = `${((performance.now() - t0) / 1000).toFixed(3)}s ${msg}`;
  console.log('[trainer]', line);
  DEBUG.lines.push(line);
  if (DEBUG.lines.length > DEBUG.max) DEBUG.lines.shift();
  const el = document.getElementById('debugLog');
  if (el) { el.textContent = DEBUG.lines.join('\n'); el.scrollTop = el.scrollHeight; }
}
function setDebug(on) {
  DEBUG.on = on;
  document.getElementById('debugPanel')?.classList.toggle('hidden', !on);
  const cb = document.getElementById('debugOn'); if (cb) cb.checked = on;
  const u = new URL(location.href);
  if (on) u.searchParams.set('debug', '1'); else u.searchParams.delete('debug');
  history.replaceState(null, '', u);
  if (on) dbg('debug logging on', { ua: navigator.userAgent, secure: window.isSecureContext, webmidi: !!navigator.requestMIDIAccess });
}
window.addEventListener('error', (e) => dbg('ERROR', e.message, `${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => dbg('UNHANDLED REJECTION', String(e.reason?.stack || e.reason)));

const SONGS = [
  { id: 'song-of-storms', title: 'Song of Storms (Windmill Hut) — Zelda: Ocarina of Time', url: 'songs/song-of-storms.json' },
  { id: 'ref-midi', title: 'Reference MIDI: Windmill Hut (vgmusic transcription, all tracks)', url: 'songs/reference/windmill-hut-vgmusic.mid', midi: true, optional: true },
];

const engine = new AudioEngine();
const score = new Score($('score'));
let keyboard;
let midi;

const state = {
  song: null,
  songId: null,
  roles: new Map(),     // partId -> 'me' | 'back' | 'off'
  volumes: new Map(),   // partId -> 0..1
  mode: 'learn',
  tempoPct: 60,
  loop: { on: false, a: 9, b: 23 },
  anyOctave: false,
  muteWrong: false,
  metronome: false,
  mySound: 'part',
  showBacking: false,
  showFingers: true,
  zoom: 1,
  barsPerLine: 4,
  kbRange: [36, 84],
  // runtime
  playing: false,
  waiting: false,
  held: new Set(),      // pitches physically down right now
  waitGroup: null,      // learn mode: the chord/note we are waiting for
  holds: [],            // learn mode: notes that must stay down until their written end
  holdPaused: false,    // learn mode: a held note was released early, waiting for it again
  groups: [],           // learn-mode expected groups
  groupIdx: 0,
  hits: 0, misses: 0, wrong: 0,
  scheduledUpTo: 0,
  curKeys: new Set(),
  sustain: false,
  sustained: new Set(),
  ptr: new Map(),
};

// ---------- persistence ----------
function saveSettings() {
  const data = {
    mode: state.mode, tempoPct: state.tempoPct, loop: state.loop, anyOctave: state.anyOctave, muteWrong: state.muteWrong,
    metronome: state.metronome, mySound: state.mySound, showBacking: state.showBacking, showFingers: state.showFingers,
    zoom: state.zoom, barsPerLine: state.barsPerLine, kbRange: state.kbRange, songId: state.songId,
    roles: JSON.parse(localStorage.getItem(STORE_KEY) || '{}').roles || {},
  };
  if (state.songId) data.roles[state.songId] = Object.fromEntries(state.roles);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}
function loadSettings() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    Object.assign(state, {
      mode: d.mode || 'learn', tempoPct: d.tempoPct || 60, loop: d.loop || state.loop, anyOctave: !!d.anyOctave, muteWrong: !!d.muteWrong,
      metronome: !!d.metronome, mySound: d.mySound || 'part', showBacking: !!d.showBacking, showFingers: d.showFingers !== false,
      zoom: d.zoom || 1, barsPerLine: d.barsPerLine || 4, kbRange: d.kbRange || [36, 84],
    });
    return d;
  } catch { return {}; }
}

// ---------- transport ----------
const transport = {
  running: false, beat: 0, anchor: 0, spb: 0.3,
  start() { this.anchor = engine.now; this.running = true; },
  pause() { this.beat = this.now(); this.running = false; },
  now() { return this.running ? this.beat + (engine.now - this.anchor) / this.spb : this.beat; },
  seek(b) { this.beat = b; this.anchor = engine.now; },
  setSpb(s) { const b = this.now(); this.spb = s; this.seek(b); },
  timeOf(beat) { return this.anchor + (beat - this.beat) * this.spb; },
};

function barLen() { return barLengthQuarters(state.song.timeSig); }
function updateTempo() {
  const bpm = state.song.bpm * state.tempoPct / 100;
  transport.setSpb(60 / bpm);
  $('tempoVal').textContent = `${state.tempoPct}%`;
  $('bpmVal').textContent = `(${Math.round(bpm)} bpm, song is ${state.song.bpm})`;
}

// ---------- song loading ----------
async function loadSongEntry(entry) {
  setStatus(`Loading ${entry.title}…`);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`Could not load ${entry.url}`);
  let song;
  if (entry.midi) song = songFromMidiBuffer(await res.arrayBuffer(), entry.title);
  else song = finalizeSong(await res.json());
  setSong(song, entry.id);
}

const KEY_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
function songFromMidiBuffer(buf, title) {
  const m = new window.Midi(buf);
  const ppq = m.header.ppq;
  const bpm = m.header.tempos[0]?.bpm ?? 120;
  const tsig = m.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const ks = m.header.keySignatures[0];
  let key = { fifths: 0, mode: 'major' };
  if (ks) {
    const minor = ks.scale === 'minor';
    let f = KEY_FIFTHS[ks.key] ?? 0;
    if (minor) f = f - 3; // relative major has 3 more sharps
    key = { fifths: Math.max(-7, Math.min(7, f)), mode: minor ? 'minor' : 'major' };
  }
  const tracks = m.tracks.map(tr => ({
    name: tr.name, program: tr.instrument?.number ?? 0, channel: tr.channel,
    notes: tr.notes.map(n => ({ t: n.ticks / ppq, d: n.durationTicks / ppq, p: n.midi, v: Math.round(n.velocity * 127) })),
  }));
  if (!ks) key = guessKey(tracks.filter(t => t.channel !== 9).flatMap(t => t.notes));
  return midiToSong({ title: m.name || title, bpm: Math.round(bpm), timeSig: { num: tsig[0], den: tsig[1] }, key }, tracks);
}

function setSong(song, id) {
  stop();
  dbg('setSong', { id, title: song.title, bars: song.bars, bpm: song.bpm, timeSig: song.timeSig, key: song.key, parts: song.parts.map(p => `${p.id}:${p.notes.length}`) });
  state.song = song;
  state.songId = id;
  const saved = (JSON.parse(localStorage.getItem(STORE_KEY) || '{}').roles || {})[id];
  state.roles = new Map();
  state.volumes = new Map();
  let firstPlayable = true;
  for (const p of song.parts) {
    let role = saved?.[p.id];
    if (!role) {
      if (p.perc || p.playable === false) role = 'back';
      else if (firstPlayable) { role = 'me'; firstPlayable = false; }
      else role = 'back';
    }
    if (role === 'me' && (p.perc || p.playable === false)) role = 'back';
    state.roles.set(p.id, role);
    state.volumes.set(p.id, p.perc ? 0.6 : 0.9);
  }
  $('credit').textContent = [song.composer ? `Music: ${song.composer}.` : '', song.source || ''].join(' ');
  $('loopA').max = song.bars; $('loopB').max = song.bars;
  if (state.loop.b > song.bars) state.loop = { on: false, a: 1, b: song.bars };
  updateTempo();
  renderParts();
  renderScore();
  keyboard.setKey(song.key);
  prepareInstruments();
  transport.seek(0);
  updateFrame(true);
  setStatus(`${song.title} — ${song.bars} bars, ${song.timeSig.num}/${song.timeSig.den}, ${song.bpm} bpm`, true);
  saveSettings();
}

async function prepareInstruments() {
  const names = new Set();
  for (const p of state.song.parts) if (!p.perc && state.roles.get(p.id) !== 'off') { names.add(p.instrument); for (const n of p.notes) if (n.instr) names.add(n.instr); }
  names.add(userInstrument());
  for (const n of names) {
    await engine.loadInstrument(n);
    for (const p of state.song.parts) engine.prime(n, p.notes.filter(x => (x.instr || p.instrument) === n).map(x => x.p));
  }
  engine.prime(userInstrument(), state.song.parts.filter(p => !p.perc).flatMap(p => p.notes.map(x => x.p)));
}

function userInstrument() {
  if (state.mySound !== 'part') return state.mySound;
  const me = state.song?.parts.find(p => state.roles.get(p.id) === 'me' && !p.perc);
  return me ? me.instrument : 'acoustic_grand_piano';
}

// ---------- parts panel ----------
function renderParts() {
  const wrap = $('parts');
  wrap.innerHTML = '';
  for (const p of state.song.parts) {
    const row = document.createElement('div');
    row.className = 'part';
    const range = p.notes.length ? `${spellPitch(Math.min(...p.notes.map(n => n.p)), state.song.key).name}–${spellPitch(Math.max(...p.notes.map(n => n.p)), state.song.key).name}` : '';
    row.innerHTML = `<span class="dot" style="background:${p.color}"></span>
      <span class="pname"><b>${p.name}</b><small>${p.gmName || p.instrument}${p.perc ? '' : ' · ' + range + ' · ' + (p.hand === 'L' ? 'left hand' : 'right hand')}</small></span>
      <span class="seg">${p.perc || p.playable === false ? '' : '<button data-r="me">Me</button>'}<button data-r="back" class="back">Backing</button><button data-r="off">Off</button></span>
      <label class="vol"><input type="range" min="0" max="100" value="${Math.round(state.volumes.get(p.id) * 100)}" title="Volume"></label>`;
    const role = state.roles.get(p.id);
    for (const b of row.querySelectorAll('.seg button')) {
      b.classList.toggle('on', b.dataset.r === role);
      b.onclick = () => { setRole(p.id, b.dataset.r); };
    }
    row.querySelector('.vol input').oninput = (e) => { state.volumes.set(p.id, e.target.value / 100); engine.setBusGain(p.id, e.target.value / 100); };
    engine.setBusGain(p.id, state.volumes.get(p.id));
    wrap.appendChild(row);
  }
}

function setRole(partId, role) {
  const wasPlaying = state.playing;
  stop();
  state.roles.set(partId, role);
  renderParts();
  renderScore();
  prepareInstruments();
  saveSettings();
  if (wasPlaying) play();
}

function meParts() { return state.song.parts.filter(p => state.roles.get(p.id) === 'me' && !p.perc && p.playable !== false); }
// Backing parts; a part that doubles one you are playing stays silent so you don't hear your own line.
function backParts() { return state.song.parts.filter(p => state.roles.get(p.id) === 'back' && !(p.doubles && state.roles.get(p.doubles) === 'me')); }
function audibleParts() { return state.song.parts.filter(p => state.roles.get(p.id) !== 'off'); }
// Skip notes flagged alt (originally played by a doubling instrument) when that doubling part is audible.
function skipNote(p, n, parts) { return !!n.alt && parts.some(q => q.doubles === p.id); }

// ---------- score ----------
function shownPartIds() {
  const me = meParts().map(p => p.id);
  // backing parts that merely double another part (same line an octave up) are left out of the score
  const back = backParts().filter(p => !p.perc && !p.doubles).map(p => p.id);
  if (!me.length) return back;
  return state.showBacking ? [...me, ...back] : me;
}
let renderTimer = null;
function renderScore() {
  if (!state.song) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    score.render(state.song, {
      parts: shownPartIds(), fingerParts: state.showFingers ? new Set(meParts().length ? meParts().map(p => p.id) : shownPartIds()) : new Set(),
      barsPerLine: state.barsPerLine, zoom: state.zoom,
    });
    state.curKeys.clear();
    score.setCursor(transport.now(), true);
    for (const [k, v] of state.hitMarks || []) { const [pid, i] = k.split(':'); score.setClass(pid, +i, v, true); }
  }, 30);
}

// click on the score seeks to that bar
$('score').addEventListener('click', (ev) => {
  const svg = score.svg; if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / score.zoom, y = (ev.clientY - rect.top) / score.zoom;
  const sys = score.systems.find(s => y >= s.y && y < s.y + s.h);
  if (!sys) return;
  const m = sys.measures.find(mm => x >= mm.x && x < mm.x + mm.w);
  if (!m) return;
  seekTo(m.bar * barLen());
});

// ---------- playback ----------
let baseStatus = '', midiWarning = '';
function setStatus(t, base = false) { if (base) baseStatus = t; $('status').textContent = t + (midiWarning && t !== midiWarning ? '  ·  ' + midiWarning : ''); }

function play() {
  if (!state.song) return;
  engine.ensure();
  if (state.playing) { pause(); return; }
  state.playing = true;
  state.hitMarks = state.hitMarks || new Map();
  const now = transport.now();
  if (state.loop.on && (now < loopStart() || now >= loopEnd())) transport.seek(loopStart());
  if (now >= state.song.length) transport.seek(state.loop.on ? loopStart() : 0);
  rebuildGroups();
  state.scheduledUpTo = transport.now();
  state.waiting = false;
  transport.start();
  dbg('play', { mode: state.mode, beat: +transport.now().toFixed(2), spb: +transport.spb.toFixed(4), me: meParts().map(p => p.id), back: backParts().map(p => p.id), groups: state.groups.length, groupIdx: state.groupIdx, loop: state.loop, audio: engine.ctx?.state });
  $('btnPlay').textContent = '⏸ Pause';
  tickTimer = setInterval(tick, 25);
  requestAnimationFrame(frame);
}
function pause() {
  if (!state.playing) return;
  transport.pause();
  dbg('pause', { beat: +transport.now().toFixed(2), active: engine.active.size });
  clearInterval(tickTimer); tickTimer = null;
  engine.stopAll();
  state.playing = false;
  state.waiting = false;
  state.waitGroup = null;
  state.holds = [];
  state.holdPaused = false;
  $('btnPlay').textContent = '▶ Play';
  keyboard.setTargets([]);
  updateFrame(true);
}
function stop() {
  pause();
  if (state.song) transport.seek(state.loop.on ? loopStart() : 0);
  score.clearClass('hit'); score.clearClass('miss'); score.clearClass('cur');
  state.hitMarks = new Map();
  state.hits = state.misses = state.wrong = 0;
  updateFrame(true);
  $('targetMain').className = 'target-main';
  $('targetMain').textContent = 'Press ▶ Play to start.';
  $('targetSub').textContent = '';
  updateScoreLine();
}
function seekTo(beat) {
  const wasPlaying = state.playing;
  pause();
  transport.seek(Math.max(0, Math.min(state.song.length, beat)));
  score.clearClass('cur');
  updateFrame(true);
  if (wasPlaying) play();
}
function loopStart() { return (state.loop.a - 1) * barLen(); }
function loopEnd() { return state.loop.b * barLen(); }

// Expected note groups for the parts I play (learn mode), from the current position
function rebuildGroups() {
  const groups = [];
  const all = [];
  for (const p of meParts()) for (const n of p.notes) all.push({ part: p, note: n });
  all.sort((a, b) => a.note.t - b.note.t || a.note.p - b.note.p);
  for (const x of all) {
    const g = groups.length && Math.abs(groups[groups.length - 1].t - x.note.t) < 1e-6 ? groups[groups.length - 1] : null;
    if (g) g.items.push(x); else groups.push({ t: x.note.t, items: [x] });
  }
  state.groups = groups;
  const now = transport.now();
  state.groupIdx = groups.findIndex(g => g.t >= now - 1e-6);
  if (state.groupIdx < 0) state.groupIdx = groups.length;
}

let tickTimer = null;
function tick() {
  if (!state.playing) return;
  const song = state.song;
  if (!transport.running) return; // waiting for the player
  const now = transport.now();
  const horizonBeats = LOOKAHEAD / transport.spb;
  let limit = now + horizonBeats;
  const nextGroup = state.mode === 'learn' ? state.groups[state.groupIdx] : null;
  if (nextGroup) limit = Math.min(limit, nextGroup.t);
  if (state.loop.on) limit = Math.min(limit, loopEnd());
  if (limit > state.scheduledUpTo) {
    scheduleBacking(state.scheduledUpTo, limit);
    state.scheduledUpTo = limit;
  }
  // learn mode: notes must stay down until their written end; letting go early pauses right there
  if (state.mode === 'learn' && state.holds.length) {
    state.holds = state.holds.filter(h => now < h.end - holdTolerance(h.note.d));
    const hk = heldKeys();
    const released = state.holds.filter(h => !hk.has(h.key));
    if (released.length) { pauseForHold(released); return; }
  }
  // learn mode: stop at the next expected note / chord
  if (nextGroup && now >= nextGroup.t - 0.01) {
    enterWait(nextGroup);
    return;
  }
  // play mode: mark missed notes
  if (state.mode === 'play') markMisses(now);
  if (state.loop.on && now >= loopEnd() - 0.005) {
    transport.seek(loopStart());
    state.scheduledUpTo = loopStart();
    rebuildGroups();
    score.clearClass('cur'); state.curKeys.clear();
    return;
  }
  if (now >= song.length + 0.5) {
    finish();
  }
}

function scheduleBacking(from, to) {
  const song = state.song;
  let scheduled = 0;
  const parts = state.mode === 'listen' ? audibleParts() : backParts();
  for (const p of parts) {
    const vol = state.volumes.get(p.id) ?? 0.9;
    if (vol <= 0) continue;
    // binary search first note with t >= from
    let lo = 0, hi = p.notes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p.notes[mid].t < from - 1e-6) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < p.notes.length && p.notes[i].t < to - 1e-6; i++) {
      const n = p.notes[i];
      if (skipNote(p, n, parts)) continue;
      const when = transport.timeOf(n.t);
      scheduled++;
      if (p.perc) engine.perc(when, n.v, p.id);
      else engine.play(n.instr || p.instrument, n.p, n.v, p.id, when, Math.max(0.05, n.d * transport.spb * 0.95));
    }
  }
  if (scheduled) dbg(`schedule ${scheduled} notes for beats ${from.toFixed(2)}–${to.toFixed(2)} (audio t=${engine.now.toFixed(3)}, active=${engine.active.size})`);
  if (state.metronome) {
    const bl = barLen();
    for (let b = Math.ceil(from - 1e-6); b < to - 1e-6; b++) click(transport.timeOf(b), b % bl === 0);
  }
}

function click(when, accent) {
  const ctx = engine.ensure();
  const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = accent ? 1600 : 1100;
  const g = ctx.createGain(); g.gain.setValueAtTime(accent ? 0.25 : 0.15, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
  o.connect(g).connect(engine.bus('metro'));
  o.start(when); o.stop(when + 0.06);
}

const HOLD_MIN_BEATS = 1;                       // notes shorter than a quarter pass on press
function holdTolerance(d) { return Math.max(0.1, d * 0.12); } // may let go slightly before the end
function heldKeys() { const k = new Set(); for (const p of state.held) k.add(pitchKey(p)); return k; }
function noteName(it) { return spellPitch(it.note.p, state.song.key).name; }

function enterWait(group) {
  transport.pause();
  transport.beat = group.t;
  state.waiting = true;
  state.waitGroup = group;
  dbg('WAIT at beat', +group.t.toFixed(2), 'for', group.items.map(it => `${noteName(it)}(${it.part.id} f${it.note.f} d${it.note.d})`).join(' + '));
  if (!checkWaitSatisfied()) showTargets(group.items);
}

// The group passes only when every one of its notes is down at the same moment.
function checkWaitSatisfied() {
  const g = state.waitGroup;
  if (!g) return false;
  const hk = heldKeys();
  if (g.items.some(it => !hk.has(pitchKey(it.note.p)))) return false;
  for (const it of g.items) {
    markHit(it.part, it.note);
    if (it.note.d >= HOLD_MIN_BEATS) state.holds.push({ part: it.part, note: it.note, key: pitchKey(it.note.p), end: it.note.t + it.note.d });
  }
  state.waiting = false;
  state.waitGroup = null;
  state.groupIdx++;
  dbg('  -> PASS', g.items.map(noteName).join('+'), 'holds', state.holds.map(h => `${noteName(h)}→${h.end}`), 'next group', state.groupIdx, 'of', state.groups.length);
  flashMain('good', g.items.map(noteName).join(' + ') + ' ✓');
  transport.start();
  state.scheduledUpTo = transport.now();
  return true;
}

function pauseForHold(released) {
  transport.pause();
  state.holdPaused = true;
  dbg('HOLD released early', released.map(h => `${noteName(h)} ${(h.end - transport.now()).toFixed(2)} beats left`));
  showHoldMessage(released);
}

function resumeFromHold() {
  state.holdPaused = false;
  transport.start();
  state.scheduledUpTo = transport.now();
  dbg('HOLD resumed at beat', +transport.now().toFixed(2));
  $('targetMain').className = 'target-main';
  updateFrame(true);
}

function showHoldMessage(released) {
  keyboard.setTargets(released.map(h => ({ p: h.note.p, finger: h.note.f, color: h.part.color })));
  const main = $('targetMain');
  main.className = 'target-main bad';
  main.innerHTML = 'Keep holding: ' + released.map(h => `<span class="note">${noteName(h)}</span>${h.note.f ? `<span class="finger">${h.note.f}</span>` : ''}`).join(' + ');
  $('targetSub').textContent = released.map(h => `${noteName(h)} is a ${durationName(h.note.d)} — you let go ${(h.end - transport.now()).toFixed(1)} beats early. Press it again and hold it to the end of the note.`).join('  |  ');
}

function refreshTargetPanel() {
  if (state.waiting && state.waitGroup) showTargets(state.waitGroup.items);
  else if (state.holdPaused) { const hk = heldKeys(); showHoldMessage(state.holds.filter(h => !hk.has(h.key))); }
}

function durationName(d) {
  const bl = barLen();
  if (d >= bl && bl === 3) return 'dotted half note';
  const names = { 4: 'whole note', 3: 'dotted half note', 2: 'half note', 1.5: 'dotted quarter note', 1: 'quarter note', 0.75: 'dotted eighth', 0.5: 'eighth note', 0.25: 'sixteenth note' };
  return names[d] || `${d}-beat note`;
}

function pitchKey(p) { return state.anyOctave ? `c${p % 12}` : `p${p}`; }

function markHit(part, note) {
  state.hits++;
  score.setClass(part.id, note.i, 'hit', true);
  state.hitMarks.set(`${part.id}:${note.i}`, 'hit');
  updateScoreLine();
}
function markMiss(part, note) {
  state.misses++;
  score.setClass(part.id, note.i, 'miss', true);
  state.hitMarks.set(`${part.id}:${note.i}`, 'miss');
  updateScoreLine();
}
function markMisses(now) {
  const windowBeats = 0.3 / transport.spb;
  for (const p of meParts()) {
    const ptr = state.ptr.get('miss:' + p.id) ?? 0;
    let i = ptr;
    while (i < p.notes.length && p.notes[i].t < now - windowBeats) {
      const n = p.notes[i];
      const k = `${p.id}:${n.i}`;
      if (!state.hitMarks.has(k)) markMiss(p, n);
      i++;
    }
    state.ptr.set('miss:' + p.id, i);
  }
}

function finish() {
  dbg('finish', { hits: state.hits, misses: state.misses, wrong: state.wrong });
  pause();
  const total = state.hits + state.misses;
  $('targetMain').className = 'target-main good';
  $('targetMain').textContent = total ? `Done! ${state.hits}/${total} notes right${state.wrong ? `, ${state.wrong} wrong presses` : ''}.` : 'Done!';
  $('targetSub').textContent = 'Press ▶ Play to go again, or turn on a loop to drill a section.';
}

function updateScoreLine() {
  const total = state.hits + state.misses;
  $('scoreLine').textContent = state.mode === 'listen' ? '' : `✓ ${state.hits} · ✗ ${state.misses} missed · ${state.wrong} wrong${total ? ` · ${Math.round(100 * state.hits / total)}%` : ''}`;
}

// ---------- targets / display ----------
function showTargets(items) {
  keyboard.setTargets(items.map(it => ({ p: it.note.p, finger: it.note.f, color: it.part.color })));
  const main = $('targetMain');
  main.className = 'target-main';
  if (!items.length) { main.textContent = ''; $('targetSub').textContent = ''; return; }
  const sorted = [...items].sort((a, b) => a.note.p - b.note.p);
  main.innerHTML = (items.length > 1 ? 'Play together: ' : 'Play: ') + sorted.map(it => {
    const nm = spellPitch(it.note.p, state.song.key).name;
    return `<span class="note">${nm}</span>${it.note.f ? `<span class="finger" title="finger">${it.note.f}</span>` : ''}`;
  }).join(' + ');
  const sub = sorted.map(it => {
    const d = describeKey(it.note.p);
    const hand = it.part.hand === 'L' ? 'left hand' : 'right hand';
    const fingerName = ['', 'thumb', 'index', 'middle', 'ring', 'little'][it.note.f || 0];
    const inRange = it.note.p >= state.kbRange[0] && it.note.p <= state.kbRange[1];
    return `${spellPitch(it.note.p, state.song.key).name}: ${d.where} (${d.octHint})${fingerName ? ` · ${hand} ${fingerName}` : ''}${inRange ? '' : ' · ⚠ outside your keyboard — shift octave or enable "any octave"'}`;
  });
  $('targetSub').textContent = sub.join('  |  ');
}

// per-frame UI update: cursor, current notes, keyboard targets in play/listen modes
function frame() {
  if (!state.playing) return;
  updateFrame(false);
  requestAnimationFrame(frame);
}
function updateFrame(force) {
  if (!state.song) return;
  const now = transport.now();
  score.setCursor(now, true);
  const bl = barLen();
  $('position').textContent = `bar ${Math.floor(now / bl) + 1} · beat ${Math.floor(now % bl) + 1}`;
  // current notes on shown parts
  const shown = new Set(shownPartIds());
  const newCur = new Set();
  const liveTargets = [];
  for (const p of state.song.parts) {
    if (p.perc) continue;
    const isShown = shown.has(p.id);
    const isMe = state.roles.get(p.id) === 'me' && p.playable !== false;
    const audible = state.mode === 'listen' && state.roles.get(p.id) !== 'off' && !p.doubles;
    if (!isShown && !isMe && !audible) continue;
    for (const n of notesActive(p, now)) {
      if (isShown) newCur.add(`${p.id}:${n.i}`);
      if ((isMe || audible) && state.playing && !state.waiting && !state.holdPaused) liveTargets.push({ p: n.p, finger: n.f, color: p.color });
    }
  }
  for (const k of state.curKeys) if (!newCur.has(k)) { const [pid, i] = k.split(':'); score.setClass(pid, +i, 'cur', false); }
  for (const k of newCur) if (!state.curKeys.has(k)) { const [pid, i] = k.split(':'); score.setClass(pid, +i, 'cur', true); }
  state.curKeys = newCur;
  if (state.playing && !state.waiting && !state.holdPaused) {
    keyboard.setTargets(liveTargets);
    const mainEl = $('targetMain');
    if (state.mode === 'learn' && state.holds.length && !mainEl.classList.contains('good') && !mainEl.classList.contains('bad')) {
      mainEl.innerHTML = 'Hold: ' + state.holds.map(h => `<span class="note">${noteName(h)}</span>`).join(' + ');
      $('targetSub').textContent = state.holds.map(h => `${noteName(h)}: ${durationName(h.note.d)}, ${Math.max(0, h.end - now).toFixed(1)} beats to go`).join('  |  ');
    } else if (state.mode === 'learn' && !state.holds.length && !mainEl.classList.contains('good') && !mainEl.classList.contains('bad') && /^Hold:/.test(mainEl.textContent)) {
      mainEl.textContent = 'Good — next note coming up…'; $('targetSub').textContent = '';
    }
    if (state.mode !== 'learn') {
      const main = $('targetMain');
      if (!main.classList.contains('bad') && !main.classList.contains('good')) {
        const names = liveTargets.map(t => spellPitch(t.p, state.song.key).name + (t.finger ? `(${t.finger})` : '')).join(' ');
        main.textContent = names ? (state.mode === 'listen' ? 'Now: ' : 'Play: ') + names : (state.mode === 'listen' ? 'Listening…' : 'Get ready…');
        if (!names) $('targetSub').textContent = '';
      }
    }
  } else if (force && !state.playing) keyboard.setTargets([]);
}

function notesActive(part, now) {
  const out = [];
  const maxD = part._maxD ?? (part._maxD = Math.max(...part.notes.map(n => n.d), 0.5));
  let lo = 0, hi = part.notes.length;
  const from = now - maxD;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (part.notes[mid].t < from) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < part.notes.length && part.notes[i].t <= now + 1e-6; i++) {
    const n = part.notes[i];
    if (n.t + n.d > now + 1e-6) out.push(n);
  }
  return out;
}

// ---------- user notes ----------
function userNoteOn(pitch, velocity) {
  state.held.add(pitch);
  keyboard.press(pitch);
  dbg('noteOn', pitch, state.song ? spellPitch(pitch, state.song.key).name : '', 'vel', velocity, { mode: state.mode, playing: state.playing, waiting: state.waiting, beat: +transport.now().toFixed(2), instr: userInstrument() });
  if (!state.song) { engine.noteOn(userInstrument(), pitch, velocity, 'user'); return; }
  const instr = userInstrument();
  if (!state.playing || state.mode === 'listen') { engine.noteOn(instr, pitch, velocity, 'user'); return; }
  const key = pitchKey(pitch);
  if (state.mode === 'learn') {
    const upcoming = state.groups[state.groupIdx];
    const inGroup = g => g && g.items.some(it => pitchKey(it.note.p) === key);
    if (state.waiting) {
      if (inGroup(state.waitGroup)) {
        engine.noteOn(instr, pitch, velocity, 'user');
        if (!checkWaitSatisfied()) { dbg('  -> part of the chord, waiting for the rest'); showTargets(state.waitGroup.items); }
        return;
      }
    } else if (state.holdPaused) {
      if (state.holds.some(h => h.key === key)) {
        engine.noteOn(instr, pitch, velocity, 'user');
        const hk = heldKeys();
        if (state.holds.every(h => hk.has(h.key))) resumeFromHold();
        else showHoldMessage(state.holds.filter(h => !hk.has(h.key)));
        return;
      }
    } else if (state.holds.some(h => h.key === key) || (upcoming && upcoming.t - transport.now() < 1 && inGroup(upcoming))) {
      // re-pressing a held note, or pressing the next note a little early: sound it, judged when its time comes
      engine.noteOn(instr, pitch, velocity, 'user');
      return;
    }
    // wrong note: silent
    const wantItems = state.waiting ? state.waitGroup.items : state.holdPaused ? state.holds : [];
    dbg('  -> WRONG (silent)', { want: wantItems.map(noteName) });
    state.wrong++;
    keyboard.markWrong(pitch);
    const want = wantItems.map(noteName).join(' + ');
    flashMain('bad', `${spellPitch(pitch, state.song.key).name} is not it${want ? ` — you want ${want}${state.waiting && wantItems.length > 1 ? ' together' : ''}` : ''}`);
    updateScoreLine();
    return;
  }
  // play-along: judge against nearby expected notes
  const now = transport.now();
  const windowBeats = 0.3 / transport.spb;
  let best = null;
  for (const p of meParts()) {
    for (const n of notesNear(p, now, windowBeats + 1)) {
      if (pitchKey(n.p) !== key) continue;
      if (state.hitMarks.has(`${p.id}:${n.i}`)) continue;
      const dt = Math.abs(n.t - now);
      if (dt <= windowBeats && (!best || dt < best.dt)) best = { part: p, note: n, dt };
    }
  }
  if (best) {
    dbg('  -> HIT (play-along)', `${best.part.id}#${best.note.i}`, 'dt beats', +best.dt.toFixed(2));
    markHit(best.part, best.note);
    engine.noteOn(instr, pitch, velocity, 'user');
  } else {
    dbg('  -> WRONG (play-along)', { muted: state.muteWrong });
    state.wrong++;
    keyboard.markWrong(pitch);
    updateScoreLine();
    if (!state.muteWrong) engine.noteOn(instr, pitch, velocity, 'user');
  }
}
function notesNear(part, now, w) {
  let lo = 0, hi = part.notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (part.notes[mid].t < now - w) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < part.notes.length && part.notes[i].t <= now + w; i++) out.push(part.notes[i]);
  return out;
}
function userNoteOff(pitch) {
  state.held.delete(pitch);
  dbg('noteOff', pitch, { sustain: state.sustain });
  keyboard.release(pitch);
  if (state.sustain) { state.sustained.add(pitch); return; }
  engine.noteOff(userInstrument(), pitch, 'user');
}
let flashTimer = null;
function flashMain(cls, text) {
  const main = $('targetMain');
  const prevHTML = main.innerHTML, prevSub = $('targetSub').textContent;
  main.className = 'target-main ' + cls;
  main.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    main.className = 'target-main';
    if (state.waiting || state.holdPaused) refreshTargetPanel();
    else if (cls === 'bad') { main.innerHTML = prevHTML; $('targetSub').textContent = prevSub; }
  }, cls === 'good' ? 350 : 900);
}

// ---------- MIDI device list ----------
function renderDevices(list, selectedId) {
  const sel = $('midiDevice');
  sel.innerHTML = '';
  if (!list.length) sel.innerHTML = '<option value="">(none — computer keys)</option>';
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name; o.selected = d.id === selectedId;
    sel.appendChild(o);
  }
}

// ---------- UI wiring ----------
function bindUI() {
  const songSel = $('songSelect');
  for (const s of SONGS) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.title; songSel.appendChild(o); }
  // optional entries (files fetched separately) are hidden when missing
  for (const s of SONGS.filter(x => x.optional)) {
    fetch(s.url, { method: 'HEAD' }).then(r => { if (!r.ok) songSel.querySelector(`option[value="${s.id}"]`)?.remove(); }).catch(() => {});
  }
  songSel.onchange = () => loadSongEntry(SONGS.find(s => s.id === songSel.value)).catch(e => setStatus(e.message));
  $('midiFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const song = songFromMidiBuffer(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''));
      const o = document.createElement('option'); o.value = 'file:' + f.name; o.textContent = `📄 ${f.name}`; o.selected = true; songSel.appendChild(o);
      setSong(song, 'file:' + f.name);
    } catch (err) { setStatus('Could not read MIDI file: ' + err.message); }
  };
  $('midiDevice').onchange = (e) => midi.select(e.target.value);
  $('midiConnect').onclick = () => connectMidi();
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === state.mode;
    r.onchange = () => { stop(); state.mode = r.value; updateScoreLine(); saveSettings(); };
  }
  $('btnPlay').onclick = play;
  $('btnStop').onclick = stop;
  $('btnRewind').onclick = () => seekTo(state.loop.on ? loopStart() : 0);
  const tempo = $('tempo'); tempo.value = state.tempoPct;
  tempo.oninput = () => { state.tempoPct = +tempo.value; updateTempo(); saveSettings(); };
  $('loopOn').checked = state.loop.on; $('loopA').value = state.loop.a; $('loopB').value = state.loop.b;
  const loopChange = () => {
    state.loop = { on: $('loopOn').checked, a: Math.max(1, +$('loopA').value || 1), b: Math.max(1, +$('loopB').value || 1) };
    if (state.loop.b < state.loop.a) state.loop.b = state.loop.a;
    $('loopB').value = state.loop.b;
    saveSettings();
  };
  $('loopOn').onchange = loopChange; $('loopA').onchange = loopChange; $('loopB').onchange = loopChange;
  $('showBacking').checked = state.showBacking; $('showBacking').onchange = (e) => { state.showBacking = e.target.checked; renderScore(); saveSettings(); };
  $('showFingers').checked = state.showFingers; $('showFingers').onchange = (e) => { state.showFingers = e.target.checked; renderScore(); saveSettings(); };
  $('zoom').value = Math.round(state.zoom * 100); $('zoom').oninput = (e) => { state.zoom = e.target.value / 100; renderScore(); saveSettings(); };
  $('barsPerLine').value = state.barsPerLine; $('barsPerLine').onchange = (e) => { state.barsPerLine = +e.target.value; renderScore(); saveSettings(); };
  $('kbRange').value = state.kbRange.join('-');
  $('kbRange').onchange = (e) => { state.kbRange = e.target.value.split('-').map(Number); keyboard.setRange(...state.kbRange); saveSettings(); };
  $('anyOctave').checked = state.anyOctave; $('anyOctave').onchange = (e) => { state.anyOctave = e.target.checked; saveSettings(); };
  $('showNames').onchange = (e) => keyboard.setShowNames(e.target.checked);
  $('mySound').value = state.mySound; $('mySound').onchange = (e) => { state.mySound = e.target.value; prepareInstruments(); saveSettings(); };
  $('muteWrong').checked = state.muteWrong; $('muteWrong').onchange = (e) => { state.muteWrong = e.target.checked; saveSettings(); };
  $('metronome').checked = state.metronome; $('metronome').onchange = (e) => { state.metronome = e.target.checked; saveSettings(); };

  window.addEventListener('keydown', (ev) => {
    if (ev.target && /input|select|textarea/i.test(ev.target.tagName) && ev.key !== 'Escape') return;
    if (ev.code === 'Space') { ev.preventDefault(); play(); }
    else if (ev.key === 'Home') { ev.preventDefault(); seekTo(state.loop.on ? loopStart() : 0); }
    else if (ev.key === 'Escape') stop();
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); seekTo((Math.floor(transport.now() / barLen()) + 1) * barLen()); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); seekTo(Math.max(0, (Math.ceil(transport.now() / barLen()) - 1) * barLen())); }
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderScore, 150); });
}

async function connectMidi() {
  $('midiConnect').classList.add('hidden');
  const ok = await midi.init();
  $('midiConnect').classList.toggle('hidden', ok);
  midiWarning = ok ? '' : '⚠ MIDI not granted: click "Connect MIDI" and choose Allow (or set MIDI to Allow via the icon left of the address bar).';
  setStatus(baseStatus || midiWarning);
  return ok;
}

async function start() {
  const saved = loadSettings();
  keyboard = new PianoKeyboard($('keyboard'), {
    lo: state.kbRange[0], hi: state.kbRange[1],
    onPress: (p) => userNoteOn(p, 100), onRelease: (p) => userNoteOff(p),
  });
  midi = new MidiInput({
    onNote: (p, v, on) => on ? userNoteOn(p, v) : userNoteOff(p),
    onControl: (cc, val) => {
      if (cc === 64) {
        state.sustain = val >= 64;
        if (!state.sustain) { for (const p of state.sustained) engine.noteOff(userInstrument(), p, 'user'); state.sustained.clear(); }
      }
    },
    onDebug: (t) => dbg(t),
    onDevices: (list, sel) => { dbg('devices', list.map(d => d.name), 'selected', sel); renderDevices(list, sel); },
    onStatus: (t) => { if (!state.song || /MIDI/.test(t)) setStatus(t); },
  });
  engine.onStatus = (t) => setStatus(t || baseStatus);
  engine.onDebug = (t) => dbg(t);
  bindUI();
  $('debugOn').onchange = (e) => setDebug(e.target.checked);
  $('debugClear').onclick = () => { DEBUG.lines = []; $('debugLog').textContent = ''; };
  $('debugCopy').onclick = () => navigator.clipboard?.writeText(DEBUG.lines.join('\n'));
  $('debugMin').onclick = () => {
    const panel = $('debugPanel');
    panel.classList.toggle('min');
    $('debugMin').textContent = panel.classList.contains('min') ? '▴' : '▾';
    try { localStorage.setItem('pianotrainer.debugMin', panel.classList.contains('min') ? '1' : '0'); } catch { /* ignore */ }
  };
  $('debugClose').onclick = () => setDebug(false);
  try {
    if (localStorage.getItem('pianotrainer.debugMin') === '1') { $('debugPanel').classList.add('min'); $('debugMin').textContent = '▴'; }
    const pos = JSON.parse(localStorage.getItem('pianotrainer.debugPos') || 'null');
    if (pos) Object.assign($('debugPanel').style, { left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' });
  } catch { /* ignore */ }
  // drag the panel by its bar
  const bar = $('debugBar');
  bar.addEventListener('pointerdown', (ev) => {
    if (ev.target.tagName === 'BUTTON') return;
    const panel = $('debugPanel');
    const r = panel.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    const move = (e) => {
      const left = Math.max(0, Math.min(window.innerWidth - r.width, e.clientX - dx));
      const top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
      Object.assign(panel.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      try { localStorage.setItem('pianotrainer.debugPos', JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop })); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    ev.preventDefault();
  });
  setDebug(DEBUG.on);
  dbg('settings', saved);
  const entry = SONGS.find(s => s.id === saved.songId) || SONGS[0];
  $('songSelect').value = entry.id;
  $('overlay').classList.remove('hidden');
  $('overlayBtn').onclick = async () => {
    $('overlay').classList.add('hidden');
    dbg('start clicked');
    engine.ensure();
    connectMidi(); // may wait on a browser permission prompt; don't block the song on it
    try { await loadSongEntry(entry); } catch (e) { setStatus(e.message); console.error(e); }
  };
}

start();
window.__trainer = { userNoteOn, userNoteOff, state, transport, play, stop, seekTo, engine, dbg, setDebug, DEBUG };
