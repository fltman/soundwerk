// The small boxes that fill the gaps between the big ones.
import { Module, Trigger, Pulse, clamp, fmtPct } from './lib/index.js';

export const vca = {
  type: 'vca', title: 'VCA', category: 'util',
  description: 'Voltage-controlled amplifier: a gain knob you can patch an envelope into',
  tags: ['amp', 'level', 'volume'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }, { name: 'cv', label: 'CV', kind: 'cv' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'level', label: 'LEVEL', min: 0, max: 2, default: 1, size: 'L', format: fmtPct },
    { name: 'curve', label: 'CURVE', type: 'select', options: ['LIN', 'EXP'], default: 0 },
  ],
  dsp: class VCA extends Module {
    tick(i, o, p) {
      let g = 1;
      if (this.linked[1]) {
        g = clamp(i[1] * 0.1, 0, 1);
        if (p[1] === 1) g = g * g * g;
      }
      o[0] = i[0] * g * p[0];
    }
  },
};

export const mixer = {
  type: 'mixer', title: 'MIXER', category: 'util',
  description: 'Four inputs to one output, for audio or CV',
  tags: ['sum', 'merge'],
  inputs: [1, 2, 3, 4].map((n) => ({ name: `in${n}`, label: `${n}`, kind: 'audio' })),
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }, { name: 'inv', label: 'INV', kind: 'audio' }],
  params: [
    ...[1, 2, 3, 4].map((n) => ({ name: `l${n}`, label: `${n}`, min: 0, max: 1, default: 0.8, format: fmtPct })),
    { name: 'main', label: 'MAIN', min: 0, max: 1.5, default: 1, format: fmtPct },
  ],
  dsp: class Mixer extends Module {
    tick(i, o, p) {
      const v = (i[0] * p[0] + i[1] * p[1] + i[2] * p[2] + i[3] * p[3]) * p[4];
      o[0] = v;
      o[1] = -v;
    }
  },
};

export const offset = {
  type: 'offset', title: 'OFFSET', category: 'util',
  description: 'Three attenuverters with offset. Unpatched, each is a hand-set voltage',
  tags: ['attenuverter', 'scale', 'manual', 'cv', 'voltage'],
  inputs: [1, 2, 3].map((n) => ({ name: `in${n}`, label: `IN${n}`, kind: 'cv' })),
  outputs: [1, 2, 3].map((n) => ({ name: `out${n}`, label: `OUT${n}`, kind: 'cv' })),
  cols: 2,
  params: [1, 2, 3].flatMap((n) => [
    { name: `s${n}`, label: `SCALE`, min: -1, max: 1, default: 1, size: 'S' },
    { name: `o${n}`, label: `OFFS`, min: -10, max: 10, default: 0, size: 'S', format: (v) => `${v.toFixed(2)} V` },
  ]),
  dsp: class Offset extends Module {
    tick(i, o, p) {
      o[0] = i[0] * p[0] + p[1];
      o[1] = i[1] * p[2] + p[3];
      o[2] = i[2] * p[4] + p[5];
    }
  },
};

export const crossfade = {
  type: 'crossfade', title: 'XFADE', category: 'util',
  description: 'Crossfader between two signals, with equal power, under CV control',
  tags: ['blend', 'morph', 'fade'],
  inputs: [{ name: 'a', label: 'A', kind: 'audio' }, { name: 'b', label: 'B', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [{ name: 'mix', label: 'A–B', min: 0, max: 1, default: 0.5, size: 'L', format: fmtPct, cv: true }],
  dsp: class Crossfade extends Module {
    tick(i, o, p) {
      const t = p[0];
      o[0] = i[0] * Math.cos(t * 1.5707963) + i[1] * Math.sin(t * 1.5707963);
    }
  },
};

export const seqswitch = {
  type: 'seqswitch', title: 'SWITCH', category: 'util',
  description: 'Sequential switch: every trigger moves to the next of four inputs',
  tags: ['route', 'multiplexer', 'step'],
  inputs: [
    ...[1, 2, 3, 4].map((n) => ({ name: `in${n}`, label: `${n}`, kind: 'audio' })),
    { name: 'clk', label: 'CLK', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [{ name: 'steps', label: 'STEPS', min: 2, max: 4, default: 4, step: 1 }],
  lights: [1, 2, 3, 4].map((n) => ({ name: `l${n}`, label: '', color: 'green' })),
  dsp: class SeqSwitch extends Module {
    constructor(sr) { super(sr); this.clk = new Trigger(); this.rst = new Trigger(); this.k = 0; }
    tick(i, o, p) {
      // both triggers tick every sample, or a clock on the reset sample arrives one sample late
      const rst = this.rst.tick(i[5]), clk = this.clk.tick(i[4]);
      if (rst) this.k = 0;
      else if (clk) this.k = (this.k + 1) % p[0];
      o[0] = i[this.k];
      for (let n = 0; n < 4; n++) this.ui[n] = n === this.k ? 1 : 0;
    }
  },
};

export const logic = {
  type: 'logic', title: 'LOGIC', category: 'util',
  description: 'AND, OR, XOR and NOT of two gates',
  tags: ['gate', 'boolean'],
  inputs: [{ name: 'a', label: 'A', kind: 'gate' }, { name: 'b', label: 'B', kind: 'gate' }],
  outputs: [
    { name: 'and', label: 'AND', kind: 'gate' }, { name: 'or', label: 'OR', kind: 'gate' },
    { name: 'xor', label: 'XOR', kind: 'gate' }, { name: 'not', label: 'NOT A', kind: 'gate' },
  ],
  params: [],
  dsp: class Logic extends Module {
    constructor(sr) { super(sr); this.a = new Trigger(); this.b = new Trigger(); }
    tick(i, o) {
      this.a.tick(i[0]);
      this.b.tick(i[1]);
      const a = this.a.high, b = this.b.high;
      o[0] = a && b ? 10 : 0;
      o[1] = a || b ? 10 : 0;
      o[2] = a !== b ? 10 : 0;
      o[3] = a ? 0 : 10;
    }
  },
};

export const compare = {
  type: 'compare', title: 'COMPARE', category: 'util',
  description: 'Gate high while a voltage is above a threshold; turns any wave into a gate',
  tags: ['threshold', 'comparator', 'cv to gate'],
  inputs: [{ name: 'in', label: 'IN', kind: 'cv' }],
  outputs: [{ name: 'gate', label: 'GATE', kind: 'gate' }, { name: 'trig', label: 'TRIG', kind: 'gate' }],
  params: [{ name: 'thresh', label: 'LEVEL', min: -10, max: 10, default: 0, size: 'L', format: (v) => `${v.toFixed(2)} V`, cv: true }],
  lights: [{ name: 'gate', label: '', color: 'red' }],
  dsp: class Compare extends Module {
    constructor(sr) { super(sr); this.on = false; this.pulse = new Pulse(sr, 2); }
    tick(i, o, p) {
      const v = i[0], t = p[0];
      if (this.on) { if (v < t - 0.05) this.on = false; } else if (v > t + 0.05) { this.on = true; this.pulse.fire(); }
      o[0] = this.on ? 10 : 0;
      o[1] = this.pulse.tick();
      this.ui[0] = this.on ? 1 : 0;
    }
  },
};

export const panner = {
  type: 'panner', title: 'PAN', category: 'util',
  description: 'Places a mono signal in the stereo field, equal power, under CV control',
  tags: ['stereo', 'auto pan'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  params: [{ name: 'pan', label: 'PAN', min: -1, max: 1, default: 0, size: 'L', cv: true }],
  dsp: class Panner extends Module {
    tick(i, o, p) {
      const t = (p[0] + 1) * 0.7853981634;
      o[0] = i[0] * Math.cos(t) * 1.4142136;
      o[1] = i[0] * Math.sin(t) * 1.4142136;
    }
  },
};

export const utility = [vca, mixer, offset, crossfade, seqswitch, logic, compare, panner];
