// The end of the signal path: the desk, and the one output that reaches your ears.
import { Module, DCBlock, fmtPct } from './lib/index.js';

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

export const mix = [desk, master];
