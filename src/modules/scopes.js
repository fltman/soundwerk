// Oscilloscopes and meters. The DSP side only captures: the drawing happens on the wall.
import { Module, Trigger, expmap } from './lib/index.js';

const fmtDiv = (t) => {
  const s = expmap(t, 0.00005, 0.2);
  return s >= 0.01 ? `${(s * 1000).toFixed(0)} ms/div` : `${(s * 1000).toFixed(2)} ms/div`;
};

export const scope = {
  type: 'scope', title: 'OSCILLOSCOPE', category: 'scope',
  description: 'Two-channel triggered oscilloscope with a phosphor screen',
  tags: ['monitor', 'waveform', 'crt', 'display'],
  wave: true,
  hp: 28,
  inputs: [
    { name: 'a', label: 'CH A', kind: 'audio' },
    { name: 'b', label: 'CH B', kind: 'audio' },
    { name: 'ext', label: 'TRIG', kind: 'gate' },
  ],
  outputs: [],
  params: [
    { name: 'time', label: 'TIME', min: 0, max: 1, default: 0.56, size: 'M', format: fmtDiv },
    { name: 'gainA', label: 'A V/DIV', min: 0.2, max: 5, default: 2, size: 'S', display: true },
    { name: 'gainB', label: 'B V/DIV', min: 0.2, max: 5, default: 2, size: 'S', display: true },
    { name: 'posA', label: 'A POS', min: -4, max: 4, default: 0, size: 'S', display: true },
    { name: 'posB', label: 'B POS', min: -4, max: 4, default: 0, size: 'S', display: true },
    { name: 'level', label: 'TRIG LV', min: -10, max: 10, default: 0, size: 'S', format: (v) => `${v.toFixed(1)} V` },
    { name: 'source', label: 'SOURCE', type: 'select', options: ['A', 'B', 'EXT'], default: 0 },
    { name: 'mode', label: 'MODE', type: 'select', options: ['AUTO', 'NORM', 'FREE'], default: 0 },
    { name: 'phosphor', label: 'PHOSPHOR', type: 'select', options: ['GREEN', 'AMBER', 'BLUE'], default: 0, display: true },
  ],
  widgets: [{ ui: 'scope', w: 400, h: 200 }],
  // layout of `wave`: A then B, each POINTS pairs of (min, max). ui[0] is how many points a sweep
  // has, ui[2] counts sweeps and ui[3] is how far the beam has got, so the wall draws the trace
  // as it happens, like a tube, instead of when the sweep is over.
  dsp: class Scope extends Module {
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.prev = 0;
      this.pos = -1;       // -1 = waiting for a trigger
      this.wait = 0;
      this.sub = 0;
      this.loA = 0; this.hiA = 0; this.loB = 0; this.hiB = 0;
      this.first = true;
    }
    tick(i, o, p) {
      const a = i[0], b = i[1];
      const source = p[6], mode = p[7];
      const x = source === 0 ? a : source === 1 ? b : i[2];
      const lvl = source === 2 ? 2 : p[5];
      const rising = this.prev < lvl && x >= lvl;
      this.prev = x;
      if (this.pos < 0) {
        this.wait++;
        const timeout = mode === 0 && this.wait > this.sr * 0.12;
        if (rising || mode === 2 || timeout) {
          this.pos = 0; this.sub = 0; this.first = true; this.wait = 0;
          // samples per point for a 10-division screen, and how many points that makes
          const span = 10 * expmap(p[0], 0.00005, 0.2) * this.sr;
          this.points = span < Scope.POINTS ? Math.max(8, Math.round(span)) : Scope.POINTS;
          this.per = Math.max(1, Math.round(span / this.points));
          this.ui[0] = this.points;
        }
        if (this.pos < 0) return;
      }
      if (this.first) { this.loA = a; this.hiA = a; this.loB = b; this.hiB = b; this.first = false; } else {
        if (a < this.loA) this.loA = a; else if (a > this.hiA) this.hiA = a;
        if (b < this.loB) this.loB = b; else if (b > this.hiB) this.hiB = b;
      }
      if (++this.sub >= this.per) {
        const W = this.wave, k = this.pos * 2;
        W[k] = this.loA; W[k + 1] = this.hiA;
        W[4096 + k] = this.loB; W[4096 + k + 1] = this.hiB;
        this.sub = 0; this.first = true;
        this.ui[3] = ++this.pos;
        if (this.pos >= this.points) {
          this.ui[2] = (this.ui[2] + 1) % 1024;
          this.pos = -1;
        }
      }
    }
    static POINTS = 512;
  },
};

export const xyscope = {
  type: 'xyscope', title: 'VECTOR SCOPE', category: 'scope',
  description: 'X/Y display: Lissajous figures, stereo image, oscilloscope music',
  tags: ['lissajous', 'goniometer', 'stereo', 'display'],
  wave: true,
  inputs: [{ name: 'x', label: 'X', kind: 'audio' }, { name: 'y', label: 'Y', kind: 'audio' }],
  outputs: [],
  params: [
    { name: 'zoom', label: 'ZOOM', min: 0.05, max: 1, default: 0.25, size: 'S', display: true },
    { name: 'rotate', label: 'MODE', type: 'select', options: ['X/Y', 'M/S'], default: 0, display: true },
    { name: 'phosphor', label: 'PHOSPHOR', type: 'select', options: ['GREEN', 'AMBER', 'BLUE'], default: 0, display: true },
  ],
  widgets: [{ ui: 'xy', w: 190, h: 190 }],
  dsp: class XY extends Module {
    constructor(sr) { super(sr); this.w = 0; }
    tick(i) {
      const W = this.wave, k = this.w * 2;
      W[k] = i[0];
      W[k + 1] = i[1];
      this.w = (this.w + 1) & 8191;
      this.ui[0] = this.w;
    }
  },
};

const ringDef = {
  wave: true,
  dsp: class Ring extends Module {
    constructor(sr) { super(sr); this.w = 0; }
    tick(i) {
      this.wave[this.w] = i[0];
      this.w = (this.w + 1) & 16383;
      this.ui[0] = this.w;
      this.ui[1] = this.sr;
    }
  },
};

export const analyzer = {
  type: 'analyzer', title: 'SPECTRUM', category: 'scope',
  description: 'Spectrum analyser, 20 Hz to 20 kHz with peak hold',
  tags: ['fft', 'frequency', 'display', 'eq'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [],
  params: [],
  widgets: [{ ui: 'spectrum', w: 280, h: 190 }],
  ...ringDef,
};

export const waterfall = {
  type: 'waterfall', title: 'WATERFALL', category: 'scope',
  description: 'Spectrogram: frequency over time, scrolling',
  tags: ['spectrogram', 'fft', 'display', 'time'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [],
  params: [],
  widgets: [{ ui: 'waterfall', w: 280, h: 190 }],
  ...ringDef,
};

export const vu = {
  type: 'vu', title: 'VU METER', category: 'scope',
  description: 'A pair of needles, with real VU ballistics',
  tags: ['level', 'meter', 'needle'],
  inputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  outputs: [],
  params: [],
  widgets: [{ ui: 'vu', w: 130, h: 90 }, { ui: 'vu', w: 130, h: 90, channel: 1 }],
  dsp: class VU extends Module {
    constructor(sr) {
      super(sr);
      this.c = 1 - Math.exp(-1 / (0.065 * sr)); // 300 ms to 99 %, the VU standard
      this.l = 0; this.r = 0;
    }
    tick(i) {
      this.l += this.c * (Math.abs(i[0]) - this.l);
      const R = this.linked[1] ? i[1] : i[0];
      this.r += this.c * (Math.abs(R) - this.r);
      this.ui[0] = this.l;
      this.ui[1] = this.r;
    }
  },
};

export const scopes = [scope, xyscope, analyzer, waterfall, vu];
