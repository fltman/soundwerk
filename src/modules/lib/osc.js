// Helpers for osc modules: band-limited edges, a 2:1 decimator and the wavetable banks.
// Everything expensive here happens once, when this file loads, never in tick.

// Plain radix-2 FFT, forward. Swap the arguments for an unscaled inverse.
function fftTable(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// ── minBLEP ──────────────────────────────────────────────
// A minimum-phase band-limited step (Brandt & Stilson 2001): a Blackman-windowed sinc, made
// minimum phase through the real cepstrum, integrated. No lookahead, so no latency worth the
// name, and the cost only falls on samples with an edge. Flat to 15 kHz, -2.9 dB at 20 kHz, more
// than 40 dB down past 28 kHz (at 48 kHz). `BLEP_DELAY` is the kernel's group delay in samples.
const BLEP_STEPS = 64; // table entries per sample
export const BLEP_LEN = 16; // samples; a power of two, so the ring below can mask

function buildBlep() {
  const total = BLEP_LEN * BLEP_STEPS, n = BLEP_LEN * BLEP_STEPS;
  const N = 1 << 15, re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= n; k++) {
    const t = (k - n / 2) / BLEP_STEPS, x = 0.9 * t;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / n) + 0.08 * Math.cos((4 * Math.PI * k) / n);
    re[k] = sinc * w;
  }
  // log magnitude → cepstrum → fold onto positive quefrency → exp
  fftTable(re, im);
  for (let k = 0; k < N; k++) { re[k] = Math.log(Math.max(Math.hypot(re[k], im[k]), 1e-7)); im[k] = 0; }
  fftTable(im, re);
  for (let k = 0; k < N; k++) {
    const fold = k === 0 || k === N / 2 ? 1 : k < N / 2 ? 2 : 0;
    re[k] *= (fold / N); im[k] = 0;
  }
  fftTable(re, im);
  for (let k = 0; k < N; k++) {
    const m = Math.exp(re[k]);
    re[k] = m * Math.cos(im[k]);
    im[k] = m * Math.sin(im[k]);
  }
  fftTable(im, re);
  const fadeFrom = total - total / 4;
  const y = new Float64Array(total);
  let sum = 0;
  for (let k = 0; k < total; k++) {
    const fade = k < fadeFrom ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (k - fadeFrom)) / (total - fadeFrom));
    y[k] = (re[k] / N) * fade;
    sum += y[k];
  }
  // residuals: what to add to a naive jump of 1, and to a naive kink of slope 1 delayed by `delay`
  const step = new Float64Array(total + 2), ramp = new Float64Array(total + 2);
  let acc = 0;
  for (let k = 0; k < total; k++) { step[k] = acc - 1; acc += y[k] / sum; }
  let delay = 0;
  for (let k = 0; k < total; k++) delay -= step[k] / BLEP_STEPS;
  let area = 0;
  for (let k = 0; k <= total; k++) {
    ramp[k] = area - Math.max(k / BLEP_STEPS - delay, 0); // ∫BLEP - (t - delay)₊
    if (k < total) area += (step[k] + 1) / BLEP_STEPS;
  }
  ramp[total] = 0;
  ramp[total + 1] = 0;
  step[total] = 0;
  step[total + 1] = 0;
  return { step, ramp, delay };
}

const BLEP_TABLES = buildBlep();
export const BLEP_DELAY = BLEP_TABLES.delay;
const BLEP_STEP = BLEP_TABLES.step, BLEP_RAMP = BLEP_TABLES.ramp;

// One output's correction signal. Add it to the naive waveform: y = naive + blep.next().
// Several oscillators can share one, which is what makes a supersaw cheap.
export class Blep {
  constructor() { this.buf = new Float64Array(BLEP_LEN); this.i = 0; }
  // the naive signal jumped by h, t samples ago (0 ≤ t < 1). Call before next().
  step(t, h) { this.add(BLEP_STEP, t, h); }
  // the naive signal's slope changed by h per sample, t samples ago. For a kink to land cleanly
  // the naive signal must run BLEP_DELAY samples late (a jump needs no such care).
  ramp(t, h) { this.add(BLEP_RAMP, t, h); }
  add(table, t, h) {
    const x = t * BLEP_STEPS;
    const j = x | 0, f = x - j, buf = this.buf, mask = BLEP_LEN - 1;
    let p = this.i, q = j;
    for (let k = 0; k < BLEP_LEN; k++) {
      const a = table[q];
      buf[p] += h * (a + f * (table[q + 1] - a));
      q += BLEP_STEPS;
      p = (p + 1) & mask;
    }
  }
  next() {
    const i = this.i, v = this.buf[i];
    this.buf[i] = 0;
    this.i = (i + 1) & (BLEP_LEN - 1);
    return v;
  }
}

// ── 2:1 decimator ────────────────────────────────────────
// Polyphase IIR halfband (two allpass chains, Valenzuela & Constantinides; coefficients from de
// Soras' HIIR formulas): 6 multiplies per output sample, -80 dB from 0.55 of the output rate up,
// flat to 0.45. Takes the older sample first.
export class OscDown2 {
  constructor() { this.a = new Float64Array(4); this.b = new Float64Array(4); }
  down(older, newer) {
    const s = this.a, r = this.b;
    let x = newer, y = (x - s[1]) * 0.060297391 + s[0]; s[0] = x; x = y;
    y = (x - s[2]) * 0.4125907204 + s[1]; s[1] = x; x = y;
    y = (x - s[3]) * 0.7727156537 + s[2]; s[2] = x; s[3] = y;
    const p = y;
    x = older; y = (x - r[1]) * 0.2159714446 + r[0]; r[0] = x; x = y;
    y = (x - r[2]) * 0.6043586265 + r[1]; r[1] = x; x = y;
    y = (x - r[3]) * 0.9238861387 + r[2]; r[2] = x; r[3] = y;
    return 0.5 * (p + y);
  }
}

// ── Wavetables ───────────────────────────────────────────
// Banks of WT_FRAMES single cycles, each stored as a mip per octave: mip m holds the first
// WT_TOP >> m harmonics and nothing above, so a note picks the mips that fit under Nyquist.
// Tables shrink with the mip; the whole thing is about 700 kB of Float32.
export const WT_FRAMES = 8;
export const WT_TOP = 512; // harmonics in mip 0
export const WT_MIPS = 10;
const WT_SOURCE = 4096; // one cycle, drawn at this resolution, to take the spectrum of

const wtGauss = (k, at, width) => Math.exp(-(((k - at) / width) ** 2));
const wtPulse = (x, w) => (Math.abs(x - 0.25) < w / 2 ? 1 : -1); // centred where the square's top is

// Each frame is one cycle as a function of x in 0..1, or a harmonic's level as { spec }.
const WT_BANKS = [
  { // the analog shapes, opening up
    frames: [
      (x) => Math.sin(2 * Math.PI * x),
      (x) => 1 - 4 * Math.abs(x - 0.25),
      (x) => 0.5 * (1 - 4 * Math.abs(x - 0.25)) + 0.5 * (1 - 2 * ((x + 0.5) % 1)),
      (x) => 1 - 2 * ((x + 0.5) % 1),
      (x) => wtPulse(x, 0.5),
      (x) => wtPulse(x, 0.25),
      (x) => wtPulse(x, 0.12),
      (x) => wtPulse(x, 0.05),
    ],
  },
  { // vowels: harmonic formants that hold still as the note moves, A E I O U and back
    frames: [[7, 11, 24], [4, 18, 27], [3, 24, 32], [5, 9, 25], [3, 8, 22], [5, 9, 25], [6, 14, 26], [9, 15, 28]].map(
      ([a, b, c]) => ({ spec: (k) => (1 / k ** 0.5) * (0.05 + wtGauss(k, a, 1.6) + 0.6 * wtGauss(k, b, 2.2) + 0.3 * wtGauss(k, c, 3.5)) }),
    ),
  },
  { // a sine into a wavefolder, gain rising
    frames: [1, 1.8, 2.8, 4, 5.5, 7.5, 10, 14].map((g) => (x) => {
      const s = Math.sin(2 * Math.PI * x);
      return Math.sin(g * (s + 0.15 * s * s));
    }),
  },
  { // a hard-synced saw, the slave climbing under a fading window
    frames: [1, 1.5, 2, 2.75, 3.5, 4.5, 6, 8].map((r) => (x) => {
      const y = (x + 0.5) % 1;
      return (1 - 2 * ((y * r) % 1)) * (r === 1 ? 1 : Math.cos(Math.PI * (y - 0.5)) ** 0.5);
    }),
  },
];

function buildWavetables() {
  const len = new Int32Array(WT_MIPS), off = new Int32Array(WT_MIPS);
  let stride = 0;
  for (let m = 0; m < WT_MIPS; m++) {
    len[m] = Math.max(256, 4 * (WT_TOP >> m));
    off[m] = stride + 1;
    stride += len[m] + 3; // guard samples for the interpolator: one before, two after
  }
  const data = new Float32Array(WT_BANKS.length * WT_FRAMES * stride);
  const re = new Float64Array(WT_SOURCE), im = new Float64Array(WT_SOURCE);
  const hr = new Float64Array(WT_TOP + 1), hi = new Float64Array(WT_TOP + 1);
  const ifr = new Array(WT_MIPS), ifi = new Array(WT_MIPS);
  for (let m = 0; m < WT_MIPS; m++) { ifr[m] = new Float64Array(len[m]); ifi[m] = new Float64Array(len[m]); }
  let at = 0;
  for (const bank of WT_BANKS) {
    for (const frame of bank.frames) {
      hr.fill(0); hi.fill(0);
      if (frame.spec) {
        for (let k = 1; k <= WT_TOP; k++) hi[k] = -frame.spec(k); // sine phase
      } else {
        for (let n = 0; n < WT_SOURCE; n++) { re[n] = frame(n / WT_SOURCE); im[n] = 0; }
        fftTable(re, im);
        for (let k = 1; k <= WT_TOP; k++) { hr[k] = (re[k] * 2) / WT_SOURCE; hi[k] = (im[k] * 2) / WT_SOURCE; }
      }
      let scale = 0;
      for (let m = 0; m < WT_MIPS; m++) {
        const L = len[m], top = WT_TOP >> m, r = ifr[m], q = ifi[m];
        r.fill(0); q.fill(0);
        for (let k = 1; k <= top; k++) {
          r[k] = hr[k] * 0.5; q[k] = hi[k] * 0.5;
          r[L - k] = hr[k] * 0.5; q[L - k] = -hi[k] * 0.5;
        }
        fftTable(q, r); // inverse
        if (m === 0) for (let n = 0; n < L; n++) scale = Math.max(scale, Math.abs(r[n]));
        const o = at + off[m];
        for (let n = 0; n < L; n++) data[o + n] = r[n] / scale;
        data[o - 1] = data[o + L - 1];
        data[o + L] = data[o];
        data[o + L + 1] = data[o + 1];
      }
      at += stride;
    }
  }
  return { data, len, off, stride };
}

const WT = buildWavetables();
export const WT_BANK_COUNT = WT_BANKS.length;

// A cycle from a bank: frame and mip are table indices, ph is 0..1. Catmull-Rom between samples:
// a straight line leaves images of strong harmonics that fold back to about -50 dB.
export function wtRead(bank, frame, mip, ph) {
  const x = ph * WT.len[mip], j = x | 0, f = x - j;
  const o = (bank * WT_FRAMES + frame) * WT.stride + WT.off[mip] + j, d = WT.data;
  const a = d[o - 1], b = d[o], c = d[o + 1], e = d[o + 2];
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - e + f * (3 * (b - c) + e - a)));
}
