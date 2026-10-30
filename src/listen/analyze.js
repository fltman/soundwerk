// What a render sounds like, in numbers: loudness to ITU BS.1770, tonal balance, stereo, tempo.
// `test/listen.test.mjs` calibrates each of these against signals with a known answer.
import { analyze as analyzeTrack } from '../analysis/analysis.js';
import { fft, hann } from '../wall/fft.js';

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

// K-weighting: the two biquads of BS.1770, specified at 48 kHz, re-derived for other rates
function kWeight(x, sr) {
  const biquad = (b0, b1, b2, a1, a2) => {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (src) => {
      for (let i = 0; i < src.length; i++) {
        const v = src[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = o;
        y[i] = o;
      }
      return y;
    };
  };
  // pre-filter: high shelf at 1681.97 Hz, +3.9998 dB, Q 0.7072
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = biquad((Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  // RLB: high-pass at 38.13 Hz, Q 0.5003
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
  K = Math.tan((Math.PI * f1) / sr);
  a0 = 1 + K / Q1 + K * K;
  const rlb = biquad(1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0);
  return rlb(shelf(x).slice());
}

// Integrated loudness with the −70 and −10 gates; 400 ms blocks with 75 % overlap
export function lufs(L, R, sr) {
  const kl = kWeight(L, sr), kr = kWeight(R, sr);
  const size = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  const blocks = [];
  for (let a = 0; a + size <= kl.length; a += hop) {
    let e = 0;
    for (let i = a; i < a + size; i++) e += kl[i] * kl[i] + kr[i] * kr[i];
    blocks.push(e / size);
  }
  if (!blocks.length) return -Infinity;
  const loud = (bs) => -0.691 + 10 * Math.log10(bs.reduce((s, b) => s + b, 0) / bs.length);
  const abs = blocks.filter((b) => -0.691 + 10 * Math.log10(b) > -70);
  if (!abs.length) return -Infinity;
  const relative = loud(abs) - 10;
  const kept = abs.filter((b) => -0.691 + 10 * Math.log10(b) > relative);
  return loud(kept.length ? kept : abs);
}

export const BANDS = [['sub', 20, 60], ['bass', 60, 250], ['lowmid', 250, 800], ['mid', 800, 2500], ['high', 2500, 8000], ['air', 8000, 20000]];

// Share of the power per band, in dB relative to the total, averaged over short frames
export function tonalBalance(x, sr) {
  const size = 8192, win = hann(size), re = new Float64Array(size), im = new Float64Array(size);
  const power = new Float64Array(BANDS.length);
  for (let a = 0; a + size <= x.length; a += size) {
    for (let i = 0; i < size; i++) { re[i] = x[a + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < size / 2; k++) {
      const hz = (k * sr) / size, e = re[k] * re[k] + im[k] * im[k];
      for (let b = 0; b < BANDS.length; b++) if (hz >= BANDS[b][1] && hz < BANDS[b][2]) power[b] += e;
    }
  }
  const total = power.reduce((s, p) => s + p, 0) || 1;
  return Object.fromEntries(BANDS.map(([name], b) => [name, +(10 * Math.log10(power[b] / total + 1e-12)).toFixed(1)]));
}

export function analyzeRender({ L, R, sampleRate: sr }) {
  const n = L.length;
  let peak = 0, sumL = 0, sumR = 0, cross = 0, dc = 0;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sumL += l * l; sumR += r * r; cross += l * r; dc += l + r;
    mono[i] = (l + r) / 2;
  }
  const rms = Math.sqrt((sumL + sumR) / (2 * n));
  const out = {
    peakDb: +db(peak).toFixed(1),
    rmsDb: +db(rms).toFixed(1),
    crestDb: +(db(peak) - db(rms)).toFixed(1),
    lufs: +lufs(L, R, sr).toFixed(1),
    dc: +(dc / (2 * n)).toFixed(5),
    stereoCorrelation: +(cross / Math.max(Math.sqrt(sumL * sumR), 1e-12)).toFixed(2),
    balance: tonalBalance(mono, sr),
  };
  if (n / sr >= 4 && rms > 1e-4) {
    const t = analyzeTrack(mono, sr);
    out.bpm = +t.bpm.toFixed(1);
    out.kicks = t.onsets.kick.times.length;
    out.snares = t.onsets.snare.times.length;
    out.hats = t.onsets.hat.times.length;
  }
  return out;
}

// A log-frequency spectrogram as RGBA pixels, for looking at a render.
export function spectrogramRGBA(x, sr, W = 900, H = 320) {
  const size = 4096, win = hann(size), re = new Float64Array(size), im = new Float64Array(size);
  const px = new Uint8ClampedArray(W * H * 4);
  const hop = Math.max(1, (x.length - size) / W);
  for (let c = 0; c < W; c++) {
    const a = Math.floor(c * hop);
    for (let i = 0; i < size; i++) { re[i] = (x[a + i] ?? 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const lo = 25 * 800 ** (1 - (y + 1) / H), hi = 25 * 800 ** (1 - y / H);
      const k0 = Math.max(1, Math.floor((lo / sr) * size)), k1 = Math.max(k0 + 1, Math.ceil((hi / sr) * size));
      let e = 0;
      for (let k = k0; k < k1 && k < size / 2; k++) e = Math.max(e, re[k] * re[k] + im[k] * im[k]);
      const v = 10 * Math.log10(e / ((size / 4) * (size / 4)) + 1e-12);
      const t = Math.max(0, Math.min(1, (v + 80) / 74));
      const i = (y * W + c) * 4;
      px[i] = 255 * Math.min(1, t * 1.7);
      px[i + 1] = 255 * Math.max(0, t * 1.6 - 0.55);
      px[i + 2] = 255 * (t * t * t * 0.7 + 0.28 * Math.sin(t * 3.14));
      px[i + 3] = 255;
    }
  }
  return { px, W, H };
}
