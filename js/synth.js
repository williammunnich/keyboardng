// synth.js — Web Audio engine: sampled instruments (gleitz midi-js-soundfonts) with an oscillator fallback,
// a synthesized tambourine, and per-part gain buses.

const SF_BASE = 'https://gleitz.github.io/midi-js-soundfonts/MusyngKite/';
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const sfName = p => FLAT_NAMES[p % 12] + (Math.floor(p / 12) - 1);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buses = new Map();      // partId -> GainNode
    this.instruments = new Map(); // name -> { kind:'sf', data:{noteName: dataURI}, buffers: Map } | { kind:'osc' }
    this.loading = new Map();
    this.active = new Set();     // live voices
    this.held = new Map();       // key `${instr}:${pitch}` -> voice (for noteOn/noteOff)
    this.onStatus = null;
    this.onDebug = null;
  }

  debug(msg) { if (this.onDebug) this.onDebug(msg); }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
      this.master.connect(comp).connect(this.ctx.destination);
      this.debug(`AudioContext created: sampleRate=${this.ctx.sampleRate} state=${this.ctx.state} baseLatency=${this.ctx.baseLatency}`);
      this.ctx.onstatechange = () => this.debug('AudioContext state: ' + this.ctx.state);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get now() { return this.ensure().currentTime; }

  bus(id) {
    this.ensure();
    if (!this.buses.has(id)) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.buses.set(id, g);
    }
    return this.buses.get(id);
  }

  setBusGain(id, v) { this.bus(id).gain.value = v; }

  status(msg) { if (this.onStatus) this.onStatus(msg); }

  // Load a soundfont instrument by gleitz name. Resolves to true when sampled, false when falling back to the oscillator.
  async loadInstrument(name) {
    if (!name || name === 'percussion') return true;
    if (this.instruments.has(name)) return this.instruments.get(name).kind === 'sf';
    if (this.loading.has(name)) return this.loading.get(name);
    const p = (async () => {
      try {
        this.status(`Loading ${name.replace(/_/g, ' ')} samples…`);
        const res = await fetch(`${SF_BASE}${name}-mp3.js`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        // File format: MIDI.Soundfont.<name> = { "A0": "data:audio/mp3;base64,...", ... }
        const m = /MIDI\.Soundfont\.\w+\s*=\s*\{/.exec(text);
        const start = m ? m.index + m[0].length - 1 : text.indexOf('{');
        const end = text.lastIndexOf('}');
        const data = JSON.parse(text.slice(start, end + 1).replace(/,\s*}/g, '}'));
        this.instruments.set(name, { kind: 'sf', data, buffers: new Map(), pending: new Map() });
        this.status('');
        this.debug(`soundfont ${name}: ${Object.keys(data).length} samples, ${(text.length / 1048576).toFixed(1)} MB`);
        return true;
      } catch (e) {
        console.warn('soundfont load failed, using synth fallback for', name, e);
        this.debug(`soundfont ${name} FAILED: ${e.message}`);
        this.instruments.set(name, { kind: 'osc' });
        this.status(`No samples for ${name.replace(/_/g, ' ')} (offline?) — using synth tone`);
        return false;
      } finally {
        this.loading.delete(name);
      }
    })();
    this.loading.set(name, p);
    return p;
  }

  async buffer(instr, pitch) {
    const nm = sfName(pitch);
    if (instr.buffers.has(nm)) return instr.buffers.get(nm);
    if (instr.pending.has(nm)) return instr.pending.get(nm);
    const uri = instr.data[nm];
    if (!uri) return null;
    const p = (async () => {
      const b64 = uri.slice(uri.indexOf(',') + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const buf = await this.ctx.decodeAudioData(bytes.buffer);
      instr.buffers.set(nm, buf);
      instr.pending.delete(nm);
      return buf;
    })();
    instr.pending.set(nm, p);
    return p;
  }

  // Pre-decode the samples a part needs so playback is glitch free.
  async prime(name, pitches) {
    const instr = this.instruments.get(name);
    if (!instr || instr.kind !== 'sf') return;
    const uniq = [...new Set(pitches)];
    await Promise.all(uniq.map(p => this.buffer(instr, p)));
  }

  // Start a note. `when` is AudioContext time; `dur` (seconds) optional for one-shot scheduling.
  // Returns a voice with stop(when).
  play(name, pitch, velocity = 90, busId = 'default', when = null, dur = null) {
    const ctx = this.ensure();
    when = when ?? ctx.currentTime;
    const out = this.bus(busId);
    const vel = Math.max(0.05, Math.min(1, velocity / 127));
    const instr = this.instruments.get(name) || { kind: 'osc' };
    const env = ctx.createGain();
    env.connect(out);
    const voice = { env, nodes: [], stopped: false, pitch, name };
    const release = (t) => {
      if (voice.stopped) return;
      voice.stopped = true;
      const rel = instr.kind === 'sf' ? 0.25 : 0.12;
      env.gain.cancelScheduledValues(t);
      env.gain.setValueAtTime(env.gain.value || vel, t);
      env.gain.linearRampToValueAtTime(0, t + rel);
      for (const n of voice.nodes) { try { n.stop(t + rel + 0.02); } catch { /* already stopped */ } }
      setTimeout(() => { this.active.delete(voice); try { env.disconnect(); } catch { /* noop */ } }, Math.max(0, (t + rel - ctx.currentTime) * 1000) + 100);
    };
    voice.stop = release;
    this.active.add(voice);

    if (instr.kind === 'sf') {
      const nm = sfName(pitch);
      const buf = instr.buffers.get(nm);
      const startSrc = (b) => {
        if (voice.stopped) return;
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(env);
        env.gain.setValueAtTime(vel, when);
        src.start(Math.max(when, ctx.currentTime));
        voice.nodes.push(src);
        src.onended = () => { this.active.delete(voice); };
      };
      if (buf) startSrc(buf);
      else this.buffer(instr, pitch).then(b => { if (b) startSrc(b); else this.oscVoice(voice, pitch, vel, when); });
    } else {
      this.oscVoice(voice, pitch, vel, when);
    }
    if (dur != null) release(when + dur);
    return voice;
  }

  oscVoice(voice, pitch, vel, when) {
    const ctx = this.ctx;
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o1.connect(voice.env); o2.connect(g2).connect(voice.env);
    voice.env.gain.setValueAtTime(0, when);
    voice.env.gain.linearRampToValueAtTime(vel * 0.6, when + 0.01);
    voice.env.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * 0.25), when + 1.2);
    o1.start(when); o2.start(when);
    voice.nodes.push(o1, o2);
  }

  noteOn(name, pitch, velocity, busId) {
    const k = `${name}:${pitch}:${busId}`;
    const old = this.held.get(k);
    if (old) old.stop(this.now);
    const v = this.play(name, pitch, velocity, busId);
    this.held.set(k, v);
    return v;
  }

  noteOff(name, pitch, busId) {
    const k = `${name}:${pitch}:${busId}`;
    const v = this.held.get(k);
    if (v) { v.stop(this.now); this.held.delete(k); }
  }

  // Synthesized tambourine/shaker hit.
  perc(when, velocity = 90, busId = 'perc') {
    const ctx = this.ensure();
    when = when ?? ctx.currentTime;
    const out = this.bus(busId);
    const len = 0.12;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 8000; bp.Q.value = 1.5;
    const g = ctx.createGain(); g.gain.value = Math.min(1, velocity / 127) * 0.5;
    src.connect(hp).connect(bp).connect(g).connect(out);
    src.start(when);
    const voice = { stop: () => { try { src.stop(); } catch { /* noop */ } } };
    this.active.add(voice);
    src.onended = () => this.active.delete(voice);
    return voice;
  }

  stopAll() {
    const t = this.now;
    for (const v of [...this.active]) { try { v.stop(t); } catch { /* noop */ } }
    this.active.clear();
    this.held.clear();
  }
}
