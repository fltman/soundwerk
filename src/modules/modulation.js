// Things that move other things: LFOs, envelopes, random, slew.
import { Module, TAU, DENORMAL, Trigger, Rng, expmap, fmtExp, fmtExpHz } from './lib/index.js';

export const lfo = {
  type: 'lfo', title: 'LFO', category: 'mod',
  description: 'Low-frequency oscillator, free or locked to a clock',
  tags: ['oscillator', 'modulation', 'wobble'],
  inputs: [
    { name: 'clk', label: 'CLK', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  outputs: [
    { name: 'bi', label: '±5V', kind: 'cv' },
    { name: 'uni', label: '0-10', kind: 'cv' },
    { name: 'sq', label: 'SQR', kind: 'gate' },
  ],
  params: [
    { name: 'rate', label: 'RATE', min: 0, max: 1, default: 0.45, size: 'L', format: fmtExpHz(0.02, 40), cv: true },
    { name: 'shape', label: 'SHAPE', type: 'select', options: ['SINE', 'TRI', 'SAW', 'SQR', 'S&H'], default: 0, cv: true },
    { name: 'div', label: 'CLK DIV', type: 'select', options: ['1', '2', '3', '4', '6', '8', '12', '16', '24', '32', '48', '64', '96', '128'], default: 7 },
  ],
  lights: [{ name: 'out', label: '', color: 'red' }],
  dsp: class LFO extends Module {
    constructor(sr) {
      super(sr);
      this.phase = 0;
      this.clk = new Trigger();
      this.rst = new Trigger();
      this.since = 0;
      this.period = 0;
      this.count = 0;
      this.fresh = true;
      this.ran = false;
      this.held = 0;
      this.rng = new Rng(4711);
      this.swallow = false;
    }
    // a reset on the first pulse swallows it, so a patched reset costs a pulse
    rewind() { this.phase = 0; this.count = 0; this.fresh = true; this.swallow = this.linked[1] === 1; }
    advance(n, p) {
      if (n <= 0) return;
      const div = LFO.DIVS[p[2]];
      this.count = (this.count + n - (this.swallow ? 1 : 0)) % div;
      this.phase = this.count / div;
      this.swallow = false;
    }
    tick(i, o, p) {
      const shape = p[1];
      let inc = expmap(p[0], 0.02, 40) * this.dt;
      if (this.linked[0]) {
        // count clock pulses: one cycle lasts `div` of them, and it snaps back to 0 on time
        const n = LFO.DIVS[p[2]];
        if (this.rack.running !== this.ran) { this.ran = this.rack.running; this.fresh = true; }
        this.since++;
        if (this.clk.tick(i[0])) {
          // the first pulse after a reset or a stop says nothing about the tempo
          if (!this.fresh) this.period = this.since;
          this.fresh = false;
          this.since = 0;
          if (this.swallow) this.swallow = false;
          else if (++this.count >= n) {
            this.count = 0;
            this.phase = 0;
            this.held = this.rng.bipolar();
          }
        }
        if (this.period > 0) inc = 1 / (this.period * n);
      }
      if (this.rst.tick(i[1])) { this.phase = 0; this.count = 0; this.fresh = true; }
      this.phase += inc;
      if (this.phase >= 1) {
        this.phase -= 1;
        if (!(this.linked[0] && this.period > 0)) this.held = this.rng.bipolar();
      }
      const t = this.phase;
      let v;
      if (shape === 0) v = Math.sin(TAU * t);
      else if (shape === 1) v = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
      else if (shape === 2) v = 2 * t - 1;
      else if (shape === 3) v = t < 0.5 ? 1 : -1;
      else v = this.held;
      o[0] = 5 * v;
      o[1] = 5 + 5 * v;
      o[2] = t < 0.5 ? 10 : 0;
      this.ui[0] = 0.5 + 0.5 * v;
    }
    static DIVS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
  },
};

export const adsr = {
  type: 'adsr', title: 'ADSR', category: 'mod',
  description: 'Envelope generator with RC-shaped curves',
  tags: ['envelope', 'contour'],
  inputs: [{ name: 'gate', label: 'GATE', kind: 'gate' }],
  outputs: [
    { name: 'env', label: 'ENV', kind: 'cv' },
    { name: 'inv', label: 'INV', kind: 'cv' },
  ],
  params: [
    { name: 'a', label: 'ATTACK', min: 0, max: 1, default: 0.1, format: fmtExp(0.001, 8), cv: true },
    { name: 'd', label: 'DECAY', min: 0, max: 1, default: 0.45, format: fmtExp(0.002, 8), cv: true },
    { name: 's', label: 'SUSTAIN', min: 0, max: 1, default: 0.5, cv: true },
    { name: 'r', label: 'RELEASE', min: 0, max: 1, default: 0.4, format: fmtExp(0.002, 8), cv: true },
  ],
  lights: [{ name: 'gate', label: '', color: 'red' }],
  dsp: class ADSR extends Module {
    constructor(sr) {
      super(sr);
      this.v = 0;
      this.stage = 0; // 0 idle, 1 attack, 2 decay/sustain, 3 release
      this.gate = new Trigger();
      this.lastA = -1; this.lastD = -1; this.lastR = -1;
      this.ca = 0; this.cd = 0; this.cr = 0;
    }
    tick(i, o, p) {
      if (p[0] !== this.lastA) { this.lastA = p[0]; this.ca = 1 - Math.exp(-this.dt / (expmap(p[0], 0.001, 8) * 0.4)); }
      // a decay knob reads the time to fall 60 dB
      if (p[1] !== this.lastD) { this.lastD = p[1]; this.cd = 1 - Math.exp(-this.dt / (expmap(p[1], 0.002, 8) / 6.91)); }
      if (p[3] !== this.lastR) { this.lastR = p[3]; this.cr = 1 - Math.exp(-this.dt / (expmap(p[3], 0.002, 8) / 6.91)); }
      if (this.gate.tick(i[0])) this.stage = 1;
      else if (!this.gate.high && this.stage !== 0 && this.stage !== 3) this.stage = 3;
      let v = this.v;
      if (this.stage === 1) {
        // aims past 1, as a capacitor charging toward a higher rail does
        v += this.ca * (1.3 - v);
        if (v >= 1) { v = 1; this.stage = 2; }
      } else if (this.stage === 2) v += this.cd * (p[2] - v);
      else if (this.stage === 3) v += this.cr * (0 - v) + DENORMAL;
      this.v = v;
      o[0] = 10 * v;
      o[1] = 10 - 10 * v;
      this.ui[0] = v;
    }
  },
};

export const decay = {
  type: 'decay', title: 'DECAY ENV', category: 'mod',
  description: 'Attack-decay envelope from a trigger, can loop as a slow LFO',
  tags: ['envelope', 'ad', 'function'],
  inputs: [{ name: 'trig', label: 'TRIG', kind: 'gate' }],
  outputs: [{ name: 'env', label: 'ENV', kind: 'cv' }, { name: 'end', label: 'EOC', kind: 'gate' }],
  params: [
    { name: 'a', label: 'ATTACK', min: 0, max: 1, default: 0.05, format: fmtExp(0.0005, 4), cv: true },
    { name: 'd', label: 'DECAY', min: 0, max: 1, default: 0.4, format: fmtExp(0.002, 8), size: 'L', cv: true },
    { name: 'curve', label: 'CURVE', min: 0, max: 1, default: 0.75 },
    { name: 'loop', label: 'LOOP', type: 'toggle', default: 0 },
  ],
  lights: [{ name: 'env', label: '', color: 'red' }],
  dsp: class Decay extends Module {
    constructor(sr) {
      super(sr);
      this.t = 1;       // 0..1 through attack then decay
      this.rising = false;
      this.trig = new Trigger();
      this.eoc = 0;
    }
    tick(i, o, p) {
      const curve = p[2];
      if (this.trig.tick(i[0]) || (p[3] > 0.5 && !this.rising && this.t >= 1)) { this.rising = true; this.t = 0; }
      let v;
      if (this.rising) {
        this.t += this.dt / expmap(p[0], 0.0005, 4);
        v = this.t;
        if (this.t >= 1) { this.rising = false; this.t = 0; v = 1; }
      } else if (this.t < 1) {
        this.t += this.dt / expmap(p[1], 0.002, 8);
        if (this.t >= 1) { this.t = 1; this.eoc = this.sr * 0.002; }
        const lin = 1 - this.t;
        // curve 0 is a straight line, 1 close to an RC decay
        v = lin + (lin * lin * lin * lin - lin) * curve;
      } else v = 0;
      o[0] = 10 * v;
      o[1] = this.eoc > 0 ? 10 : 0;
      if (this.eoc > 0) this.eoc--;
      this.ui[0] = v;
    }
  },
};

export const wander = {
  type: 'wander', title: 'WANDER', category: 'mod',
  description: 'Slow smooth randomness, for things that should drift',
  tags: ['random', 'drift', 'smooth'],
  inputs: [],
  outputs: [{ name: 'bi', label: '±5V', kind: 'cv' }, { name: 'uni', label: '0-10', kind: 'cv' }],
  params: [
    { name: 'rate', label: 'RATE', min: 0, max: 1, default: 0.4, format: fmtExpHz(0.01, 20), size: 'L', cv: true },
    { name: 'amt', label: 'AMOUNT', min: 0, max: 1, default: 1, cv: true },
  ],
  dsp: class Wander extends Module {
    constructor(sr) {
      super(sr);
      this.rng = new Rng(9001);
      this.a = 0; this.b = this.rng.bipolar(); this.t = 0;
    }
    tick(i, o, p) {
      this.t += expmap(p[0], 0.01, 20) * this.dt;
      if (this.t >= 1) { this.t -= 1; this.a = this.b; this.b = this.rng.bipolar(); }
      const t = this.t, s = t * t * (3 - 2 * t);
      const v = (this.a + (this.b - this.a) * s) * p[1];
      o[0] = 5 * v;
      o[1] = 5 + 5 * v;
    }
  },
};

export const sh = {
  type: 'sh', title: 'S&H', category: 'mod',
  description: 'Sample and hold: grabs a voltage on every trigger. Unpatched input samples noise',
  tags: ['sample and hold', 'random', 'stepped'],
  inputs: [
    { name: 'in', label: 'IN', kind: 'cv' },
    { name: 'trig', label: 'TRIG', kind: 'gate' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'cv' }],
  params: [{ name: 'glide', label: 'GLIDE', min: 0, max: 1, default: 0, format: fmtExp(0.0002, 1) }],
  dsp: class SH extends Module {
    constructor(sr) {
      super(sr);
      this.rng = new Rng(777);
      this.trig = new Trigger();
      this.held = 0;
      this.v = 0;
    }
    tick(i, o, p) {
      if (this.trig.tick(i[1])) this.held = this.linked[0] ? i[0] : this.rng.bipolar() * 5;
      const a = p[0] <= 0.001 ? 1 : 1 - Math.exp(-this.dt / expmap(p[0], 0.0002, 1));
      this.v += a * (this.held - this.v);
      o[0] = this.v;
    }
  },
};

export const slew = {
  type: 'slew', title: 'SLEW', category: 'mod',
  description: 'Slew limiter: portamento, or turns gates into simple envelopes',
  tags: ['portamento', 'glide', 'lag'],
  inputs: [{ name: 'in', label: 'IN', kind: 'cv' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'cv' }],
  params: [
    { name: 'rise', label: 'RISE', min: 0, max: 1, default: 0.3, format: fmtExp(0.0005, 4), cv: true },
    { name: 'fall', label: 'FALL', min: 0, max: 1, default: 0.3, format: fmtExp(0.0005, 4), cv: true },
  ],
  dsp: class Slew extends Module {
    constructor(sr) { super(sr); this.v = 0; }
    tick(i, o, p) {
      const x = i[0], tau = expmap(x > this.v ? p[0] : p[1], 0.0005, 4);
      this.v += (x - this.v) * (1 - Math.exp(-this.dt / tau)) + DENORMAL;
      o[0] = this.v;
    }
  },
};

export const follower = {
  type: 'follower', title: 'FOLLOWER', category: 'mod',
  description: 'Envelope follower: turns the loudness of a sound into a control voltage and a gate',
  tags: ['envelope', 'sidechain', 'audio to cv'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'env', label: 'ENV', kind: 'cv' }, { name: 'gate', label: 'GATE', kind: 'gate' }],
  params: [
    { name: 'gain', label: 'GAIN', min: 0, max: 4, default: 1 },
    { name: 'attack', label: 'ATTACK', min: 0, max: 1, default: 0.15, format: fmtExp(0.0002, 0.5) },
    { name: 'release', label: 'RELEASE', min: 0, max: 1, default: 0.45, format: fmtExp(0.005, 2) },
    { name: 'thresh', label: 'THRESH', min: 0, max: 10, default: 2 },
  ],
  lights: [{ name: 'gate', label: '', color: 'red' }],
  dsp: class Follower extends Module {
    constructor(sr) { super(sr); this.v = 0; this.open = false; }
    tick(i, o, p) {
      const x = Math.abs(i[0]) * p[0] * 2;
      const tau = x > this.v ? expmap(p[1], 0.0002, 0.5) : expmap(p[2], 0.005, 2);
      this.v += (x - this.v) * (1 - Math.exp(-this.dt / tau)) + DENORMAL;
      const env = this.v > 10 ? 10 : this.v;
      if (this.open) { if (env < p[3] * 0.7) this.open = false; } else if (env > p[3]) this.open = true;
      o[0] = env;
      o[1] = this.open ? 10 : 0;
      this.ui[0] = this.open ? 1 : 0;
    }
  },
};

export const modulation = [lfo, adsr, decay, wander, sh, slew, follower];
