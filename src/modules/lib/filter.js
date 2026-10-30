// Helpers for filter and shaper modules. Every name starts with filter/Filter: they share lib's namespace.
import { DENORMAL } from './core.js';

// TPT integrator gain: prewarped, so an analog corner lands exactly on `hz`, right up to Nyquist
export const filterG = (hz, sr) => Math.tan(Math.PI * Math.min(hz / sr, 0.49));

// tanh(x) / x, matching lib's tanh: the gain of a saturating stage at the level it is driven to
export const filterTanhGain = (x) => {
  const x2 = x * x;
  return x2 < 9 ? (27 + x2) / (27 + 9 * x2) : 1 / Math.abs(x);
};

// Solves w + b·tanh(w) = a by Newton, using lib's tanh: a saturator closed around a linear
// instantaneous path of gain b. Monotonic, so it converges from the linear solution, from below;
// two steps are -75 dB from converged at worst (hot, at 22 kHz), one is an audible -32 dB.
export const filterSolve = (a, b) => {
  let w = a / (1 + b);
  for (let n = 0; n < 2; n++) {
    const w2 = w * w;
    if (w2 >= 9) { w = a - (w > 0 ? b : -b); continue; }
    const e = (9 - w2) / (9 + 3 * w2);
    w -= (w + (b * w * (27 + w2)) / (27 + 9 * w2) - a) / (1 + b * e * e);
  }
  return w;
};

// TPT state-variable filter. set(g, k), k = 1/Q; tick(x), then read .lp, .bp (gain Q at the
// centre) and .hp. Trapezoidal state stays stable when g moves every sample.
export class FilterSVF {
  constructor() {
    this.z1 = 0; this.z2 = 0;
    this.lp = 0; this.bp = 0; this.hp = 0;
    this.g = 0; this.k = 1; this.a1 = 1;
  }
  set(g, k) {
    this.g = g; this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
  }
  tick(x) {
    const g = this.g, a1 = this.a1, z1 = this.z1, z2 = this.z2;
    const v1 = a1 * (z1 + g * (x - z2));
    const v2 = z2 + g * v1;
    this.z1 = 2 * v1 - z1 + DENORMAL;
    this.z2 = 2 * v2 - z2 + DENORMAL;
    this.bp = v1;
    this.lp = v2;
    this.hp = x - this.k * v1 - v2;
  }
}

// Oversampling by 2, 4 or 8 with elliptic polyphase allpass halfbands (hiir's design equations),
// far cheaper than FIRs of the same stopband. up(x) fills .buf[0..factor), oldest first; shape
// it in place; down() gives the sample back. A stage only has to stop what could still fold into
// the band of the stage after it, so only the one nearest the signal is steep: it is 82 dB down
// by 0.52 of the base rate, which leaves the alias-free band ending just above Nyquist.
export class FilterOver {
  static STEEP = [0.0575171854, 0.2059330315, 0.3922044347, 0.5693387833, 0.7139114284, 0.8229583565, 0.9042701537, 0.9694581539];
  static MID = [0.1413486811, 0.5899948723];
  static LAST = [0.1143535258, 0.5442190979];
  constructor(factor = 2) {
    this.factor = factor;
    this.buf = new Float64Array(factor);
    this.c1 = FilterOver.STEEP; this.c2 = FilterOver.MID; this.c3 = FilterOver.LAST;
    this.u1 = new Float64Array(16); this.d1 = new Float64Array(16);
    this.u2 = new Float64Array(4); this.d2 = new Float64Array(4);
    this.u3 = new Float64Array(4); this.d3 = new Float64Array(4);
    this.a = 0; this.b = 0;
  }
  // two allpass chains, one path per output sample: y = c·(x − y₋₁) + x₋₁
  run(a, b, c, s) {
    for (let k = 0, j = 0, n = c.length; k < n; k += 2, j += 4) {
      let t = (a - s[j + 1]) * c[k] + s[j];
      s[j] = a; s[j + 1] = t; a = t;
      t = (b - s[j + 3]) * c[k + 1] + s[j + 2];
      s[j + 2] = b; s[j + 3] = t; b = t;
    }
    this.a = a; this.b = b;
  }
  split(x, c, s) { this.run(x + DENORMAL, x + DENORMAL, c, s); }
  join(older, newer, c, s) {
    this.run(newer + DENORMAL, older + DENORMAL, c, s);
    return 0.5 * (this.a + this.b);
  }
  up(x) {
    const buf = this.buf, f = this.factor;
    this.split(x, this.c1, this.u1);
    if (f === 2) { buf[0] = this.a; buf[1] = this.b; return; }
    const p = this.a, q = this.b;
    this.split(p, this.c2, this.u2);
    const r = this.a, s = this.b;
    this.split(q, this.c2, this.u2);
    if (f === 4) { buf[0] = r; buf[1] = s; buf[2] = this.a; buf[3] = this.b; return; }
    const t = this.a, w = this.b;
    this.split(r, this.c3, this.u3); buf[0] = this.a; buf[1] = this.b;
    this.split(s, this.c3, this.u3); buf[2] = this.a; buf[3] = this.b;
    this.split(t, this.c3, this.u3); buf[4] = this.a; buf[5] = this.b;
    this.split(w, this.c3, this.u3); buf[6] = this.a; buf[7] = this.b;
  }
  down() {
    const buf = this.buf, f = this.factor;
    if (f === 2) return this.join(buf[0], buf[1], this.c1, this.d1);
    let a, b;
    if (f === 4) {
      a = this.join(buf[0], buf[1], this.c2, this.d2);
      b = this.join(buf[2], buf[3], this.c2, this.d2);
    } else {
      const p = this.join(buf[0], buf[1], this.c3, this.d3);
      const q = this.join(buf[2], buf[3], this.c3, this.d3);
      const r = this.join(buf[4], buf[5], this.c3, this.d3);
      const s = this.join(buf[6], buf[7], this.c3, this.d3);
      a = this.join(p, q, this.c2, this.d2);
      b = this.join(r, s, this.c2, this.d2);
    }
    return this.join(a, b, this.c1, this.d1);
  }
}
