// The small toolbox every module's DSP class is written with. These names are in scope
// inside a Code module too, which is what makes forking a module's source work.
export const TAU = Math.PI * 2;
export const HITS = 63;   // ui slot where a drum voice counts its hits, for whoever is watching
export const C4 = 261.6255653005986;
export const RAIL = 12;
export const DENORMAL = 1e-20;

export const vToHz = (v) => C4 * 2 ** v;
export const hzToV = (hz) => Math.log2(hz / C4);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const expmap = (t, lo, hi) => lo * (hi / lo) ** t;

// Padé approximation of tanh, good to about 3, then it holds ±1.
export function tanh(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// Soft clip: a cubic that leaves small signals alone and flattens out at ±√2, where its slope
// reaches zero, so it stays monotonic and continuous and is safe inside a feedback loop.
export function softclip(x) {
  if (x >= 2.1213203435596424) return 1.4142135623730951;
  if (x <= -2.1213203435596424) return -1.4142135623730951;
  return x - (x * x * x) / 13.5;
}

// PolyBLEP residual: subtract from a naive saw at its wrap, for phase t in 0..1 and increment dt.
export function polyblep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

// Schmitt trigger: tick(v) is true on the sample a gate goes high.
export class Trigger {
  constructor() { this.high = false; }
  tick(v) {
    if (this.high) {
      if (v <= 0.5) this.high = false;
      return false;
    }
    if (v >= 2) { this.high = true; return true; }
    return false;
  }
}

// A trigger output: fire(), then tick() gives 10 V for `ms` milliseconds.
export class Pulse {
  constructor(sr, ms = 1) { this.len = Math.max(1, Math.round((sr * ms) / 1000)); this.left = 0; }
  fire() { this.left = this.len; }
  tick() {
    if (this.left > 0) { this.left--; return 10; }
    return 0;
  }
}

// Deterministic white noise (xorshift32). next() is 0..1, bipolar() is −1..1.
export class Rng {
  constructor(seed = 22222) { this.s = (seed | 0) || 1; }
  next() {
    let s = this.s;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.s = s;
    return (s >>> 0) / 4294967296;
  }
  bipolar() { return this.next() * 2 - 1; }
}

export class DCBlock {
  constructor(sr, hz = 12) { this.r = 1 - (TAU * hz) / sr; this.x = 0; this.y = 0; }
  tick(x) {
    const y = x - this.x + this.r * this.y + DENORMAL;
    this.x = x;
    this.y = y;
    return y;
  }
}

// One-pole lowpass. Call setHz when the cutoff changes, or set .a directly.
export class OnePole {
  constructor(sr, hz = 1000) { this.sr = sr; this.z = 0; this.setHz(hz); }
  setHz(hz) { this.a = 1 - Math.exp((-TAU * Math.min(hz, this.sr * 0.49)) / this.sr); }
  tick(x) {
    this.z += this.a * (x - this.z) + DENORMAL;
    return this.z;
  }
}

// Power-of-two ring buffer with linear-interpolated reads.
export class DelayLine {
  constructor(samples) {
    let n = 2;
    while (n < samples + 2) n *= 2;
    this.buf = new Float64Array(n);
    this.mask = n - 1;
    this.w = 0;
  }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  // `d` samples ago, ≥ 1; read before write for a delay of exactly d
  read(d) {
    const pos = this.w - d;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask], b = this.buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }
}

// A block of audio on its way to a plugin and back, laid out as tools/vst/host.py reads it: a head,
// the samples of both channels, then room for the MIDI of that block.
export const PLUGIN_BLOCK = 256, PLUGIN_HEAD = 12, PLUGIN_NOTES = 32;
export const PLUGIN_FRAME = PLUGIN_HEAD + PLUGIN_BLOCK * 8 + PLUGIN_NOTES * 5;

// Base class of every DSP class. The engine fills in `linked`, `ui`, `wave` and `rack`.
export class Module {
  constructor(sr) {
    this.sr = sr;
    this.dt = 1 / sr;
    this.linked = null;
    this.ui = null;
    this.wave = null;
    this.rack = null;
  }
  tick() {}
  onData() {}
  onMessage() {}
}

// ── how values read on the panel ─────────────────────────
const num = (v) => { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); };
export const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 1e4 ? 1 : 2)} kHz` : `${num(hz)} Hz`);
export const fmtVHz = (v) => fmtHz(vToHz(v));
export const fmtMs = (s) => (s >= 1 ? `${s.toFixed(2)} s` : s >= 0.01 ? `${(s * 1000).toFixed(0)} ms` : `${(s * 1000).toFixed(1)} ms`);
// fmtExp(0.001, 2) reads a 0..1 knob that goes through expmap(p, 0.001, 2) as a time
export const fmtExp = (lo, hi) => (t) => fmtMs(expmap(t, lo, hi));
export const fmtExpHz = (lo, hi) => (t) => fmtHz(expmap(t, lo, hi));
export const fmtDb = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
export const fmtPct = (v) => `${Math.round(v * 100)} %`;
export const fmtSt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(v === Math.round(v) ? 0 : 2)} st`;
export const fmtRatio = (v) => `${v.toFixed(1)}:1`;
