// Offline analysis of a whole track: band levels, onsets (kick / snare / hat),
// tempo, a tracked beat grid, bar phase, slow energy and a log spectrum per frame.
// Pure JS — runs in a worker in the app and in Node for tests.
import { createFFT } from './fft.js';

export const FFT_SIZE = 2048;
export const HOP = 512;
export const SPEC_BINS = 128;
export const SPEC_MIN_HZ = 30;
export const SPEC_MAX_HZ = 16000;

export const BANDS = {
  bass: [20, 150],
  lowmid: [150, 500],
  mid: [500, 2000],
  high: [2000, 6000],
  treble: [6000, 16000],
};
const ONSET_BANDS = {
  kick: [30, 150],
  snare: [1500, 5000],
  hat: [7000, 16000],
  all: [30, 8000],
};
// Drum onsets use linear magnitude flux so a loud kick beats a quiet bass note;
// the broadband novelty for tempo uses log flux so every instrument counts.
// The kick uses the rise of the band's total energy: a bass line sliding or
// changing note moves energy between bins without adding much, a kick adds a lot.
const LINEAR_FLUX = new Set(['kick', 'snare', 'hat']);
// minimum strength relative to the loudest hits of the whole track
const GLOBAL_FLOOR = { kick: 0.3, snare: 0, hat: 0 };
const MIN_GAP = { kick: 0.12, snare: 0.1, hat: 0.06 };

export function analyze(samples, sampleRate, onProgress = () => {}) {
  const n = Math.max(2, Math.floor(samples.length / HOP) + 1);
  const fr = sampleRate / HOP;
  const half = FFT_SIZE / 2;
  const binHz = sampleRate / FFT_SIZE;
  const fft = createFFT(FFT_SIZE);
  const win = new Float64Array(FFT_SIZE);
  let winSum = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    winSum += win[i];
  }
  const ampScale = 2 / winSum; // full-scale sine → magnitude 1
  const binRange = ([lo, hi]) => [Math.max(1, Math.round(lo / binHz)), Math.min(half - 1, Math.round(hi / binHz))];

  const bandNames = Object.keys(BANDS);
  const bandBins = bandNames.map((k) => binRange(BANDS[k]));
  const bandRaw = bandNames.map(() => new Float32Array(n));
  const onsetNames = Object.keys(ONSET_BANDS);
  const onsetBins = onsetNames.map((k) => binRange(ONSET_BANDS[k]));
  const fluxRaw = onsetNames.map(() => new Float32Array(n));
  const levelRaw = new Float32Array(n);

  // log-spaced spectrum bin edges, in (fractional) FFT bins
  const edges = new Float64Array(SPEC_BINS + 1);
  for (let b = 0; b <= SPEC_BINS; b++) {
    edges[b] = (SPEC_MIN_HZ * Math.pow(SPEC_MAX_HZ / SPEC_MIN_HZ, b / SPEC_BINS)) / binHz;
  }
  const specDb = new Float32Array(n * SPEC_BINS);

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let mag = new Float64Array(half);
  let magPrev = new Float64Array(half);
  let logPrev = new Float64Array(half);
  let logCur = new Float64Array(half);
  const levelLo = half - HOP / 2, levelHi = half + HOP / 2;

  for (let f = 0; f < n; f++) {
    const start = f * HOP - half;
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = start + i;
      const s = j >= 0 && j < samples.length ? samples[j] : 0;
      if (i >= levelLo && i < levelHi) sumSq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    levelRaw[f] = Math.sqrt(sumSq / HOP);
    fft(re, im);
    for (let k = 0; k < half; k++) {
      const m = Math.hypot(re[k], im[k]) * ampScale;
      mag[k] = m;
      logCur[k] = Math.log1p(100 * m);
    }
    for (let b = 0; b < bandNames.length; b++) {
      const [lo, hi] = bandBins[b];
      let p = 0;
      for (let k = lo; k <= hi; k++) p += mag[k] * mag[k];
      bandRaw[b][f] = Math.sqrt(p / (hi - lo + 1));
    }
    for (let o = 0; o < onsetNames.length; o++) {
      const [lo, hi] = onsetBins[o];
      if (onsetNames[o] === 'kick') {
        let e = 0, ep = 0;
        for (let k = lo; k <= hi; k++) { e += mag[k] * mag[k]; ep += magPrev[k] * magPrev[k]; }
        fluxRaw[o][f] = f === 0 ? 0 : Math.max(0, Math.sqrt(e) - Math.sqrt(ep));
        continue;
      }
      const linear = LINEAR_FLUX.has(onsetNames[o]);
      let s = 0;
      for (let k = lo; k <= hi; k++) {
        const d = linear ? mag[k] - magPrev[k] : logCur[k] - logPrev[k];
        if (d > 0) s += d;
      }
      fluxRaw[o][f] = f === 0 ? 0 : s / (hi - lo + 1);
    }
    for (let b = 0; b < SPEC_BINS; b++) {
      const lo = edges[b], hi = edges[b + 1];
      let m;
      if (hi - lo < 1) {
        const c = (lo + hi) / 2, i0 = Math.floor(c), t = c - i0;
        m = (mag[i0] ?? 0) * (1 - t) + (mag[i0 + 1] ?? 0) * t;
      } else {
        m = 0;
        for (let k = Math.floor(lo); k < Math.ceil(hi) && k < half; k++) m = Math.max(m, mag[k]);
      }
      specDb[f * SPEC_BINS + b] = 20 * Math.log10(m + 1e-9);
    }
    let tmp = logPrev; logPrev = logCur; logCur = tmp;
    tmp = magPrev; magPrev = mag; mag = tmp;
    if (f % 1000 === 0) onProgress(f / n);
  }

  // ── normalise ────────────────────────────────────────────
  const bands = {};
  bandNames.forEach((k, b) => { bands[k] = normalizeTo(bandRaw[b], 0.97); });
  const level = normalizeTo(levelRaw, 0.97);

  const top = percentile(specDb, 0.995);
  const spectrum = new Uint8Array(n * SPEC_BINS);
  for (let i = 0; i < specDb.length; i++) {
    spectrum[i] = Math.round(255 * clamp01((specDb[i] - (top - 60)) / 60));
  }

  const flux = {};
  onsetNames.forEach((k, o) => { flux[k] = normalizeTo(fluxRaw[o], 0.98, false); });
  const onsets = {};
  for (const k of ['kick', 'snare', 'hat']) onsets[k] = pickOnsets(flux[k], fr, MIN_GAP[k], GLOBAL_FLOOR[k]);

  // ── tempo + beat grid ────────────────────────────────────
  const env = new Float32Array(n);
  for (let t = 0; t < n; t++) env[t] = flux.kick[t] + 0.5 * flux.all[t];
  const novelty = subtractLocalMean(env, Math.round(fr * 0.5));
  const period = estimatePeriod(novelty, fr);
  const beatFrames = trackBeats(novelty, period);
  const beats = Float64Array.from(beatFrames, (b) => b / fr);
  const bpm = beats.length > 8 ? fitBpm(beats) : (60 * fr) / period;
  const downbeat = findDownbeat(beatFrames, flux, [level, ...Object.values(bands)]);

  // slow energy: ~2 s moving average of loudness, spread over 5th–95th percentile
  const slow = movingAverage(levelRaw, Math.round(fr));
  const lo = percentile(slow, 0.05), hi = percentile(slow, 0.95);
  const energy = slow.map((v) => clamp01((v - lo) / Math.max(1e-9, hi - lo)));

  onProgress(1);
  return {
    version: 1,
    sampleRate,
    hop: HOP,
    frameRate: fr,
    frames: n,
    duration: samples.length / sampleRate,
    level,
    bands,
    energy,
    spectrum,
    specBins: SPEC_BINS,
    onsets,
    bpm,
    beats,
    downbeat,
  };
}

// ── helpers ──────────────────────────────────────────────────
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

export function percentile(arr, q) {
  const stride = Math.max(1, Math.floor(arr.length / 50000));
  const sample = [];
  for (let i = 0; i < arr.length; i += stride) if (Number.isFinite(arr[i])) sample.push(arr[i]);
  if (!sample.length) return 0;
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(q * sample.length))];
}

function normalizeTo(arr, q, clamp = true) {
  const p = percentile(arr, q) || Math.max(...arr) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = clamp ? clamp01(arr[i] / p) : arr[i] / p;
  return out;
}

function movingAverage(arr, radius) {
  const n = arr.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius), b = Math.min(n, i + radius + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

function subtractLocalMean(arr, radius) {
  const mean = movingAverage(arr, radius);
  return arr.map((v, i) => Math.max(0, v - mean[i]));
}

function movingMax(arr, radius) {
  const n = arr.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) if (arr[j] > m) m = arr[j];
    out[i] = m;
  }
  return out;
}

// Peak picking: above the local mean, a local maximum, and at least half the
// loudest hit in the surrounding ±1.5 s (quiet sections get their own scale).
function pickOnsets(x, fr, minGap, globalFloor = 0) {
  const mean = movingAverage(x, Math.round(0.1 * fr));
  const loud = movingMax(x, Math.round(1.5 * fr));
  const times = [], strengths = [];
  let last = -Infinity;
  for (let t = 2; t < x.length - 2; t++) {
    const v = x[t];
    if (v <= mean[t] * 1.4 + 0.05 || v < 0.5 * loud[t] || v < globalFloor) continue;
    if (v < x[t - 1] || v < x[t + 1] || v < x[t - 2] || v < x[t + 2]) continue;
    if ((t - last) / fr < minGap) {
      // two peaks too close together: keep the stronger one
      if (v > strengths[strengths.length - 1]) {
        times[times.length - 1] = t / fr;
        strengths[strengths.length - 1] = Math.min(1, v);
        last = t;
      }
      continue;
    }
    times.push(t / fr);
    strengths.push(Math.min(1, v));
    last = t;
  }
  return { times: Float64Array.from(times), strengths: Float32Array.from(strengths) };
}

// Autocorrelation of the onset novelty with a log-Gaussian tempo prior around 125 BPM.
function estimatePeriod(env, fr) {
  const minLag = Math.floor((fr * 60) / 200);
  const maxLag = Math.ceil((fr * 60) / 60);
  const n = env.length;
  const ac = new Float64Array(2 * maxLag + 2);
  for (let L = minLag; L < ac.length && L < n; L++) {
    let s = 0;
    for (let t = 0; t + L < n; t++) s += env[t] * env[t + L];
    ac[L] = s / (n - L);
  }
  let best = minLag, bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * fr) / L;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2));
    const score = w * (ac[L] + 0.5 * (ac[2 * L] || 0));
    if (score > bestScore) { bestScore = score; best = L; }
  }
  // parabolic refinement of the peak
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const d = a - 2 * b + c;
  const off = d !== 0 ? (0.5 * (a - c)) / d : 0;
  return best + Math.max(-0.5, Math.min(0.5, off));
}

// Ellis (2007) dynamic-programming beat tracker: onsets reward, tempo deviations cost.
function trackBeats(env, period, tightness = 100) {
  const n = env.length;
  const p = period;
  // light smoothing so near-miss onsets still count
  const sigma = Math.max(1, p / 32);
  const radius = Math.ceil(sigma * 3);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const v = env[t + k];
      if (v !== undefined) s += v * Math.exp(-0.5 * (k / sigma) ** 2);
    }
    local[t] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, Math.round(t - 2 * p));
    const hi = Math.round(t - p / 2);
    let best = -Infinity, arg = -1;
    for (let u = lo; u <= hi; u++) {
      const s = score[u] - tightness * Math.log((t - u) / p) ** 2;
      if (s > best) { best = s; arg = u; }
    }
    score[t] = local[t] + (arg >= 0 && best > 0 ? best : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  let end = n - 1, endScore = -Infinity;
  for (let t = Math.max(0, Math.floor(n - p)); t < n; t++) if (score[t] > endScore) { endScore = score[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  // drop beats in silent lead-in / tail
  const thresh = 0.05 * Math.max(...local);
  const strong = beats.map((b) => local[b] > thresh);
  const first = strong.indexOf(true), last = strong.lastIndexOf(true);
  return first < 0 ? beats : beats.slice(first, last + 1);
}

// Beat times are frame-quantised; a least-squares line through them gives the
// tempo far more precisely than any single interval.
function fitBpm(beats) {
  const n = beats.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += beats[i]; sxx += i * i; sxy += i * beats[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return 60 / slope;
}

// Which beat (0–3) starts a bar. Claps/snares on 2 and 4 settle the parity
// (1/3 vs 2/4); which of the remaining two is the one comes from section
// changes — drops, breakdowns and new parts arrive on a downbeat.
function findDownbeat(beatFrames, flux, features) {
  const nb = beatFrames.length;
  if (nb < 8) return 0;
  const at = (arr, f) => Math.max(arr[f - 1] ?? 0, arr[f] ?? 0, arr[f + 1] ?? 0, arr[f + 2] ?? 0);
  const snare = beatFrames.map((f) => at(flux.snare, f));

  // novelty at each beat: how different the next bar sounds from the previous one
  const mean = (arr, a, b) => { let s = 0; for (let f = a; f < b; f++) s += arr[f]; return s / Math.max(1, b - a); };
  const novelty = new Float64Array(nb);
  for (let i = 4; i + 4 < nb; i++) {
    const a = beatFrames[i - 4], m = beatFrames[i], b = beatFrames[i + 4];
    for (const arr of features) novelty[i] += Math.abs(mean(arr, m, b) - mean(arr, a, m));
  }

  const parity = [0, 0];
  let snareTotal = 0;
  snare.forEach((v, i) => { parity[i % 2] += v; snareTotal += v; });
  // backbeat on odd beat indices → downbeats are even indices, and vice versa
  const strongParity = Math.abs(parity[0] - parity[1]) > 0.15 * snareTotal;
  const downParity = parity[1] > parity[0] ? 0 : 1;

  const score = [0, 0, 0, 0];
  novelty.forEach((v, i) => { score[i % 4] += v; });
  let best = -1, bestScore = -Infinity;
  for (let k = 0; k < 4; k++) {
    if (strongParity && k % 2 !== downParity) continue;
    if (score[k] > bestScore) { bestScore = score[k]; best = k; }
  }
  return best;
}
