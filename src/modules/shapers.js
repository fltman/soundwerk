// Waveshapers. Harmonics above Nyquist are the enemy here: everything nonlinear runs oversampled.
import { Module, DCBlock, OnePole, expmap, tanh, fmtPct, fmtDb, fmtExpHz, FilterOver } from './lib/index.js';

export const drive = {
  type: 'drive', title: 'DRIVE', category: 'shape',
  description: 'Saturator: tube warmth, tape squash or fuzz, with level kept in check',
  tags: ['distortion', 'overdrive', 'saturation', 'fuzz', 'tube', 'tape'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'mode', label: 'TYPE', type: 'select', options: ['TUBE', 'TAPE', 'FUZZ'], default: 0 },
    { name: 'drive', label: 'DRIVE', min: 0, max: 1, default: 0.4, size: 'L', cv: true, format: fmtPct },
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.7, format: fmtExpHz(700, 18000) },
    { name: 'output', label: 'OUTPUT', min: -24, max: 12, default: 0, format: fmtDb },
  ],
  dsp: class Drive extends Module {
    constructor(sr) {
      super(sr);
      this.os = new FilterOver(8); // 4x folds the 55th harmonic of a hard-driven 3 kHz back in
      this.dc = new DCBlock(sr, 10);
      this.lp = new OnePole(sr, 8000);
      this.drive = NaN; this.mode = -1; this.tone = NaN; this.output = NaN;
      this.G = 1; this.comp = 1; this.out = 1;
      this.tube0 = tanh(0.35); this.fuzz0 = tanh(0.3);
    }
    tick(i, o, p) {
      const mode = p[0], drive = p[1], tone = p[2], output = p[3];
      if (drive !== this.drive || mode !== this.mode) {
        this.drive = drive; this.mode = mode;
        const G = 0.5 * 60 ** drive, e = mode === 2 ? 2.5 * G : G; // gain into a curve that clips at ±1
        this.G = G;
        this.comp = Math.sqrt(1 + 0.5 * e * e) / e; // a 5 V sine keeps its level at any drive
      }
      if (tone !== this.tone) { this.tone = tone; this.lp.setHz(expmap(tone, 700, 18000)); }
      if (output !== this.output) { this.output = output; this.out = 10 ** (output / 20); }
      const os = this.os, b = os.buf;
      os.up(i[0] * 0.2 * this.G);
      if (mode === 0) {
        // tube: biased, so one side clips first; even harmonics
        for (let k = 0; k < 8; k++) b[k] = tanh(b[k] + 0.35) - this.tube0;
      } else if (mode === 1) {
        // tape: a long soft knee, symmetric
        for (let k = 0; k < 8; k++) { const x = b[k]; b[k] = x / Math.sqrt(1 + x * x); }
      } else {
        // fuzz: harder and lopsided
        for (let k = 0; k < 8; k++) b[k] = tanh(2.5 * b[k] + 0.3) - this.fuzz0;
      }
      o[0] = 5 * this.dc.tick(this.lp.tick(os.down())) * this.comp * this.out;
    }
  },
};

export const folder = {
  type: 'folder', title: 'FOLDER', category: 'shape',
  description: 'West-coast wavefolder: folds the wave back on itself for bright, vocal harmonics',
  tags: ['wavefolder', 'buchla', 'serge', 'west coast', 'distortion'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'fold', label: 'FOLD', min: 0, max: 1, default: 0.35, size: 'L', cv: true, format: fmtPct },
    { name: 'symmetry', label: 'SYMMETRY', min: -1, max: 1, default: 0, format: fmtPct, cv: true },
  ],
  dsp: class Folder extends Module {
    constructor(sr) {
      super(sr);
      this.os = new FilterOver(8);
      this.dc = new DCBlock(sr, 10);
      this.fold = NaN;
      this.G = 1; this.norm = 1;
    }
    tick(i, o, p) {
      const fold = p[0], symmetry = p[1];
      if (fold !== this.fold) {
        this.fold = fold;
        const G = expmap(fold, 0.6, 8); // a 5 V input reaches the first fold at G = 1
        this.G = G;
        this.norm = 1 / Math.sin(1.5707963267948966 * Math.min(G, 1));
      }
      const os = this.os, b = os.buf, offset = symmetry * 0.8;
      os.up(i[0] * 0.2 * this.G);
      for (let k = 0; k < 8; k++) {
        // sine plus its third: straight flanks and rounded tips, between Serge and a pure triangle
        const s = Math.sin(1.5707963267948966 * (b[k] + offset));
        b[k] = s + (0.111 * (4 * s * s * s - 3 * s));
      }
      o[0] = this.dc.tick(os.down()) * 5 * this.norm * 0.9;
    }
  },
};

export const crush = {
  type: 'crush', title: 'CRUSH', category: 'shape',
  description: 'Bit crusher and sample-rate reducer: digital dirt from 16 bits down to 1',
  tags: ['bitcrusher', 'lofi', 'decimator', 'distortion'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'bits', label: 'BITS', min: 1, max: 16, default: 7, size: 'L', cv: true, format: (v) => `${v.toFixed(1)} bit` },
    { name: 'rate', label: 'RATE', min: 0, max: 1, default: 0.7, cv: true, format: fmtExpHz(100, 48000) },
  ],
  dsp: class Crush extends Module {
    constructor(sr) {
      super(sr);
      this.phase = 1;
      this.held = 0;
      this.bits = NaN; this.rate = NaN;
      this.step = 1; this.inc = 1;
    }
    tick(i, o, p) {
      const bits = p[0], rate = p[1];
      if (bits !== this.bits) { this.bits = bits; this.step = 10 / 2 ** bits; }
      if (rate !== this.rate) { this.rate = rate; this.inc = expmap(rate, 100, 48000) * this.dt; }
      this.phase += this.inc;
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        this.held = Math.round(i[0] / this.step) * this.step; // mid-tread: silence stays silent
      }
      o[0] = this.held;
    }
  },
};

export const ringmod = {
  type: 'ringmod', title: 'RING MOD', category: 'shape',
  description: 'Ring modulator: multiplies two signals for clangorous sum and difference tones',
  tags: ['ring modulator', 'multiply', 'bell'],
  inputs: [
    { name: 'in', label: 'IN', kind: 'audio' },
    { name: 'mod', label: 'MOD', kind: 'audio' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [{ name: 'mix', label: 'MIX', min: 0, max: 1, default: 1, cv: true, format: fmtPct }],
  dsp: class RingMod extends Module {
    constructor(sr) {
      super(sr);
      this.a = new FilterOver(2);
      this.b = new FilterOver(2);
    }
    tick(i, o, p) {
      const a = this.a, b = this.b, mix = p[0], x = a.buf, y = b.buf;
      a.up(i[0]);
      b.up(i[1]);
      // mixed up here so the dry signal goes through exactly what the product does
      x[0] = (1 - mix) * x[0] + mix * x[0] * y[0] * 0.2;
      x[1] = (1 - mix) * x[1] + mix * x[1] * y[1] * 0.2;
      o[0] = a.down();
    }
  },
};

export const shapers = [drive, folder, crush, ringmod];
