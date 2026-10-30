// Sound coming in from outside: files, the microphone, MIDI.
import { Module, Trigger, Pulse, DCBlock, expmap, fmtExp, fmtPct, fmtSt } from './lib/index.js';

export const deck = {
  type: 'deck', title: 'TRACK DECK', category: 'io', theme: 'black',
  description: 'Plays a dropped audio file. Its analysed beat grid drives a clock, so the wall locks to the track',
  tags: ['sample', 'player', 'track', 'audio file', 'beat', 'loop'],
  inputs: [
    { name: 'trig', label: 'RESTART', kind: 'gate' },
    { name: 'speed', label: 'SPEED', kind: 'cv' },
  ],
  outputs: [
    { name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' },
    { name: 's16', label: '1/16', kind: 'gate' }, { name: 'bar', label: 'BAR', kind: 'gate' },
    { name: 'kick', label: 'KICK', kind: 'gate' },
  ],
  params: [
    { name: 'rate', label: 'SPEED', min: -2, max: 2, default: 1, format: (v) => `${v.toFixed(2)} ×` },
    { name: 'gain', label: 'GAIN', min: 0, max: 2, default: 1, format: fmtPct },
    { name: 'loop', label: 'LOOP', type: 'toggle', default: 1 },
    { name: 'play', label: 'PLAY', type: 'toggle', default: 1 },
  ],
  widgets: [{ ui: 'waveform', w: 200, h: 70 }],
  dsp: class Deck extends Module {
    constructor(sr) {
      super(sr);
      this.L = null; this.R = null;
      this.pos = 0;
      this.ratio = 1;
      this.trig = new Trigger();
      this.grid = null; this.kicks = null; this.g = 0; this.c = 0;
      this.p16 = new Pulse(sr, 2); this.pBar = new Pulse(sr, 2); this.pKick = new Pulse(sr, 2);
    }
    onMessage(m) {
      if (m.kind === 'clear') { this.L = null; this.R = null; this.grid = null; this.kicks = null; return; }
      if (m.kind !== 'buffer') return;
      this.L = m.L; this.R = m.R ?? m.L;
      this.ratio = m.sr / this.sr;
      this.grid = m.grid ?? null;   // Float64Array of sixteenth times, seconds; every 16th a bar
      this.kicks = m.kicks ?? null;
      this.pos = 0; this.g = 0; this.c = 0;
    }
    tick(i, o, p) {
      const L = this.L;
      if (L === null) { o[0] = 0; o[1] = 0; o[2] = this.p16.tick(); o[3] = this.pBar.tick(); o[4] = this.pKick.tick(); return; }
      if (this.trig.tick(i[0])) { this.pos = 0; this.g = 0; this.c = 0; }
      const n = L.length;
      const k = Math.floor(this.pos), f = this.pos - k;
      if (p[3] > 0.5 && this.rack.running && k >= 0 && k + 1 < n) {
        o[0] = (L[k] + (L[k + 1] - L[k]) * f) * 5 * p[1];
        o[1] = (this.R[k] + (this.R[k + 1] - this.R[k]) * f) * 5 * p[1];
        const t = this.pos / (this.ratio * this.sr);
        const grid = this.grid;
        if (grid !== null) {
          while (this.g < grid.length && grid[this.g] <= t) {
            this.p16.fire();
            if (this.g % 16 === 0) this.pBar.fire();
            this.g++;
          }
        }
        const kicks = this.kicks;
        if (kicks !== null) {
          while (this.c < kicks.length && kicks[this.c] <= t) { this.pKick.fire(); this.c++; }
        }
        this.pos += (p[0] + i[1] * 0.1) * this.ratio;
      } else {
        o[0] = 0; o[1] = 0;
        if (p[3] > 0.5 && this.rack.running) {
          if (p[2] > 0.5) { this.pos = this.pos < 0 ? n - 2 : 0; this.g = 0; this.c = 0; }
        }
      }
      o[2] = this.p16.tick();
      o[3] = this.pBar.tick();
      o[4] = this.pKick.tick();
      this.ui[0] = n ? this.pos / n : 0;
    }
  },
};

export const sampler = {
  type: 'sampler', title: 'SAMPLER', category: 'io', theme: 'black',
  description: 'One-shot sampler: drop a file on it, then trigger and pitch it from cables',
  tags: ['sample', 'one shot', 'chop', 'stab'],
  inputs: [
    { name: 'trig', label: 'TRIG', kind: 'gate' },
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'tune', label: 'TUNE', min: -24, max: 24, default: 0, step: 1, format: fmtSt },
    { name: 'start', label: 'START', min: 0, max: 1, default: 0, format: fmtPct, cv: true },
    { name: 'len', label: 'LENGTH', min: 0, max: 1, default: 1, format: fmtPct, cv: true },
    { name: 'fade', label: 'FADE', min: 0, max: 1, default: 0.2, format: fmtExp(0.0005, 0.2) },
  ],
  widgets: [{ ui: 'waveform', w: 150, h: 60 }],
  dsp: class Sampler extends Module {
    constructor(sr) {
      super(sr);
      this.L = null;
      this.pos = -1;
      this.end = 0;
      this.ratio = 1;
      this.amp = 0; this.fadeIn = 0;
      this.trig = new Trigger();
    }
    onMessage(m) {
      if (m.kind === 'clear') { this.L = null; this.pos = -1; return; }
      if (m.kind !== 'buffer') return;
      this.L = m.L;
      this.ratio = m.sr / this.sr;
      this.pos = -1;
    }
    tick(i, o, p) {
      const L = this.L;
      if (L === null) { o[0] = 0; return; }
      const n = L.length;
      if (this.trig.tick(i[0])) {
        this.pos = p[1] * (n - 2);
        this.end = Math.min(n - 2, this.pos + p[2] * (n - 2));
        this.amp = 0;
      }
      if (this.pos < 0) { o[0] = 0; return; }
      const k = Math.floor(this.pos), f = this.pos - k;
      const fade = expmap(p[3], 0.0005, 0.2);
      const left = (this.end - this.pos) / (this.ratio * this.sr);
      const env = Math.min(1, left / fade);
      this.amp = Math.min(1, this.amp + this.dt / 0.0005);
      o[0] = (L[k] + (L[k + 1] - L[k]) * f) * 5 * this.amp * env;
      this.pos += this.ratio * 2 ** (i[1] + p[0] / 12);
      if (this.pos >= this.end) this.pos = -1;
      this.ui[0] = this.pos / n;
    }
  },
};

export const audioin = {
  type: 'audioin', title: 'AUDIO IN', category: 'io',
  description: 'Microphone or line input',
  tags: ['microphone', 'line', 'interface', 'external'],
  inputs: [],
  outputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  params: [{ name: 'gain', label: 'GAIN', min: 0, max: 8, default: 1, size: 'L', format: fmtPct }],
  lights: [{ name: 'signal', label: 'SIG', color: 'green' }],
  dsp: class AudioIn extends Module {
    constructor(sr) { super(sr); this.dcL = new DCBlock(sr); this.dcR = new DCBlock(sr); }
    tick(i, o, p) {
      const l = this.dcL.tick(this.rack.inL) * 5 * p[0], r = this.dcR.tick(this.rack.inR) * 5 * p[0];
      o[0] = l;
      o[1] = r;
      this.ui[0] = Math.max(this.ui[0] * 0.9995, Math.min(1, Math.abs(l) * 0.2));
    }
  },
};

export const midi = {
  type: 'midi', title: 'MIDI IN', category: 'io',
  description: 'MIDI notes, velocity, mod wheel and clock as voltages. Your computer keyboard plays it too',
  tags: ['keyboard', 'controller', 'notes', 'cv'],
  inputs: [],
  outputs: [
    { name: 'pitch', label: 'PITCH', kind: 'pitch' }, { name: 'gate', label: 'GATE', kind: 'gate' },
    { name: 'vel', label: 'VEL', kind: 'cv' }, { name: 'mod', label: 'MOD', kind: 'cv' },
    { name: 'clk', label: 'CLK', kind: 'gate' }, { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  params: [
    { name: 'bend', label: 'BEND', min: 0, max: 12, default: 2, step: 1, format: (v) => `±${v} st` },
    { name: 'mono', label: 'PRIORITY', type: 'select', options: ['LAST', 'LOW', 'HIGH'], default: 0 },
  ],
  lights: [{ name: 'gate', label: '', color: 'red' }],
  widgets: [{ ui: 'keys', w: 170, h: 50 }],
  dsp: class Midi extends Module {
    constructor(sr) {
      super(sr);
      this.notes = [];
      this.pitch = 0; this.vel = 0; this.mod = 0; this.bend = 0;
      this.gap = 0;
      this.ticks = 0;
      this.pClk = new Pulse(sr, 2); this.pRst = new Pulse(sr, 2);
    }
    onMessage(m) {
      if (m.kind !== 'midi') return;
      const [st, a, b] = m.data;
      const type = st & 0xf0;
      if (type === 0x90 && b > 0) {
        this.notes = this.notes.filter((n) => n !== a);
        this.notes.push(a);
        this.vel = b / 12.7;
        this.gap = 24;
      } else if (type === 0x80 || (type === 0x90 && b === 0)) {
        this.notes = this.notes.filter((n) => n !== a);
      } else if (type === 0xb0 && a === 1) this.mod = b / 12.7;
      else if (type === 0xe0) this.bend = (b * 128 + a - 8192) / 8192;
      else if (st === 0xf8) { if (this.ticks++ % 6 === 0) this.pClk.fire(); }
      else if (st === 0xfa) { this.ticks = 0; this.pRst.fire(); }
    }
    tick(i, o, p) {
      const n = this.notes;
      let note = -1;
      if (n.length) {
        const mode = p[1];
        if (mode === 0) note = n[n.length - 1];
        else {
          note = n[0];
          for (let k = 1; k < n.length; k++) if (mode === 1 ? n[k] < note : n[k] > note) note = n[k];
        }
        this.pitch = (note - 60) / 12;
      }
      o[0] = this.pitch + (this.bend * p[0]) / 12;
      let g = note >= 0 ? 10 : 0;
      if (this.gap > 0) { this.gap--; g = 0; }
      o[1] = g;
      o[2] = this.vel;
      o[3] = this.mod;
      o[4] = this.pClk.tick();
      o[5] = this.pRst.tick();
      this.ui[0] = g ? 1 : 0;
    }
  },
};

export const io = [deck, sampler, audioin, midi];
