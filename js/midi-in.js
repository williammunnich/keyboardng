// midi-in.js — Web MIDI input with device picking (prefers the M-Audio KeyStudio) and a computer-keyboard fallback.

export class MidiInput {
  constructor({ onNote, onControl, onDevices, onStatus, onDebug }) {
    this.onDebug = onDebug;         // (text) verbose diagnostics
    this.onNote = onNote;           // (pitch, velocity, isOn, source)
    this.onControl = onControl;     // (cc, value)
    this.onDevices = onDevices;     // (inputs[], selectedId)
    this.onStatus = onStatus;       // (text)
    this.access = null;
    this.selectedId = null;
    this.preferred = /keystudio|m-audio|keyboard|piano|midi/i;
    this.computerKeys = true;
    this.heldComputer = new Set();
    this.octave = 4;
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.onDebug?.('navigator.requestMIDIAccess is missing');
      this.onStatus?.('Web MIDI is not supported in this browser — use Chrome, Edge or Opera.');
      this.onDevices?.([], null);
      this.installComputerKeyboard();
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.onDebug?.('requestMIDIAccess failed: ' + e.name + ' ' + e.message);
      this.onStatus?.('MIDI access was denied: ' + e.message);
      this.onDevices?.([], null);
      this.installComputerKeyboard();
      return false;
    }
    this.onDebug?.(`MIDI access granted; inputs=${this.access.inputs.size} outputs=${this.access.outputs.size}`);
    this.access.onstatechange = (e) => { this.onDebug?.(`MIDI state change: ${e.port?.type} "${e.port?.name}" ${e.port?.state}/${e.port?.connection}`); this.refresh(); };
    this.refresh();
    this.installComputerKeyboard();
    return true;
  }

  inputs() {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  refresh() {
    const list = this.inputs();
    this.onDebug?.('MIDI inputs: ' + (list.map(i => `"${i.name}" [${i.manufacturer}] ${i.state}/${i.connection}`).join('; ') || 'none'));
    if (!list.find(i => i.id === this.selectedId)) {
      const pref = list.find(i => /keystudio/i.test(i.name)) || list.find(i => this.preferred.test(i.name)) || list[0];
      this.selectedId = pref ? pref.id : null;
    }
    for (const inp of list) inp.onmidimessage = inp.id === this.selectedId ? (e) => this.handle(e, inp) : null;
    this.onDevices?.(list.map(i => ({ id: i.id, name: i.name, manufacturer: i.manufacturer, state: i.state })), this.selectedId);
    const sel = list.find(i => i.id === this.selectedId);
    this.onStatus?.(sel ? `MIDI in: ${sel.name}` : 'No MIDI keyboard found — plug one in, or use your computer keyboard (A S D F G H J K / W E T Y U).');
  }

  select(id) {
    this.selectedId = id;
    this.refresh();
  }

  handle(e, inp) {
    const [status, d1, d2] = e.data;
    this.onDebug?.(`MIDI ${inp.name}: ${[...e.data].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    const type = status & 0xf0;
    if (type === 0x90 && d2 > 0) this.onNote(d1, d2, true, inp.name);
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) this.onNote(d1, 0, false, inp.name);
    else if (type === 0xb0) this.onControl?.(d1, d2);
  }

  // Computer keyboard fallback: A row = white keys from C, W row = black keys. Z/X shift octave.
  installComputerKeyboard() {
    if (this._kbInstalled) return;
    this._kbInstalled = true;
    const map = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
    window.addEventListener('keydown', (ev) => {
      if (!this.computerKeys) return;
      if (ev.target && /input|select|textarea/i.test(ev.target.tagName)) return;
      if (ev.repeat) return;
      const k = ev.key.toLowerCase();
      if (k === 'z') { this.octave = Math.max(1, this.octave - 1); return; }
      if (k === 'x') { this.octave = Math.min(7, this.octave + 1); return; }
      if (!(k in map)) return;
      ev.preventDefault();
      const pitch = 12 * (this.octave + 1) + map[k];
      if (this.heldComputer.has(pitch)) return;
      this.heldComputer.add(pitch);
      this.onNote(pitch, 96, true, 'computer keyboard');
    });
    window.addEventListener('keyup', (ev) => {
      if (!this.computerKeys) return;
      const k = ev.key.toLowerCase();
      if (!(k in map)) return;
      const pitch = 12 * (this.octave + 1) + map[k];
      if (!this.heldComputer.has(pitch)) return;
      this.heldComputer.delete(pitch);
      this.onNote(pitch, 0, false, 'computer keyboard');
    });
  }
}
