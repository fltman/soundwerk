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
  const tracked = Float64Array.from(beatFrames, (b) => b / fr);
  const beats = steadyBeats(tracked, kickOffsets(tracked, samples, sampleRate, onsets.kick.times));
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

const STRAIGHT = 0.02;   // seconds a beat may stray from a stretch's line
const CORNER = 2;        // beats either side that round off the join between two stretches
const NUDGE_BEATS = 8;   // hits a stretch needs before they may move it
const FOLLOW = 0.008;    // seconds from a line that a kick is still on it
const STRAY = 0.07;      // seconds from such a line that the tracker may be, where no kick says otherwise
const SIDE = 6;          // ms either side of a kick's front that are compared

// The longest stretches that a straight line holds, as [first beat, last beat, time of the first, seconds a beat]
function stretches(beats) {
  const out = [];
  const line = (a, b) => {
    const n = b - a + 1, mx = (n - 1) / 2;
    let my = 0, sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) my += beats[a + k] / n;
    for (let k = 0; k < n; k++) { sxy += (k - mx) * (beats[a + k] - my); sxx += (k - mx) ** 2; }
    const slope = sxx ? sxy / sxx : 0, t0 = my - slope * mx;
    let worst = 0;
    for (let k = 0; k < n; k++) worst = Math.max(worst, Math.abs(beats[a + k] - (t0 + slope * k)));
    return { t0, slope, worst };
  };
  for (let a = 0; a < beats.length;) {
    let b = Math.min(a + 1, beats.length - 1), fit = line(a, b);
    for (let c = b + 1; c < beats.length; c++) {
      const next = line(a, c);
      if (next.worst > STRAIGHT) break;
      b = c; fit = next;
    }
    out.push([a, b, fit.t0, fit.slope]);
    a = b + 1;
  }
  return out;
}

// How far each kick's front sits from its beat, NaN where there is no kick. In the whole band: a
// kick starts high and sweeps down, so in the lows, where kicks and beats were found, it shows up
// tens of milliseconds after it really started. That's why this looks further back than forward.
export function kickOffsets(beats, samples, sr, kicks) {
  const size = Math.round(sr * 0.001), back = 0.08, ahead = 0.03, reach = 0.045, count = Math.round(((back + ahead) * sr) / size);
  const out = new Float64Array(beats.length).fill(NaN);
  let k = 0;
  for (let b = 0; b < beats.length; b++) {
    while (k < kicks.length && kicks[k] < beats[b] - reach) k++;
    if (k >= kicks.length || kicks[k] > beats[b] + reach) continue;
    const from = Math.max(0, Math.round((beats[b] - back) * sr));
    // what comes after each millisecond against what came before it: a mix is never quiet in front
    // of a kick, and inside a kick the energy jumps about, but its way in is one clear step
    const sum = new Float64Array(count + 1);
    for (let w = 0; w < count; w++) {
      let e = 0;
      for (let i = 0; i < size; i++) { const v = samples[from + w * size + i] ?? 0; e += v * v; }
      sum[w + 1] = sum[w] + e;
    }
    let top = 0, at = -1;
    for (let w = SIDE; w + SIDE <= count; w++) {
      const rise = sum[w + SIDE] - 2 * sum[w] + sum[w - SIDE];
      if (rise > top) { top = rise; at = w; }
    }
    if (at >= 0) out[b] = (from + at * size) / sr - beats[b];
  }
  return out;
}

// A track holds its tempo in long straight stretches, joined where a song was extended or a band
// moved, and the tracker wanders a few milliseconds around them. A deck following the beats would
// play that as a wobble in pitch, so each stretch becomes its line, with its kicks on the beat, and
// only the corners between stretches are rounded. Where kicks start the tracker needs a few bars to
// catch up, and that's where a drop lands, so a line with kicks on it runs on into the beats around
// it for as long as they agree with it.
export function steadyBeats(beats, offsets = []) {
  const n = beats.length;
  if (n < 4) return beats;
  const owner = new Array(n), lines = stretches(beats).map(([a, b, t0, slope]) => {
    const seen = [];
    for (let k = a; k <= b; k++) if (Number.isFinite(offsets[k])) seen.push(offsets[k]);
    seen.sort((x, y) => x - y);
    const sure = seen.length >= NUDGE_BEATS, nudge = sure ? seen[seen.length >> 1] : 0;
    const line = { a, b, kicks: sure ? seen.length : 0, at: (k) => t0 + slope * (k - a) + nudge };
    owner.fill(line, a, b + 1);
    return line;
  });
  const agrees = (line, k) => (Number.isFinite(offsets[k]) ? Math.abs(beats[k] + offsets[k] - line.at(k)) < FOLLOW : Math.abs(beats[k] - line.at(k)) < STRAY);
  for (const line of lines.filter((l) => l.kicks).sort((x, y) => y.kicks - x.kicks)) {
    for (let k = line.a - 1; k >= 0 && owner[k].kicks < line.kicks && agrees(line, k); k--) owner[k] = line;
    for (let k = line.b + 1; k < n && owner[k].kicks < line.kicks && agrees(line, k); k++) owner[k] = line;
  }
  const straight = Float64Array.from(owner, (line, k) => line.at(k));
  return straight.map((_, k) => {
    const r = Math.min(CORNER, k, n - 1 - k);
    let s = 0;
    for (let j = k - r; j <= k + r; j++) s += straight[j];
    return s / (2 * r + 1);
  });
}

// Sixteenths from the first downbeat on, interpolated between the beats, so the wall
// follows the track's real timing instead of a fixed tempo.
export function sixteenthGrid(beats, downbeat) {
  const grid = [];
  for (let i = downbeat; i + 1 < beats.length; i++) {
    for (let k = 0; k < 4; k++) grid.push(beats[i] + ((beats[i + 1] - beats[i]) * k) / 4);
  }
  return Float64Array.from(grid);
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
