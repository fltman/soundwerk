// Rendering one module on its own and measuring what comes out.
import { getDef, inputPorts, outputPorts, paramRange } from '../../src/modules/index.js';

// Render `type` for `seconds`. `params` by name, `depth` by name, `data` for onData.
// `inputs` by port name: a number, or a function of (t, n) giving the volts at time t, sample n.
// CV jacks work: name a cv param in `inputs` and the module sees knob + cable × depth × range.
export function renderModule(type, { params = {}, depth = {}, data, inputs = {}, seconds = 1, sr = 48000, running = true, def = getDef(type), onSample, setup } = {}) {
  const ports = inputPorts(def), outs = outputPorts(def), ps = def.params ?? [];
  const m = new def.dsp(sr);
  const I = new Float64Array(ports.length), O = new Float64Array(Math.max(1, outs.length)), P = new Float64Array(ps.length);
  m.linked = new Uint8Array(ports.length);
  m.ui = new Float32Array(128);
  m.wave = new Float32Array(16384);
  m.rack = { running, inL: 0, inR: 0 };
  ps.forEach((p, k) => { P[k] = params[p.name] ?? paramRange(p).def; });
  const feeds = ports.map((port, k) => {
    const f = inputs[port.name];
    if (f === undefined) return null;
    m.linked[k] = 1;
    return typeof f === 'function' ? f : () => f;
  });
  if (data !== undefined) m.onData(data);
  setup?.(m);
  const mods = [];
  ports.forEach((port, k) => {
    if (!port.param || !feeds[k]) return;
    const q = ps.findIndex((p) => p.name === port.name);
    const r = paramRange(ps[q]);
    mods.push({ k, q, base: P[q], scale: ((depth[port.name] ?? 0.5) * (r.span ?? r.max - r.min)) / 10, step: r.step, min: r.lo ?? r.min, max: r.hi ?? r.max });
  });
  const N = Math.round(seconds * sr);
  const out = Object.fromEntries(outs.map((o) => [o.name, new Float64Array(N)]));
  for (let n = 0; n < N; n++) {
    const t = n / sr;
    m.rack.inL = m.rack.inR = 0.2 * Math.sin(2 * Math.PI * 220 * t);
    for (let k = 0; k < feeds.length; k++) if (feeds[k]) I[k] = feeds[k](t, n);
    for (const c of mods) {
      let v = c.base + I[c.k] * c.scale;
      if (c.step) v = Math.round(v / c.step) * c.step;
      P[c.q] = Math.min(c.max, Math.max(c.min, v));
    }
    m.tick(I, O, P);
    for (let k = 0; k < outs.length; k++) out[outs[k].name][n] = O[k];
    onSample?.(n, O, m);
  }
  return { ...out, out, sr, ui: m.ui, wave: m.wave, instance: m };
}

export const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
export const peak = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s = Math.max(s, Math.abs(x[i])); return s; };
export const mean = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i]; return s / (b - a); };
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

// In-place radix-2 FFT
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k), s = Math.sin(ang * k);
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// Hann-windowed magnitude spectrum of x[start..start+size]; mag[k] is an amplitude: a sine of
// amplitude A at bin k reads A. `hz` gives each bin's frequency.
export function spectrum(x, sr, size = 65536, start = Math.max(0, Math.floor((x.length - size) / 2))) {
  while (size > x.length) size /= 2;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = (Math.hypot(re[i], im[i]) * 4) / size;
  return { mag, binHz: sr / size, hz: (k) => (k * sr) / size };
}

// The strongest frequency, refined by parabolic interpolation of the log spectrum.
export function peakHz(x, sr, lo = 10, hi = sr / 2, size = 65536) {
  const s = spectrum(x, sr, size);
  const a = Math.max(1, Math.ceil(lo / s.binHz)), b = Math.min(s.mag.length - 2, Math.floor(hi / s.binHz));
  let best = a;
  for (let k = a; k <= b; k++) if (s.mag[k] > s.mag[best]) best = k;
  const l = Math.log(s.mag[best - 1] + 1e-30), c = Math.log(s.mag[best] + 1e-30), r = Math.log(s.mag[best + 1] + 1e-30);
  const frac = (0.5 * (l - r)) / (l - 2 * c + r);
  return (best + frac) * s.binHz;
}

// Pitch from rising zero crossings, interpolated. Far better than an FFT at low notes.
export function pitchHz(x, sr, from = Math.floor(x.length / 4)) {
  let first = null, last = null, count = 0;
  for (let i = from + 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first === null) first = t; else count++;
      last = t;
    }
  }
  return count ? (count * sr) / (last - first) : 0;
}

// RMS amplitude of the bins between lo and hi Hz
export function bandLevel(x, sr, lo, hi, size = 65536) {
  const s = spectrum(x, sr, size);
  let e = 0;
  for (let k = Math.max(1, Math.ceil(lo / s.binHz)); k < s.mag.length && k * s.binHz <= hi; k++) e += s.mag[k] * s.mag[k];
  return Math.sqrt(e / 1.5); // 1.5 = the Hann window's power spread over bins
}

// Frequency response of a linear(ish) system: feed one sine, read back its amplitude.
export function gainAt(type, hz, { input = 'in', output, level = 1, sr = 48000, params, seconds = 0.5 } = {}) {
  const r = renderModule(type, { params, seconds, sr, inputs: { [input]: (t) => level * Math.sin(2 * Math.PI * hz * t) } });
  const y = output ? r.out[output] : Object.values(r.out)[0];
  return rms(y, Math.floor(y.length * 0.5)) / (level / Math.SQRT2);
}

// When a signal first crosses `frac` of its peak, in seconds; handy for envelope times
export function crossing(x, sr, frac, from = 0) {
  const p = peak(x);
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]) >= p * frac) return i / sr;
  return null;
}
