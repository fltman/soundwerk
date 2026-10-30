// Helpers for drum modules. Every name starts with drum/Drum: they share lib's namespace.
import { DENORMAL, clamp, polyblep } from './core.js';

// per-sample multiplier of an exponential that falls 60 dB in `t60` seconds
export const drumK = (t60, sr) => Math.exp(-6.907755278982137 / (t60 * sr));

// the accent jack as a gain: 0 V = normal, 10 V = +6 dB
export const drumAccent = (v) => 1 + clamp(v, 0, 10) * 0.1;

// TPT state-variable filter. tick(x), then read .lp, .bp (unity at the centre) or .hp.
export class DrumSVF {
  constructor(sr, hz = 1000, q = 0.707) {
    this.sr = sr;
    this.z1 = 0; this.z2 = 0;
    this.lp = 0; this.bp = 0; this.hp = 0;
    this.set(hz, q);
  }
  set(hz, q) {
    const g = Math.tan((Math.PI * Math.min(hz, this.sr * 0.45)) / this.sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(x) {
    const v3 = x - this.z2;
    const v1 = this.a1 * this.z1 + this.a2 * v3;
    const v2 = this.z2 + this.a2 * this.z1 + this.a3 * v3;
    this.z1 = 2 * v1 - this.z1 + DENORMAL;
    this.z2 = 2 * v2 - this.z2 + DENORMAL;
    this.lp = v2;
    this.bp = this.k * v1;
    this.hp = x - this.k * v1 - v2;
  }
}

// A retrigger cuts the old tail off wherever it was. The cut stays out of the signal: the last
// output becomes an offset that leaves flat and dies in a few ms, so the new hit starts where the
// old one was and the offset adds nothing to the attack's own first steps.
export class DrumDeclick {
  constructor(sr, ms = 1.2) {
    this.k = Math.exp(-1000 / (ms * sr));
    this.a = 0;
    this.z = 0;
    this.last = 0;
  }
  arm() { this.a = this.last; this.z = this.last; }
  tick(x) {
    if (this.a === 0) { this.last = x; return x; }
    this.z = this.k * this.z + (1 - this.k) * this.a;
    this.a *= this.k;
    if (Math.abs(this.a) < 1e-9) { this.a = 0; this.z = 0; }
    this.last = x + this.z;
    return this.last;
  }
  clear() { this.a = 0; this.z = 0; this.last = 0; }
}

// A bank of free-running band-limited squares: the metal in hats, cymbals and cowbells.
export class DrumMetal {
  constructor(sr, hz) {
    this.sr = sr;
    this.hz = hz;
    this.n = hz.length;
    this.ph = new Float64Array(this.n);
    this.inc = new Float64Array(this.n);
    for (let k = 0; k < this.n; k++) this.ph[k] = (k * 0.381966) % 1; // never all in step
    this.retune(1);
  }
  retune(ratio) {
    for (let k = 0; k < this.n; k++) this.inc[k] = Math.min((this.hz[k] * ratio) / this.sr, 0.45);
  }
  // advance only, while nothing is listening
  idle() {
    for (let k = 0; k < this.n; k++) {
      const t = this.ph[k] + this.inc[k];
      this.ph[k] = t >= 1 ? t - 1 : t;
    }
  }
  // back up n samples, so a filter that slept can be run up to speed on what it would have heard
  rewind(n) {
    for (let k = 0; k < this.n; k++) {
      const t = this.ph[k] - n * this.inc[k];
      this.ph[k] = t - Math.floor(t);
    }
  }
  // the mean of the squares, −1..1
  tick() {
    let sum = 0;
    for (let k = 0; k < this.n; k++) {
      const dt = this.inc[k];
      let t = this.ph[k] + dt;
      if (t >= 1) t -= 1;
      this.ph[k] = t;
      let t2 = t + 0.5;
      if (t2 >= 1) t2 -= 1;
      sum += (t < 0.5 ? 1 : -1) + polyblep(t, dt) - polyblep(t2, dt);
    }
    return sum / this.n;
  }
}
