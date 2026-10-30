// Filters. Cutoffs are volts: vToHz(p), so a cable at depth 1.0 tracks 1 V/oct exactly.
import { Module, TAU, DENORMAL, DCBlock, clamp, lerp, expmap, tanh, vToHz, fmtVHz, fmtHz, fmtPct, filterG, filterTanhGain, filterSolve, FilterSVF } from './lib/index.js';

const fmtQ = (r) => {
  const k = 2.05 * (1 - r) ** 1.5 - 0.05;
  return k <= 0 ? 'OSC' : `Q ${(1 / k).toFixed(1)}`;
};

export const ladder = {
  type: 'ladder', title: 'LADDER', category: 'filter',
  description: '24 dB transistor ladder: warm, fat, self-oscillates as a tuned sine',
  tags: ['moog', 'lowpass', 'vcf', 'filter'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'lp', label: 'LP', kind: 'audio' }],
  params: [
    { name: 'cutoff', label: 'CUTOFF', min: -4, max: 6, default: 1.5, size: 'L', format: fmtVHz, cv: true },
    { name: 'res', label: 'RES', min: 0, max: 1, default: 0.4, format: fmtPct, cv: true },
    { name: 'drive', label: 'DRIVE', min: 0, max: 1, default: 0.15, format: fmtPct },
  ],
  dsp: class Ladder extends Module {
    constructor(sr) {
      super(sr);
      this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0;
      this.cutoff = NaN; this.res = NaN; this.drive = NaN;
      this.g0 = 0; this.G = 0; this.k = 0; this.m = 1; this.comp = 1;
      this.gain = 1; this.level = 1;
    }
    tick(i, o, p) {
      const cutoff = p[0], res = p[1], drive = p[2];
      if (cutoff !== this.cutoff || res !== this.res) {
        if (cutoff !== this.cutoff) { this.cutoff = cutoff; this.g0 = filterG(vToHz(cutoff), this.sr); }
        if (res !== this.res) {
          this.res = res;
          const k = 4.6 * res * res;
          this.k = k;
          // four poles at fc are 12 dB down at fc and -3 dB at 0.435 fc. At k ≥ 1 the corner has
          // reached the poles and the peak closes in on them, so only low RES moves them.
          this.m = k < 1.05 ? 1 / Math.min(1, 0.4345 + k * (0.75 - 0.2 * k)) : 1;
          this.comp = 1 + 0.5 * k; // half of the bass a ladder loses to feedback
        }
        const g = this.g0 * this.m;
        this.G = g / (1 + g);
      }
      if (drive !== this.drive) {
        this.drive = drive;
        this.gain = 0.1 * 10 ** drive;
        this.level = 10 / (1 + drive);
      }
      const G = this.G, q = 1 - G, k = this.k;
      let s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4;
      // a little push, so it rings up on its own with nothing patched in
      if (k > 4 && s1 * s1 + s2 * s2 + s3 * s3 + s4 * s4 < 1e-12) s1 = 1e-4;
      // the ladder's output is G⁴·u + S, and u = tanh(in − k·output)
      const a = i[0] * this.gain - k * q * (G * (G * (G * s1 + s2) + s3) + s4);
      const w = filterSolve(a, k * G * G * G * G);
      const u = tanh(w);
      let v = (u - s1) * G;
      const y1 = v + s1; this.s1 = y1 + v + DENORMAL;
      v = (y1 - s2) * G;
      const y2 = v + s2; this.s2 = y2 + v + DENORMAL;
      v = (y2 - s3) * G;
      const y3 = v + s3; this.s3 = y3 + v + DENORMAL;
      v = (y3 - s4) * G;
      const y4 = v + s4; this.s4 = y4 + v + DENORMAL;
      o[0] = y4 * this.comp * this.level;
    }
  },
};

export const diode = {
  type: 'diode', title: 'DIODE', category: 'filter',
  description: '18 dB diode ladder: rubbery, squelchy, overdriven by a hot input',
  tags: ['acid', '303', 'lowpass', 'vcf', 'filter'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'lp', label: 'LP', kind: 'audio' }],
  params: [
    { name: 'cutoff', label: 'CUTOFF', min: -4, max: 6, default: 1, size: 'L', format: fmtVHz, cv: true },
    { name: 'res', label: 'RES', min: 0, max: 1, default: 0.7, format: fmtPct, cv: true },
  ],
  dsp: class Diode extends Module {
    constructor(sr) {
      super(sr);
      this.s1 = 0; this.s2 = 0; this.s3 = 0; this.sh = 0;
      this.y1 = 0; this.y2 = 0; this.y3 = 0; this.u = 0;
      this.cutoff = NaN; this.res = NaN;
      this.g0 = 0; this.g = 0; this.k = 0; this.m = 1; this.comp = 1;
      this.gh = filterG(70, sr);          // the highpass in the feedback path
      this.dc = new DCBlock(sr, 5);       // below it the makeup gain would reach DC
      this.bh = 1 / (1 + this.gh);
    }
    tick(i, o, p) {
      const cutoff = p[0], res = p[1];
      if (cutoff !== this.cutoff || res !== this.res) {
        if (cutoff !== this.cutoff) { this.cutoff = cutoff; this.g0 = filterG(vToHz(cutoff), this.sr); }
        if (res !== this.res) {
          this.res = res;
          const k = 16.2 * res * res * res;
          this.k = k;
          // where the corner sits, in units of the stages' frequency: -3 dB at low RES, the
          // peak at high RES, a ratio of nearly 7. Fitted to the coupled stages' response.
          this.m = 1 / (k < 1.31 ? 0.305 + 0.46 * k : 0.45 + 0.4 * Math.sqrt(k));
          this.comp = (1 + k) / (1 + 0.1 * k);
        }
        this.g = this.g0 * this.m;
      }
      const g = this.g, k = this.k, c = 0.5;
      const y1 = this.y1, y2 = this.y2, y3 = this.y3;
      // each stage is a diode pair: its conductance falls as it is overdriven. Held from the
      // last sample, which leaves a linear system to solve instantaneously for this one.
      const t1 = g * filterTanhGain(this.u - y1);
      const t2 = g * filterTanhGain(y1 - y2);
      const t3 = g * filterTanhGain(y2 - y3);
      const a2 = c * t2, a3 = c * t3;
      // back-substitute: y3 = A3·y2 + B3, y2 = A2·y1 + B2, y1 = A1·u + B1
      const s1 = this.s1, s2 = this.s2, s3 = this.s3;
      const A3 = t3 / (1 + t3), B3 = s3 / (1 + t3);
      const d2 = 1 / (1 + t2 + a3 * (1 - A3));
      const A2 = t2 * d2, B2 = (s2 + a3 * B3) * d2;
      const d1 = 1 / (1 + t1 + a2 * (1 - A2));
      const A1 = t1 * d1, B1 = (s1 + a2 * B2) * d1;
      const P = A3 * A2 * A1, Q = A3 * (A2 * B1 + B2) + B3;
      // the input stage saturates: feedback through a TPT highpass, so the bass keeps its level
      const sh = this.sh, bh = this.bh;
      const u = tanh(filterSolve(i[0] * 0.35 - k * bh * (Q - sh), k * bh * P));
      const n1 = A1 * u + B1, n2 = A2 * n1 + B2, n3 = A3 * n2 + B3;
      this.u = u; this.y1 = n1; this.y2 = n2; this.y3 = n3;
      this.s1 = 2 * n1 - s1 + DENORMAL;
      this.s2 = 2 * n2 - s2 + DENORMAL;
      this.s3 = 2 * n3 - s3 + DENORMAL;
      this.sh = sh + 2 * this.gh * bh * (n3 - sh) + DENORMAL;
      o[0] = this.dc.tick(2.857 * n3 * this.comp);
    }
  },
};

export const svf = {
  type: 'svf', title: 'SVF', category: 'filter',
  description: 'State-variable filter: lowpass, bandpass, highpass and notch at once, Q to self-oscillation',
  tags: ['multimode', 'lowpass', 'highpass', 'bandpass', 'notch', 'vcf', 'filter'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [
    { name: 'lp', label: 'LP', kind: 'audio' },
    { name: 'bp', label: 'BP', kind: 'audio' },
    { name: 'hp', label: 'HP', kind: 'audio' },
    { name: 'notch', label: 'NOTCH', kind: 'audio' },
  ],
  params: [
    { name: 'cutoff', label: 'CUTOFF', min: -4, max: 6, default: 1, size: 'L', format: fmtVHz, cv: true },
    { name: 'res', label: 'RES', min: 0, max: 1, default: 0.5, format: fmtQ, cv: true },
  ],
  dsp: class SVF extends Module {
    constructor(sr) {
      super(sr);
      this.z1 = 0; this.z2 = 0; this.b = 0;
      this.cutoff = NaN; this.res = NaN;
      this.g = 0; this.k = 1;
    }
    tick(i, o, p) {
      const x = i[0], cutoff = p[0], res = p[1];
      if (cutoff !== this.cutoff) { this.cutoff = cutoff; this.g = filterG(vToHz(cutoff), this.sr); }
      if (res !== this.res) {
        this.res = res;
        // Q 0.5 at 0, through infinity near the top of the knob into negative damping
        this.k = 2.05 * (1 - res) * Math.sqrt(1 - res) - 0.05;
      }
      const g = this.g;
      let z1 = this.z1;
      const z2 = this.z2, b = this.b, b2 = b * b;
      if (this.k < 0 && z1 * z1 + z2 * z2 < 1e-12) z1 = 1e-3;
      // damping grows with level, and that is what bounds the oscillation. It has to be solved
      // with the sample, not held from the last one, or the pitch runs sharp as it rises.
      const c = z1 + g * (x - z2), A = 1 + g * (g + this.k), beta = g * 1.2e-4;
      let v1 = c / (A + beta * b2 * b2);
      const v2n = v1 * v1, v4 = v2n * v2n;
      v1 -= (A * v1 + beta * v4 * v1 - c) / (A + 5 * beta * v4);
      const k = this.k + 1.2e-4 * v1 * v1 * v1 * v1;
      const v2 = z2 + g * v1;
      this.z1 = 2 * v1 - z1 + DENORMAL;
      this.z2 = 2 * v2 - z2 + DENORMAL;
      this.b = v1;
      const notch = x - k * v1;
      o[0] = v2;
      o[1] = v1;
      o[2] = notch - v2;
      o[3] = notch;
    }
  },
};

export const comb = {
  type: 'comb', title: 'COMB', category: 'filter',
  description: 'Tuned feedback comb: metallic resonances, plus or minus feedback, damping',
  tags: ['resonator', 'karplus', 'filter'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'freq', label: 'FREQ', min: -5, max: 5, default: -1, size: 'L', format: fmtVHz, cv: true },
    { name: 'fb', label: 'FEEDBACK', min: -0.99, max: 0.99, default: 0.85, format: fmtPct, cv: true },
    { name: 'damp', label: 'DAMP', min: 0, max: 1, default: 0.25, format: fmtPct, cv: true },
  ],
  dsp: class Comb extends Module {
    constructor(sr) {
      super(sr);
      let n = 16;
      while (n < sr / 8 + 8) n *= 2; // the lowest pitch is 8.2 Hz
      this.buf = new Float64Array(n);
      this.mask = n - 1;
      this.w = 0;
      this.z = 0;
      this.dc = new DCBlock(sr, 8);
      this.freq = NaN; this.damp = NaN; this.fb = NaN;
      this.a = 1; this.delay = 2; this.g = 1;
    }
    tick(i, o, p) {
      const freq = p[0], fb = p[1], damp = p[2];
      if (freq !== this.freq || damp !== this.damp) {
        this.freq = freq; this.damp = damp;
        const hz = vToHz(freq), w = (TAU * hz) / this.sr;
        const a = 1 - Math.exp(-TAU * expmap(1 - damp, 300, this.sr) / this.sr), r = 1 - a;
        this.a = a;
        // the damping pole delays the loop too: take its phase delay out of the line
        const lag = w < 3 ? Math.atan2(r * Math.sin(w), 1 - r * Math.cos(w)) / w : 0;
        this.delay = Math.max(2.01, this.sr / hz - lag);
      }
      if (fb !== this.fb) { this.fb = fb; this.g = Math.sqrt(1 - fb * fb); }
      const buf = this.buf, mask = this.mask, w = this.w;
      // 4-point Lagrange: flat to high up, and clean when the pitch moves
      const pos = w - this.delay, n = Math.floor(pos), f = pos - n;
      const a = buf[(n - 1) & mask], b = buf[n & mask], c = buf[(n + 1) & mask], d = buf[(n + 2) & mask];
      const fm1 = f - 1, fm2 = f - 2, fp1 = f + 1;
      const y = (-f * fm1 * fm2 * a) / 6 + (fp1 * fm1 * fm2 * b) / 2 - (fp1 * f * fm2 * c) / 2 + (fp1 * f * fm1 * d) / 6;
      this.z += this.a * (y - this.z) + DENORMAL;
      const out = 12 * tanh((i[0] * this.g + fb * this.z) / 12);
      buf[w] = out;
      this.w = (w + 1) & mask;
      o[0] = this.dc.tick(out);
    }
  },
};

export const formant = {
  type: 'formant', title: 'FORMANT', category: 'filter',
  description: 'Vowel filter: morph a-e-i-o-u through real formants, makes an acid line talk',
  tags: ['vowel', 'talk', 'voice', 'filter'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'vowel', label: 'VOWEL', min: 0, max: 4, default: 0, size: 'L', format: (v) => 'AEIOU'[Math.round(v)], cv: true },
    { name: 'res', label: 'RES', min: 0, max: 1, default: 0.5, format: fmtPct, cv: true },
  ],
  dsp: class Formant extends Module {
    // F1 F2 F3 in Hz, then their gains: adult male vowels /ɑ ɛ i ɔ u/, Peterson & Barney 1952
    static VOWELS = new Float64Array([
      730, 1090, 2440, 1, 0.5, 0.25,
      530, 1840, 2480, 1, 0.32, 0.2,
      270, 2290, 3010, 1, 0.25, 0.16,
      570, 840, 2410, 1, 0.6, 0.1,
      300, 870, 2240, 1, 0.2, 0.06,
    ]);
    constructor(sr) {
      super(sr);
      this.f1 = new FilterSVF(); this.f2 = new FilterSVF(); this.f3 = new FilterSVF();
      this.vowel = NaN; this.res = NaN;
      this.a1 = 1; this.a2 = 1; this.a3 = 1;
      this.k1 = 0.14; this.k2 = 0.1; this.k3 = 0.08;
    }
    tick(i, o, p) {
      const vowel = p[0], res = p[1];
      if (vowel !== this.vowel || res !== this.res) {
        this.vowel = vowel; this.res = res;
        const t = clamp(vowel, 0, 4), n = Math.min(3, Math.floor(t)), f = t - n, V = Formant.VOWELS, at = n * 6, sr = this.sr;
        const w = 2 ** (0.75 - 1.5 * res); // RES narrows the bands; 0.5 is speech's own bandwidth
        this.f1.set(filterG(lerp(V[at], V[at + 6], f), sr), this.k1 * w);
        this.f2.set(filterG(lerp(V[at + 1], V[at + 7], f), sr), this.k2 * w);
        this.f3.set(filterG(lerp(V[at + 2], V[at + 8], f), sr), this.k3 * w);
        // unity at each band's centre, then the vowel's own balance
        this.a1 = this.k1 * w * lerp(V[at + 3], V[at + 9], f);
        this.a2 = this.k2 * w * lerp(V[at + 4], V[at + 10], f);
        this.a3 = this.k3 * w * lerp(V[at + 5], V[at + 11], f);
      }
      const x = i[0];
      this.f1.tick(x); this.f2.tick(x); this.f3.tick(x);
      // alternating signs: neighbours add between the peaks, as a vocal tract does, not cancel
      // the bands only keep a few harmonics of a saw, so they need gain, and then a ceiling
      o[0] = 8 * tanh(0.625 * (this.a1 * this.f1.bp - this.a2 * this.f2.bp + this.a3 * this.f3.bp));
    }
  },
};

const fmtDj = (x) => {
  if (Math.abs(x) < 0.03) return 'FLAT';
  return x < 0 ? `LP ${fmtHz(expmap(-x, 18000, 40))}` : `HP ${fmtHz(expmap(x, 25, 12000))}`;
};

export const djfilter = {
  type: 'djfilter', title: 'DJ FILTER', category: 'filter',
  description: 'One knob: left lowpass, right highpass, flat in the middle',
  tags: ['lowpass', 'highpass', 'sweep', 'filter'],
  inputs: [{ name: 'in', label: 'IN', kind: 'audio' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'filter', label: 'FILTER', min: -1, max: 1, default: 0, size: 'L', format: fmtDj, cv: true },
    { name: 'res', label: 'RES', min: 0, max: 1, default: 0.3, format: fmtPct, cv: true, needs: { filter: 0.5 } },
  ],
  dsp: class DjFilter extends Module {
    constructor(sr) {
      super(sr);
      this.f = new FilterSVF(); // one filter, on purpose: its state tracks the input across the centre
      this.pos = NaN; this.res = NaN;
      this.wet = 0;
    }
    tick(i, o, p) {
      const pos = p[0], res = p[1], x = i[0];
      if (pos !== this.pos || res !== this.res) {
        this.pos = pos; this.res = res;
        const a = Math.abs(pos);
        // the resonance and the filter fade in together just off centre, so the middle is a wire
        const near = clamp((a - 0.03) / 0.09, 0, 1);
        this.wet = near * near * (3 - 2 * near);
        this.f.set(filterG(pos < 0 ? expmap(a, 18000, 40) : expmap(a, 25, 12000), this.sr), 1 / (0.7071 + 8 * res * res * this.wet));
      }
      const f = this.f, wet = this.wet;
      f.tick(x);
      o[0] = wet === 0 ? x : x + wet * ((pos < 0 ? f.lp : f.hp) - x);
    }
  },
};

export const filters = [ladder, diode, svf, comb, formant, djfilter];
