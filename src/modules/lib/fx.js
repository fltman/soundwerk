// Helpers for the fx modules. Everything is Fx-prefixed because lib/index.js merges with `export *`.
import { DelayLine, DENORMAL, TAU, Trigger, tanh } from './core.js';

// DelayLine with a 4-point Hermite read, so a sweeping head keeps its top end. d ≥ 3; an
// integer d reads back the exact sample.
export class FxLine extends DelayLine {
  hermite(d) {
    const pos = this.w - d, i = Math.floor(pos), f = pos - i, m = this.mask, b = this.buf;
    const y0 = b[(i - 1) & m], y1 = b[i & m], y2 = b[(i + 1) & m], y3 = b[(i + 2) & m];
    const c = (y2 - y0) * 0.5, v = y1 - y2, w = c + v, a = w + v + (y3 - y1) * 0.5;
    return ((a * f - (w + a)) * f + c) * f + y1;
  }
}

// Limits a wet signal to the rails: a wire up to 8 V, then a soft shoulder that tops out at 11.5 V.
export function fxRail(x) {
  if (x > 8) return 8 + 3.5 * tanh((x - 8) / 3.5);
  if (x < -8) return -8 + 3.5 * tanh((x + 8) / 3.5);
  return x;
}

// A DJ knob as a gain: −1 kills, 0 is unity, +1 is +6 dB.
export const fxKillGain = (v) => (v >= 0 ? 10 ** ((6 * v) / 20) : (1 + v) * (1 + v));

// Equal-power dry/wet: wet that is uncorrelated with dry leaves the level where it was. Call
// set(mix) every tick, it only does the work when the knob moved.
export class FxMix {
  constructor() { this.k = -1; this.dry = 1; this.wet = 0; }
  set(m) {
    if (m === this.k) return;
    this.k = m;
    this.dry = Math.cos(m * Math.PI * 0.5);
    this.wet = Math.sin(m * Math.PI * 0.5);
  }
}

// Two-output sine LFO (magic circle): no Math.sin in tick, and the amplitude can't drift.
export class FxRot {
  constructor(hz, sr) { this.s = 0; this.c = 1; this.sr = sr; this.setHz(hz); }
  setHz(hz) { this.k = 2 * Math.sin((Math.PI * hz) / this.sr); }
  tick() { this.s += this.k * this.c; this.c -= this.k * this.s; }
}

// Measures a clock. Returns the period in samples, 0 until two edges have passed. The average
// of eight periods reads a fractional period and straightens swing (long-short pairs).
export class FxClock {
  constructor() {
    this.trig = new Trigger();
    this.hist = new Float64Array(8);
    this.n = 0; this.k = 0; this.sum = 0;
    this.since = -1;
    this.miss = 0;
    this.period = 0;
  }
  tick(v) {
    if (this.since >= 0) this.since++;
    if (this.trig.tick(v)) {
      if (this.since > 0) this.push(this.since);
      this.since = 0;
    }
    return this.period;
  }
  push(t) {
    if (this.n > 0) {
      const r = t / this.period;
      if (r < 0.3 || r > 1.7) {
        if (++this.miss < 2) return; // one odd gap is a transport restart, two are a new tempo
        this.n = 0; this.k = 0; this.sum = 0;
      }
    }
    this.miss = 0;
    if (this.n === 8) this.sum -= this.hist[this.k]; else this.n++;
    this.hist[this.k] = t;
    this.sum += t;
    this.k = (this.k + 1) & 7;
    this.period = this.sum / this.n;
  }
}

// Transposed direct form II. Fixed designs from the RBJ cookbook; the shapes share a denominator,
// which is what makes a Linkwitz-Riley sum exact after the bilinear transform.
export class FxBiquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(hz, q, sr, b0, b1, b2) {
    const w = (TAU * Math.min(hz, sr * 0.49)) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const g = b0 === null ? (1 - cw) / 2 : 1;
    if (b0 === null) { this.b0 = g / a0; this.b1 = (2 * g) / a0; this.b2 = g / a0; }
    else { this.b0 = b0(cw, al) / a0; this.b1 = b1(cw, al) / a0; this.b2 = b2(cw, al) / a0; }
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - al) / a0;
    return this;
  }
  lowpass(hz, q, sr) { return this.set(hz, q, sr, null); }
  highpass(hz, q, sr) { return this.set(hz, q, sr, (c) => (1 + c) / 2, (c) => -(1 + c), (c) => (1 + c) / 2); }
  allpass(hz, q, sr) { return this.set(hz, q, sr, (c, a) => 1 - a, (c) => -2 * c, (c, a) => 1 + a); }
  tick(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2 + DENORMAL;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Fourth-order Butterworth pole pair; squared, it is an eighth-order Linkwitz-Riley.
const FX_Q1 = 0.541196100146197, FX_Q2 = 1.306562964876377;

// Linkwitz-Riley crossover, 48 dB/oct: after tick(x), .lo + .hi is an allpass of x.
export class FxCross {
  constructor(hz, sr) {
    const lp = (q) => new FxBiquad().lowpass(hz, q, sr), hp = (q) => new FxBiquad().highpass(hz, q, sr);
    this.l0 = lp(FX_Q1); this.l1 = lp(FX_Q2); this.l2 = lp(FX_Q1); this.l3 = lp(FX_Q2);
    this.h0 = hp(FX_Q1); this.h1 = hp(FX_Q2); this.h2 = hp(FX_Q1); this.h3 = hp(FX_Q2);
    this.lo = 0; this.hi = 0;
  }
  tick(x) {
    this.lo = this.l3.tick(this.l2.tick(this.l1.tick(this.l0.tick(x))));
    this.hi = this.h3.tick(this.h2.tick(this.h1.tick(this.h0.tick(x))));
  }
}

// The allpass an FxCross at the same frequency amounts to: lets a band skip a crossover in phase.
export class FxCrossAllpass {
  constructor(hz, sr) { this.a = new FxBiquad().allpass(hz, FX_Q1, sr); this.b = new FxBiquad().allpass(hz, FX_Q2, sr); }
  tick(x) { return this.b.tick(this.a.tick(x)); }
}

// Schroeder allpass of a fixed length n (lattice form): tick(x, g).
export class FxAllpass {
  constructor(n) { this.n = Math.max(1, n); this.buf = new Float64Array(this.n); this.p = 0; }
  tick(x, g) {
    const z = this.buf[this.p], v = x - g * z;
    this.buf[this.p] = v;
    if (++this.p === this.n) this.p = 0;
    return z + g * v;
  }
}

// A chain of `m` stretched allpasses (a + z^-k) / (1 + a z^-k). Group delay climbs from
// m k (1-a)/(1+a) at DC to m k (1+a)/(1-a) at sr/2k: low notes arrive first, which is a chirp.
export class FxChirp {
  constructor(m, k) { this.m = m; this.k = k; this.a = 0.6; this.z = new Float64Array(m * k); this.p = 0; }
  tick(x) {
    const z = this.z, a = this.a, k = this.k, m = this.m;
    for (let s = 0, j = this.p; s < m; s++, j += k) {
      const q = z[j], v = x - a * q;
      x = a * v + q;
      z[j] = v;
    }
    if (++this.p === k) this.p = 0;
    return x;
  }
}
