// The end of the signal path: the desk, and the one output that reaches your ears.
import { Module, DCBlock, TAU, fmtPct } from './lib/index.js';

const eight = (fn) => Array.from({ length: 8 }, (_, k) => fn(k + 1, k));

export const desk = {
  type: 'desk', title: 'MIXING DESK', category: 'mix',
  description: 'Eight channels with pan, two sends and mutes, and two stereo returns',
  tags: ['mixer', 'console', 'send', 'aux', 'return'],
  hp: 34, cols: 11,
  inputs: [
    ...eight((n) => ({ name: `ch${n}`, label: `${n}`, kind: 'audio' })),
    { name: 'retL', label: 'RET A', kind: 'audio' },
    { name: 'retR', label: 'A R', kind: 'audio' },
    { name: 'ret2L', label: 'RET B', kind: 'audio' },
    { name: 'ret2R', label: 'B R', kind: 'audio' },
  ],
  outputs: [
    { name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' },
    { name: 'sendA', label: 'A', kind: 'audio' }, { name: 'sendB', label: 'B', kind: 'audio' },
  ],
  params: [
    ...eight((n, k) => ({ name: `a${n}`, label: 'SEND A', min: 0, max: 1, default: 0, size: 'T', format: fmtPct, br: k === 0 })),
    ...eight((n, k) => ({ name: `b${n}`, label: 'SEND B', min: 0, max: 1, default: 0, size: 'T', format: fmtPct, br: k === 0 })),
    ...eight((n, k) => ({ name: `pan${n}`, label: 'PAN', min: -1, max: 1, default: 0, size: 'T', br: k === 0 })),
    ...eight((n, k) => ({ name: `lvl${n}`, label: `${n}`, min: 0, max: 1.25, default: 0.8, size: 'f', format: fmtPct, br: k === 0 })),
    { name: 'ret', label: 'RET A', min: 0, max: 1.25, default: 0.8, size: 'f', format: fmtPct },
    { name: 'ret2', label: 'RET B', min: 0, max: 1.25, default: 0.8, size: 'f', format: fmtPct },
    { name: 'main', label: 'MAIN', min: 0, max: 1.25, default: 1, size: 'f', format: fmtPct },
    ...eight((n, k) => ({ name: `mute${n}`, label: 'MUTE', type: 'toggle', default: 0, br: k === 0 })),
  ],
  dsp: class Desk extends Module {
    constructor(sr) {
      super(sr);
      this.gl = new Float64Array(8); this.gr = new Float64Array(8);
      this.last = new Float64Array(8).fill(9);
    }
    tick(i, o, p) {
      let l = 0, r = 0, a = 0, b = 0;
      for (let k = 0; k < 8; k++) {
        if (!this.linked[k] || p[35 + k] > 0.5) continue;
        const pan = p[16 + k];
        if (pan !== this.last[k]) {
          this.last[k] = pan;
          const t = (pan + 1) * 0.7853981634;
          this.gl[k] = Math.cos(t) * 1.4142136;
          this.gr[k] = Math.sin(t) * 1.4142136;
        }
        const x = i[k], v = x * p[24 + k];
        l += v * this.gl[k];
        r += v * this.gr[k];
        a += x * p[k];
        b += x * p[8 + k];
      }
      const aL = i[8], aR = this.linked[9] ? i[9] : aL, bL = i[10], bR = this.linked[11] ? i[11] : bL;
      const ra = p[32], rb = p[33], main = p[34];
      o[0] = (l + aL * ra + bL * rb) * main;
      o[1] = (r + aR * ra + bR * rb) * main;
      o[2] = a;
      o[3] = b;
    }
  },
};

export const master = {
  type: 'master', title: 'MASTER', category: 'mix',
  description: 'The output of the wall: what reaches this module is what you hear',
  tags: ['output', 'limiter', 'speakers'],
  inputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  outputs: [{ name: 'outL', label: 'L', kind: 'audio' }, { name: 'outR', label: 'R', kind: 'audio' }],
  params: [
    { name: 'volume', label: 'VOLUME', min: 0, max: 1.5, default: 0.9, size: 'L', format: fmtPct },
  ],
  lights: [{ name: 'limit', label: 'LIMIT', color: 'red' }, { name: 'peak', label: 'CLIP', color: 'red' }],
  dsp: class Master extends Module {
    constructor(sr) {
      super(sr);
      this.env = 0;
      this.release = Math.exp(-1 / (0.12 * sr));
      this.dcL = new DCBlock(sr, 5);
      this.dcR = new DCBlock(sr, 5);
    }
    tick(i, o, p) {
      // ±10 V is full scale. Clean until a peak would pass the ceiling; then the gain drops
      // on that very sample, so nothing gets through, and recovers over 120 ms.
      const R = this.linked[1] ? i[1] : i[0];
      const l = this.dcL.tick(i[0]) * 0.1 * p[0], r = this.dcR.tick(R) * 0.1 * p[0];
      const a = Math.max(Math.abs(l), Math.abs(r));
      this.env = a > this.env ? a : this.env * this.release + (1 - this.release) * a;
      const g = this.env > 0.95 ? 0.95 / this.env : 1;
      o[0] = l * g;
      o[1] = r * g;
      this.ui[0] = g < 1 ? Math.min(1, (1 - g) * 6) : 0;
      this.ui[1] = a > 1 ? 1 : this.ui[1] * 0.9995;
    }
  },
};

// Two stereo sources into one, as a DJ mixer does it: a fader between them and, on a knob of its
// own, which of them has the bass. Both knobs are eased on the sample, so they can be thrown on a
// downbeat without a click.
export const djmix = {
  type: 'djmix', title: 'DJ MIXER', category: 'mix',
  description: 'Two stereo channels with a crossfader, and a knob for which of them keeps the bass',
  tags: ['crossfade', 'transition', 'bass swap', 'dj', 'blend', 'stereo'],
  inputs: [
    { name: 'aL', label: 'A L', kind: 'audio' }, { name: 'aR', label: 'A R', kind: 'audio' },
    { name: 'bL', label: 'B L', kind: 'audio' }, { name: 'bR', label: 'B R', kind: 'audio' },
  ],
  outputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  params: [
    { name: 'fade', label: 'A – B', min: 0, max: 1, default: 0, size: 'L', format: fmtPct },
    { name: 'lows', label: 'LOWS', min: 0, max: 1, default: 0, format: fmtPct },
  ],
  dsp: class DjMix extends Module {
    constructor(sr) {
      super(sr);
      this.s = new Float64Array(16);
      this.bass = Math.tan((TAU * 0.5 * 150) / sr);   // 24 dB an octave at 150 Hz
      this.ease = 1 - Math.exp(-1 / (0.005 * sr));
      this.fade = 0; this.lows = 0; this.ga = 1; this.gb = 0;
    }
    // two filters in a row on one side of a channel; k is where its state starts
    noBass(k, x) {
      const s = this.s, g = this.bass, r = 1.41421356, a = 1 / (1 + g * (g + r));
      let hp = (x - (g + r) * s[k] - s[k + 1]) * a;
      let bp = g * hp + s[k];
      s[k + 1] += 2 * g * bp;
      s[k] = g * hp + bp;
      x = hp;
      hp = (x - (g + r) * s[k + 2] - s[k + 3]) * a;
      bp = g * hp + s[k + 2];
      s[k + 3] += 2 * g * bp;
      s[k + 2] = g * hp + bp;
      return hp;
    }
    tick(i, o, p) {
      if (this.fade !== p[0]) {
        this.fade += (p[0] - this.fade) * this.ease;
        if (Math.abs(p[0] - this.fade) < 1e-5) this.fade = p[0];
        this.ga = Math.cos(this.fade * TAU * 0.25);
        this.gb = Math.sin(this.fade * TAU * 0.25);
      }
      this.lows += (p[1] - this.lows) * this.ease;
      const a = Math.min(1, 2 - 2 * this.lows), b = Math.min(1, 2 * this.lows);
      const al = i[0], ar = this.linked[1] ? i[1] : al, bl = i[2], br = this.linked[3] ? i[3] : bl;
      const l0 = al * a + this.noBass(0, al) * (1 - a), r0 = ar * a + this.noBass(4, ar) * (1 - a);
      const l1 = bl * b + this.noBass(8, bl) * (1 - b), r1 = br * b + this.noBass(12, br) * (1 - b);
      o[0] = l0 * this.ga + l1 * this.gb;
      o[1] = r0 * this.ga + r1 * this.gb;
    }
  },
};

export const mix = [desk, djmix, master];
