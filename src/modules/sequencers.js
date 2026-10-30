// Clocks and sequencers: everything that decides when, and which note.
import { Module, Trigger, Pulse, Rng, clamp, fmtPct } from './lib/index.js';

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const clock = {
  type: 'clock', title: 'CLOCK', category: 'seq',
  description: 'Master clock: the tempo of the wall. ▶ starts and stops every clock',
  tags: ['tempo', 'bpm', 'swing', 'master'],
  inputs: [],
  outputs: [
    { name: 's16', label: '1/16', kind: 'gate' },
    { name: 's8', label: '1/8', kind: 'gate' },
    { name: 's4', label: '1/4', kind: 'gate' },
    { name: 'bar', label: 'BAR', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
    { name: 'ramp', label: 'RAMP', kind: 'cv' },
  ],
  params: [
    { name: 'bpm', label: 'TEMPO', min: 40, max: 240, default: 132, size: 'L', format: (v) => `${v.toFixed(1)} BPM` },
    { name: 'swing', label: 'SWING', min: 0.5, max: 0.75, default: 0.5, format: fmtPct, cv: true },
  ],
  lights: [{ name: 'beat', label: '', color: 'red' }, { name: 'bar', label: '', color: 'green' }],
  widgets: [{ ui: 'bpm', w: 84, h: 36 }],
  dsp: class Clock extends Module {
    constructor(sr) {
      super(sr);
      this.pos = 2;          // inside a pair of 16ths, 0..2
      this.oddDue = false;
      this.n = 0;
      this.was = false;
      this.p16 = new Pulse(sr, 2); this.p8 = new Pulse(sr, 2); this.p4 = new Pulse(sr, 2);
      this.pBar = new Pulse(sr, 2); this.pRst = new Pulse(sr, 2);
      this.rate = 0;         // 16ths per sample
    }
    // how far the wall has come, in 16ths; steady through swing
    position() { return ((this.n - 1) & ~1) + this.pos; }
    samplesTo(step) { return (step - this.position()) / this.rate; }
    step() {
      const n = this.n++;
      this.p16.fire();
      if (n % 2 === 0) this.p8.fire();
      if (n % 4 === 0) { this.p4.fire(); this.ui[0] = 1; }
      if (n % 16 === 0) { this.pBar.fire(); this.ui[1] = 1; }
    }
    tick(i, o, p) {
      const running = this.rack.running;
      if (running && !this.was) {
        // start exactly on the one
        this.n = 0; this.pos = 0; this.oddDue = true;
        this.pRst.fire();
        this.step();
      }
      this.was = running;
      if (running) {
        this.rate = (p[0] / 15) * this.dt;
        this.pos += this.rate;
        if (this.oddDue && this.pos >= 2 * p[1]) { this.oddDue = false; this.step(); }
        if (this.pos >= 2) { this.pos -= 2; this.oddDue = true; this.step(); }
      }
      o[0] = this.p16.tick();
      o[1] = this.p8.tick();
      o[2] = this.p4.tick();
      o[3] = this.pBar.tick();
      o[4] = this.pRst.tick();
      o[5] = running ? ((((this.n - 1) & 14) + this.pos) / 16) * 10 : 0;   // once a bar, 0 to 10 V
      this.ui[0] *= 0.9992;
      this.ui[1] *= 0.9992;
      this.ui[2] = p[0];
      this.ui[3] = this.position();
    }
  },
};

export const divider = {
  type: 'divider', title: 'DIVIDER', category: 'seq',
  description: 'Clock divider: one input, a trigger every 2, 3, 4, 6, 8, 12, 16 and 32 pulses',
  tags: ['clock', 'polymeter'],
  inputs: [{ name: 'clk', label: 'CLK', kind: 'gate' }, { name: 'rst', label: 'RST', kind: 'gate' }],
  outputs: [2, 3, 4, 6, 8, 12, 16, 32].map((n) => ({ name: `d${n}`, label: `/${n}`, kind: 'gate' })),
  params: [],
  dsp: class Divider extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger(); this.rst = new Trigger();
      this.n = 0;
      this.pulses = new Array(8);
      for (let k = 0; k < 8; k++) this.pulses[k] = new Pulse(sr, 2);
    }
    tick(i, o) {
      if (this.rst.tick(i[1])) this.n = 0;
      if (this.clk.tick(i[0])) {
        for (let k = 0; k < 8; k++) if (this.n % Divider.N[k] === 0) this.pulses[k].fire();
        this.n++;
      }
      for (let k = 0; k < 8; k++) o[k] = this.pulses[k].tick();
    }
    static N = [2, 3, 4, 6, 8, 12, 16, 32];
  },
};

export const bassline = {
  type: 'bassline', title: 'BASSLINE', category: 'seq', theme: 'silver',
  description: 'Acid sequencer: a 16-step note grid with accent and slide for the Acid Box',
  tags: ['acid', 'pattern', 'step', '303', 'piano roll'],
  inputs: [
    { name: 'clk', label: 'CLK', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  outputs: [
    { name: 'pitch', label: 'PITCH', kind: 'pitch' },
    { name: 'gate', label: 'GATE', kind: 'gate' },
    { name: 'accent', label: 'ACC', kind: 'gate' },
    { name: 'slide', label: 'SLIDE', kind: 'gate' },
  ],
  params: [
    { name: 'length', label: 'STEPS', min: 1, max: 16, default: 16, step: 1, size: 'S' },
    { name: 'gatelen', label: 'GATE', min: 0.1, max: 1, default: 0.5, format: fmtPct, size: 'S' },
    { name: 'transpose', label: 'TRANS', min: -24, max: 24, default: 0, step: 1, size: 'S', cv: true },
  ],
  lights: [{ name: 'gate', label: '', color: 'red' }],
  widgets: [{ ui: 'pianoroll', w: 470, h: 214 }],
  defaultData: () => ({ steps: Array.from({ length: 16 }, (_, k) => ({ n: 12, g: k % 2 ? 0 : 1, a: 0, s: 0 })) }),
  dsp: class Bassline extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger(); this.rst = new Trigger();
      this.k = -1;
      this.steps = [];
      this.since = 0;
      this.period = sr / 8;
      this.fresh = true;   // no clock measured since a reset
      this.ran = false;
      this.on = false;
      this.hold = false;   // this note's gate runs on into the next step
      this.gap = 0;        // samples of low gate, so a repeat retriggers
      this.pitch = 0; this.acc = 0; this.sld = 0;
    }
    onData(d) { this.steps = d?.steps ?? []; }
    step(p) {
      const steps = this.steps, len = Math.min(p[0], steps.length);
      if (!len) return;
      const before = this.k >= 0 ? steps[this.k % len] : null;
      this.k = (this.k + 1) % len;
      const s = steps[this.k];
      const tied = !!(before && before.g && before.s && s.g);
      this.ui[1] = this.k;
      this.sld = tied ? 10 : 0;
      if (s.g) {
        this.pitch = (s.n + p[2]) / 12 - 2;
        this.acc = s.a ? 10 : 0;
        if (this.on && !tied) this.gap = 8;
        this.on = true;
      } else {
        this.acc = 0;
        this.on = false;
      }
      this.hold = !!(s.g && s.s);
      this.since = 0;
    }
    tick(i, o, p) {
      if (this.rst.tick(i[1])) { this.k = -1; this.fresh = true; }
      // the transport changing: stop must not leave a note ringing, and the first pulse after a
      // stop says nothing about the tempo. An outside clock can still play it while stopped.
      if (this.rack.running !== this.ran) { this.ran = this.rack.running; this.fresh = true; this.on = false; }
      this.since++;
      if (this.clk.tick(i[0])) {
        if (!this.fresh) this.period = this.since;
        this.fresh = false;
        this.step(p);
      }
      if (this.on && !this.hold && this.since >= this.period * p[1]) this.on = false;
      let g = this.on ? 10 : 0;
      if (this.gap > 0) { this.gap--; g = 0; }
      o[0] = this.pitch;
      o[1] = g;
      o[2] = this.acc;
      o[3] = this.sld;
      this.ui[0] = this.on ? 1 : 0;
    }
  },
};

export const drumseq = {
  type: 'drumseq', title: 'RHYTHM COMPOSER', category: 'seq', theme: 'grey',
  description: 'Drum sequencer: eight rows of sixteen steps plus an accent row',
  tags: ['drum machine', 'pattern', 'step', 'grid', '909'],
  inputs: [
    { name: 'clk', label: 'CLK', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  outputs: [
    ...['BD', 'SD', 'CH', 'OH', 'CP', 'RS', 'LT', 'HT'].map((l, k) => ({ name: `t${k + 1}`, label: l, kind: 'gate' })),
    { name: 'acc', label: 'ACC', kind: 'cv' },
  ],
  params: [
    { name: 'length', label: 'STEPS', min: 1, max: 16, default: 16, step: 1, size: 'S' },
  ],
  widgets: [{ ui: 'stepgrid', w: 470, h: 210, rows: ['BD', 'SD', 'CH', 'OH', 'CP', 'RS', 'LT', 'HT', 'AC'] }],
  defaultData: () => ({
    rows: [
      [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      ...Array.from({ length: 8 }, () => new Array(16).fill(0)),
    ],
  }),
  dsp: class DrumSeq extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger(); this.rst = new Trigger();
      this.k = -1;
      this.rows = [];
      this.pulses = new Array(8);
      for (let t = 0; t < 8; t++) this.pulses[t] = new Pulse(sr, 2);
      this.acc = 0;
    }
    onData(d) { this.rows = d?.rows ?? []; }
    tick(i, o, p) {
      if (this.rst.tick(i[1])) this.k = -1;
      if (this.clk.tick(i[0])) {
        this.k = (this.k + 1) % p[0];
        const rows = this.rows;
        for (let t = 0; t < 8; t++) if (rows[t]?.[this.k]) this.pulses[t].fire();
        this.acc = rows[8]?.[this.k] ? 10 : 0;
        this.ui[0] = this.k;
      }
      for (let t = 0; t < 8; t++) o[t] = this.pulses[t].tick();
      o[8] = this.acc;
    }
  },
};

const eight = (fn) => Array.from({ length: 8 }, (_, k) => fn(k + 1, k));

export const step8 = {
  type: 'step8', title: 'ANALOG SEQUENCER', category: 'seq',
  description: 'Eight steps of knobs in two rows, the classic analog sequencer',
  tags: ['cv', 'pattern', 'berlin school'],
  cols: 8,
  inputs: [
    { name: 'clk', label: 'CLK', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  outputs: [
    { name: 'a', label: 'CV A', kind: 'pitch' },
    { name: 'b', label: 'CV B', kind: 'cv' },
    { name: 'gate', label: 'GATE', kind: 'gate' },
    { name: 'trig', label: 'TRIG', kind: 'gate' },
  ],
  params: [
    ...eight((n, k) => ({ name: `a${n}`, label: `${n}`, min: -2, max: 2, default: [0, 0.25, 0.58, 0.25, 0.83, 0.58, 0.25, 0.17][k], size: 'S', format: (v) => `${v.toFixed(2)} V` })),
    ...eight((n, k) => ({ name: `b${n}`, label: `${n}`, min: 0, max: 10, default: 5, size: 'S', br: k === 0, format: (v) => `${v.toFixed(2)} V` })),
    ...eight((n, k) => ({ name: `g${n}`, label: `${n}`, type: 'toggle', default: 1, br: k === 0 })),
    { name: 'length', label: 'STEPS', min: 1, max: 8, default: 8, step: 1, size: 'S', br: true },
    { name: 'dir', label: 'DIR', type: 'select', options: ['FWD', 'REV', 'PEND', 'RND'], default: 0 },
    { name: 'scale', label: 'SCALE', type: 'select', options: ['OFF', 'CHROM', 'MINOR', 'PHRYG', 'DORIAN', 'PENTA'], default: 2 },
    { name: 'gatelen', label: 'GATE', min: 0.05, max: 1, default: 0.5, size: 'S', format: fmtPct },
  ],
  lights: eight((n) => ({ name: `s${n}`, label: '', color: 'red' })),
  dsp: class Step8 extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger(); this.rst = new Trigger();
      this.k = -1; this.dirn = 1;
      this.since = 0; this.period = sr / 8;
      this.fresh = true;
      this.ran = false;
      this.pulse = new Pulse(sr, 2);
      this.rng = new Rng(1234);
      this.gated = false;
    }
    tick(i, o, p) {
      if (this.rst.tick(i[1])) { this.k = -1; this.dirn = 1; this.fresh = true; }
      const len = p[24], dir = p[25];
      if (this.rack.running !== this.ran) { this.ran = this.rack.running; this.fresh = true; this.gated = false; }
      this.since++;
      if (this.clk.tick(i[0])) {
        if (!this.fresh) this.period = this.since;
        this.fresh = false;
        this.since = 0;
        if (dir === 0) this.k = (this.k + 1) % len;
        else if (dir === 1) this.k = this.k <= 0 || this.k >= len ? len - 1 : this.k - 1;
        else if (dir === 2) {
          if (this.k + this.dirn >= len) this.dirn = -1;
          else if (this.k + this.dirn < 0) this.dirn = 1;
          this.k = clamp(this.k + this.dirn, 0, len - 1);
        } else this.k = Math.floor(this.rng.next() * len);
        this.gated = p[16 + this.k] > 0.5;
        if (this.gated) this.pulse.fire();
        for (let n = 0; n < 8; n++) this.ui[n] = n === this.k ? 1 : 0;
      }
      if (this.k < 0) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 0; return; }
      let v = p[this.k];
      const scale = p[26];
      if (scale > 0) {
        const table = Step8.SCALES[scale - 1];
        const semi = Math.round(v * 12), oct = Math.floor(semi / 12), note = semi - oct * 12;
        let best = 0, dist = 99;
        for (let n = 0; n < table.length; n++) {
          const d = Math.abs(table[n] - note);
          if (d < dist) { dist = d; best = table[n]; }
        }
        v = oct + best / 12;
      }
      o[0] = v;
      o[1] = p[8 + this.k];
      o[2] = this.gated && this.since < this.period * p[27] ? 10 : 0;
      o[3] = this.pulse.tick();
    }
    static SCALES = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [0, 2, 3, 5, 7, 8, 10], [0, 1, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 9, 10], [0, 3, 5, 7, 10]];
  },
};

export const euclid = {
  type: 'euclid', title: 'EUCLID', category: 'seq',
  description: 'Euclidean rhythms: spreads N hits as evenly as possible over M steps',
  tags: ['rhythm', 'polyrhythm', 'pattern', 'gate'],
  inputs: [{ name: 'clk', label: 'CLK', kind: 'gate' }, { name: 'rst', label: 'RST', kind: 'gate' }],
  outputs: [{ name: 'trig', label: 'TRIG', kind: 'gate' }, { name: 'gate', label: 'GATE', kind: 'gate' }, { name: 'off', label: 'OFF', kind: 'gate' }],
  params: [
    { name: 'hits', label: 'HITS', min: 0, max: 32, default: 5, step: 1, cv: true },
    { name: 'steps', label: 'STEPS', min: 1, max: 32, default: 16, step: 1, cv: true },
    { name: 'rot', label: 'ROTATE', min: 0, max: 31, default: 0, step: 1, cv: true },
  ],
  widgets: [{ ui: 'ring', w: 84, h: 84 }],
  dsp: class Euclid extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger(); this.rst = new Trigger();
      this.k = -1;
      this.pulse = new Pulse(sr, 2); this.offp = new Pulse(sr, 2);
      this.gate = 0;
      this.ran = false;
    }
    // the classic Bresenham form: step k is a hit if the running remainder wraps there
    static hit(k, hits, steps) { return (k * hits) % steps < hits; }
    tick(i, o, p) {
      if (this.rst.tick(i[1])) this.k = -1;
      const steps = p[1], hits = Math.min(p[0], steps), rot = p[2];
      if (this.rack.running !== this.ran) { this.ran = this.rack.running; this.gate = 0; }   // stop closes the gate
      if (this.clk.tick(i[0])) {
        this.k = (this.k + 1) % steps;
        const on = hits > 0 && Euclid.hit((this.k + rot) % steps, hits, steps);
        this.gate = on ? 10 : 0;
        if (on) this.pulse.fire(); else this.offp.fire();
      }
      o[0] = this.pulse.tick();
      o[1] = this.gate;
      o[2] = this.offp.tick();
      this.ui[0] = this.k; this.ui[1] = hits; this.ui[2] = steps; this.ui[3] = rot;
    }
  },
};

export const turing = {
  type: 'turing', title: 'TURING', category: 'seq',
  description: 'Random looping shift register: from pure chance to a locked melody',
  tags: ['random', 'generative', 'melody', 'shift register'],
  inputs: [{ name: 'clk', label: 'CLK', kind: 'gate' }],
  outputs: [{ name: 'cv', label: 'CV', kind: 'pitch' }, { name: 'gate', label: 'GATE', kind: 'gate' }],
  params: [
    { name: 'lock', label: 'LOCK', min: 0, max: 1, default: 0.9, size: 'L', format: fmtPct, cv: true },
    { name: 'length', label: 'LENGTH', min: 2, max: 16, default: 8, step: 1 },
    { name: 'range', label: 'RANGE', min: 0, max: 4, default: 1 },
  ],
  lights: Array.from({ length: 8 }, (_, k) => ({ name: `b${k}`, label: '', color: 'green' })),
  dsp: class Turing extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger();
      this.rng = new Rng(31337);
      this.reg = (this.rng.next() * 65536) | 0;
      this.pulse = new Pulse(sr, 8);
      this.v = 0;
    }
    tick(i, o, p) {
      if (this.clk.tick(i[0])) {
        const len = p[1], reg = this.reg;
        let bit = (reg >> (len - 1)) & 1;
        if (this.rng.next() > p[0]) bit ^= 1;
        this.reg = ((reg << 1) | bit) & 0xffff;
        if (bit) this.pulse.fire();
        this.v = ((this.reg & 255) / 255) * p[2];
        for (let k = 0; k < 8; k++) this.ui[k] = (this.reg >> k) & 1;
      }
      o[0] = this.v;
      o[1] = this.pulse.tick();
    }
  },
};

export const quant = {
  type: 'quant', title: 'QUANTIZER', category: 'seq',
  description: 'Snaps any voltage to the notes of a scale',
  tags: ['scale', 'pitch', 'tune', 'key'],
  inputs: [{ name: 'in', label: 'IN', kind: 'pitch' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'pitch' }],
  params: [
    { name: 'root', label: 'ROOT', min: 0, max: 11, default: 0, step: 1, format: (v) => NOTE[Math.round(v)] ?? '' },
    { name: 'scale', label: 'SCALE', type: 'select', options: ['CHROM', 'MAJOR', 'MINOR', 'DORIAN', 'PHRYG', 'MIXO', 'MIN PENT', 'MAJ PENT', 'BLUES', 'OCTAVE'], default: 2, cv: true },
    { name: 'shift', label: 'OCTAVE', min: -3, max: 3, default: 0, step: 1 },
  ],
  dsp: class Quant extends Module {
    tick(i, o, p) {
      const root = p[0], table = Quant.SCALES[p[1]];
      const semi = i[0] * 12 - root, oct = Math.floor(semi / 12), note = semi - oct * 12;
      let best = 0, dist = 99;
      for (let n = 0; n <= table.length; n++) {
        const t = n === table.length ? 12 : table[n];
        const d = Math.abs(t - note);
        if (d < dist) { dist = d; best = t; }
      }
      o[0] = (oct * 12 + best + root) / 12 + p[2];
    }
    static SCALES = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 9, 10], [0, 1, 3, 5, 7, 8, 10], [0, 2, 4, 5, 7, 9, 10], [0, 3, 5, 7, 10], [0, 2, 4, 7, 9], [0, 3, 5, 6, 7, 10], [0]];
  },
};

export const chance = {
  type: 'chance', title: 'CHANCE', category: 'seq',
  description: 'Coin toss: every trigger goes out of A or out of B',
  tags: ['bernoulli', 'random', 'probability', 'gate'],
  inputs: [{ name: 'in', label: 'IN', kind: 'gate' }],
  outputs: [{ name: 'a', label: 'A', kind: 'gate' }, { name: 'b', label: 'B', kind: 'gate' }],
  params: [{ name: 'prob', label: 'A', min: 0, max: 1, default: 0.5, size: 'L', format: fmtPct, cv: true }],
  dsp: class Chance extends Module {
    constructor(sr) {
      super(sr);
      this.rng = new Rng(2718);
      this.in = new Trigger();
      this.pa = new Pulse(sr, 2); this.pb = new Pulse(sr, 2);
    }
    tick(i, o, p) {
      if (this.in.tick(i[0])) { if (this.rng.next() < p[0]) this.pa.fire(); else this.pb.fire(); }
      o[0] = this.pa.tick();
      o[1] = this.pb.tick();
    }
  },
};

export const sequencers = [clock, divider, bassline, drumseq, step8, euclid, turing, quant, chance];
