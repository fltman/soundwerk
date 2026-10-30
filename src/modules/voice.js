// Complete voices: an oscillator, a filter, envelopes and a VCA behind one panel.
import {
  Module, C4, TAU, DENORMAL, Trigger, Rng, clamp, expmap, hzToV, polyblep, tanh, softclip, OscDown2,
  fmtSt, fmtVHz, fmtExp, fmtPct,
} from './lib/index.js';

export const acid = {
  type: 'acid', title: 'ACID BOX', category: 'voice', theme: 'silver',
  description: 'Bass line voice: saw or square into a diode ladder, accent, slide and the wow',
  tags: ['bassline', 'squelch', 'mono', 'ladder'],
  inputs: [
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
    { name: 'gate', label: 'GATE', kind: 'gate' },
    { name: 'accent', label: 'ACC', kind: 'gate' },
    { name: 'slide', label: 'SLIDE', kind: 'gate' },
  ],
  outputs: [
    { name: 'out', label: 'OUT', kind: 'audio' },
    { name: 'env', label: 'ENV', kind: 'cv' },
  ],
  params: [
    { name: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, size: 'L', format: fmtSt },
    { name: 'cutoff', label: 'CUTOFF', min: hzToV(313.8152786), max: hzToV(2394.411987), default: hzToV(640), size: 'L', cv: true, cvSpan: 10, cvMin: -2, cvMax: 5, format: fmtVHz },
    { name: 'reso', label: 'RESO', min: 0, max: 1, default: 0.6, size: 'L', format: fmtPct },
    { name: 'envMod', label: 'ENV MOD', min: 0, max: 1, default: 0.55, size: 'L', format: fmtPct },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.25, size: 'L', format: fmtExp(0.2, 2) },
    { name: 'accentAmt', label: 'ACCENT', min: 0, max: 1, default: 0.65, size: 'L', format: fmtPct },
    { name: 'wave', label: 'WAVE', type: 'select', options: ['SAW', 'SQR'], default: 0 },
    { name: 'volume', label: 'VOLUME', min: 0, max: 1, default: 0.8, format: fmtPct },
  ],
  lights: [
    { name: 'gateLed', label: 'GATE', color: 'red' },
    { name: 'accLed', label: 'ACC', color: 'green' },
  ],
  cols: 3,
  dsp: class Acid extends Module {
    // the ends of the cutoff knob, measured on the hardware (Open303), as volts
    static V0 = Math.log2(313.8152786 / C4);
    static V1 = Math.log2(2394.411987 / C4);
    static WOW = 2.6;   // octaves of accent sweep at full ACCENT and a full capacitor
    static LEVEL = 2.1; // the filter's output to about ±5 V on a default note

    constructor(sr) {
      super(sr);
      const dt = this.dt, fs = sr * 2; // the oscillator and the ladder run at twice the rate
      this.fs = fs;
      this.top = Math.min(20000, 0.22 * fs);
      this.gate = new Trigger();
      this.acc = new Trigger();
      this.sld = new Trigger();
      this.down = new OscDown2();

      this.pv = 0;
      this.primed = false;
      this.inc = 0;
      this.keyV = NaN;
      this.phase = 0;

      this.meg = 0;      // main envelope, decaying; `env` is it through its 3 ms RC
      this.env = 0;
      this.wow = 0;      // the accent sweep's capacitor
      this.accG = 0;     // the accent reaching the VCA, slewed so a tied change can't click
      this.ae = 0;       // the amp envelope, then its two declick poles
      this.d1 = 0;
      this.d2 = 0;

      this.y1 = 0; this.y2 = 0; this.y3 = 0; this.y4 = 0;
      this.hx = 0; this.hy = 0;
      this.fbA = Math.exp((-TAU * 150) / fs);
      this.b = 0.1; this.k = 0; this.g = 1;
      this.keyOct = Infinity;
      this.keyR = NaN;
      this.r = 0;
      this.keyDecay = NaN;
      this.kDecay = 1;
      this.nDecay = 1;
      this.nAccent = (0.2 / 0.003) ** (0.003 / 0.197);
      this.keyReso = NaN;
      this.kWow = 0;

      this.kSlide = 1 - Math.exp(-dt / 0.06);
      this.kEnv = 1 - Math.exp(-dt / 0.003);
      this.kAccent = Math.exp(-dt / 0.2);
      this.kAmp = Math.exp(-dt / 0.435);   // 60 dB in 3 s
      this.kRel = Math.exp(-dt / 0.006);
      this.kClick = 1 - Math.exp(-dt / 0.001);

      // what the board does to the signal after the filter, from Open303's fit to recordings
      this.a1 = Math.exp((-TAU * 44.486) / sr);
      this.a2 = Math.exp((-TAU * 24.167) / sr);
      const ap = Math.tan((Math.PI * 14.008) / sr);
      this.ap = (ap - 1) / (ap + 1);
      const w = (TAU * 7.5164) / sr, alpha = Math.sin(w) * Math.sinh((Math.LN2 / 2) * 4.7 * (w / Math.sin(w)));
      const a0 = 1 + alpha;
      this.nb0 = 1 / a0; this.nb1 = (-2 * Math.cos(w)) / a0; this.na2 = (1 - alpha) / a0;
      this.x1 = 0; this.y1h = 0; this.x2 = 0; this.y2h = 0;
      this.apx = 0; this.apy = 0;
      this.nx1 = 0; this.nx2 = 0; this.ny1 = 0; this.ny2 = 0;
    }

    tick(i, o, p) {
      const pitch = i[0], gate = i[1], accent = i[2], slide = i[3];
      const tune = p[0], cutoff = p[1], reso = p[2], envMod = p[3], decay = p[4], accentAmt = p[5], wave = p[6], volume = p[7];

      const rose = this.gate.tick(gate), held = this.gate.high;
      this.acc.tick(accent);
      this.sld.tick(slide);
      const accented = held && this.acc.high;

      // slide glides the CV through an RC. Without it the note simply changes.
      if (this.sld.high && this.primed) this.pv += (pitch - this.pv) * this.kSlide;
      else this.pv = pitch;
      this.primed = true;

      if (decay !== this.keyDecay) {
        this.keyDecay = decay;
        const tau = expmap(decay, 0.2, 2);
        this.kDecay = Math.exp(-this.dt / tau);
        this.nDecay = (tau / 0.003) ** (0.003 / (tau - 0.003)); // what the RC takes off the peak
      }
      if (reso !== this.keyReso) {
        this.keyReso = reso;
        // the resonance pot's taper, and its second gang: more RESO, slower accent capacitor
        this.r = (1 - Math.exp(-3 * reso)) / 0.950212931632136;
        this.kWow = 1 - Math.exp(-this.dt / (0.047 + 0.1 * reso));
      }

      // Only a rising gate retriggers. That one line is what makes a tied note slide.
      if (rose) { this.meg = 1; this.ae = 1; }
      this.meg *= accented ? this.kAccent : this.kDecay;
      this.env += (this.meg * (accented ? this.nAccent : this.nDecay) - this.env) * this.kEnv;
      const env = this.env + DENORMAL;
      this.wow += ((accented ? env : 0) - this.wow) * this.kWow;

      this.ae *= held ? this.kAmp : this.kRel;
      this.d1 += (this.ae - this.d1) * this.kClick;
      this.d2 += (this.d1 - this.d2) * this.kClick;
      this.accG += ((accented ? accentAmt : 0) - this.accG) * this.kClick;

      // Cutoff, by the hardware's measured mapping: the envelope is not centred on the knob, and
      // the span of ENV MOD depends on where the knob is. Only the accent sweep adds on top.
      const c = clamp((cutoff - Acid.V0) / (Acid.V1 - Acid.V0), 0, 1);
      const sLo = 3.773996325 * envMod + 0.736965594, sHi = 4.194548788 * envMod + 0.864344901;
      const scale = (1 - c) * sLo + c * sHi, offset = 0.048292931 * c + 0.294391201;
      const oct = cutoff + scale * (env - offset) + accentAmt * Acid.WOW * this.wow;

      if (Math.abs(oct - this.keyOct) > 0.002 || this.r !== this.keyR) {
        this.keyOct = oct;
        this.keyR = this.r;
        const x = clamp(C4 * 2 ** oct, 200, this.top) / this.fs, fx = x * 0.7071, r = this.r;
        // This b is the exact solution for the loop's -180° point: the published fit has a
        // constant only right at one sample rate, 83 cents sharp at 314 Hz when oversampled.
        this.b = (4.44168834 * x) / (1 + 9.11373943 * x + 1.28511979 * x * x);
        // and this k is the exact critical feedback of the discrete loop, to three decimals
        const k = fx * (fx * (fx * (fx * (fx * (fx + 7198.6997) - 5837.7917) - 476.47308) + 614.95611) + 213.87126) + 16.998792;
        this.g = (((k / 17) - 1) * r + 1) * (1 + r);
        this.k = k * r;
      }

      const v = this.pv + tune / 12;
      if (v !== this.keyV) { this.keyV = v; this.inc = Math.min((C4 * 2 ** v) / this.fs, 0.45); }

      const dt = this.inc, b = this.b, k = this.k, fbA = this.fbA;
      const edge = Math.min(70, 0.7 / dt), lift = edge * 0.0624; // the square's soft edge, never under two samples
      let t = this.phase, y1 = this.y1, y2 = this.y2, y3 = this.y3, y4 = this.y4, hx = this.hx, hy = this.hy, s0 = 0, s1 = 0;
      for (let n = 0; n < 2; n++) {
        t += dt;
        if (t >= 1) t -= 1;
        const ramp = 2 * t - 1;
        // The square comes from the saw through one transistor: a hard edge at the reset, a
        // soft one where the ramp crosses its threshold, a little over half way.
        const x = (wave === 0 ? ramp : tanh(edge * ramp + lift)) - polyblep(t, dt);
        const f = y4 > 1.4142135 ? 1.4142135 : y4 < -1.4142135 ? -1.4142135 : y4;
        const fb = k * (f - 0.1666666667 * f * f * f);
        hy = fbA * (hy + fb - hx);
        hx = fb;
        const y0 = -x - hy; // the voice is inverted, as the board is
        y1 += 2 * b * (y0 - y1 + y2);
        y2 += b * (y1 - 2 * y2 + y3);
        y3 += b * (y2 - 2 * y3 + y4);
        y4 += b * (y3 - 2 * y4);
        if (n === 0) s0 = y4; else s1 = y4;
      }
      this.phase = t;
      this.y1 = y1; this.y2 = y2; this.y3 = y3; this.y4 = y4; this.hx = hx; this.hy = hy;

      let s = 2 * this.g * this.down.down(s0, s1);
      // two highpasses
      this.y1h = this.a1 * (this.y1h + s - this.x1) + DENORMAL; this.x1 = s; s = this.y1h;
      this.y2h = this.a2 * (this.y2h + s - this.x2) + DENORMAL; this.x2 = s; s = this.y2h;
      // the allpass and the notch
      const ap = this.ap * (s - this.apy) + this.apx;
      this.apx = s; this.apy = ap; s = ap;
      const nb0 = this.nb0, nb1 = this.nb1, na2 = this.na2;
      const ny = nb0 * s + nb1 * this.nx1 + nb0 * this.nx2 - nb1 * this.ny1 - na2 * this.ny2 + DENORMAL;
      this.nx2 = this.nx1; this.nx1 = s; this.ny2 = this.ny1; this.ny1 = ny;

      // The main envelope also leaks into the VCA, a little always and a lot on an accent
      const vca = this.d2 * (1 + (0.45 + 3.5 * this.accG) * env);
      // the ladder's passband sits 8 dB lower with any resonance; made up, so all of RESO is usable
      const level = (Acid.LEVEL * (1 + 1.3 * this.r) * volume * volume) / 0.64;
      o[0] = 6 * softclip((ny * vca * level) / 6);
      o[1] = 10 * env;
      this.ui[0] = held ? 1 : 0;
      this.ui[1] = this.wow;
    }
  },
};

export const mono = {
  type: 'mono', title: 'MONO SYNTH', category: 'voice', theme: 'cream',
  description: 'A complete monosynth: VCO, sub and noise, resonant ladder with drive, two envelopes, glide',
  tags: ['bass', 'lead', 'ladder', 'adsr'],
  inputs: [
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
    { name: 'gate', label: 'GATE', kind: 'gate' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'saw', label: 'SAW', min: 0, max: 1, default: 0.8, size: 'F', format: fmtPct },
    { name: 'pulse', label: 'PULSE', min: 0, max: 1, default: 0.3, size: 'F', format: fmtPct },
    { name: 'sub', label: 'SUB', min: 0, max: 1, default: 0.5, size: 'F', format: fmtPct },
    { name: 'noise', label: 'NOISE', min: 0, max: 1, default: 0, size: 'F', format: fmtPct },
    { name: 'attack', label: 'A', min: 0, max: 1, default: 0.05, size: 'F', format: fmtExp(0.001, 4) },
    { name: 'dec', label: 'D', min: 0, max: 1, default: 0.5, size: 'F', format: fmtExp(0.005, 4) },
    { name: 'sustain', label: 'S', min: 0, max: 1, default: 0.65, size: 'F', format: fmtPct },
    { name: 'release', label: 'R', min: 0, max: 1, default: 0.3, size: 'F', format: fmtExp(0.005, 6) },
    { name: 'cutoff', label: 'CUTOFF', min: -4, max: 6, default: 0.2, size: 'L', cv: true, format: fmtVHz, br: true },
    { name: 'reso', label: 'RESO', min: 0, max: 1, default: 0.35, size: 'L', format: fmtPct },
    { name: 'drive', label: 'DRIVE', min: 0, max: 1, default: 0.25, format: fmtPct },
    { name: 'envAmt', label: 'ENV', min: -6, max: 6, default: 3, format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} oct` },
    { name: 'kbd', label: 'KBD', min: 0, max: 1, default: 0.5, format: fmtPct },
    { name: 'tune', label: 'TUNE', min: -24, max: 24, default: 0, format: fmtSt, br: true },
    { name: 'glide', label: 'GLIDE', min: 0, max: 1, default: 0, format: fmtExp(0.002, 1) },
    { name: 'pw', label: 'PW', min: 0.05, max: 0.95, default: 0.4 },
    { name: 'fAtk', label: 'F.ATK', min: 0, max: 1, default: 0, format: fmtExp(0.001, 2) },
    { name: 'fDec', label: 'F.DEC', min: 0, max: 1, default: 0.4, format: fmtExp(0.01, 4) },
    { name: 'level', label: 'LEVEL', min: 0, max: 1, default: 0.8, format: fmtPct },
  ],
  lights: [{ name: 'gateLed', label: 'GATE', color: 'red' }],
  dsp: class Mono extends Module {
    constructor(sr) {
      super(sr);
      this.fs = sr * 2;
      this.gate = new Trigger();
      this.rng = new Rng(5501);
      this.down = new OscDown2();
      this.pv = 0;
      this.primed = false;
      this.keyV = NaN;
      this.inc = 0;
      this.t = 0;
      this.ts = 0;
      this.stage = 0;   // ADSR: 0 idle or release, 1 attack, 2 decay and sustain
      this.ae = 0;
      this.fStage = 0;  // filter envelope: 1 attack, 0 decay
      this.fe = 0;
      this.seen = new Float64Array(6).fill(NaN);
      this.ka = 0; this.kd = 1; this.kr = 1; this.kfa = 0; this.kfd = 1; this.kg = 0;
      // a whisper in the ladder, so full resonance starts to sing with nothing patched in
      this.s1 = 1e-4; this.s2 = 0; this.s3 = 0; this.s4 = 0;
      this.keyOct = Infinity;
      this.G = 0.1;
      this.top = Math.min(20000, 0.4 * this.fs);
    }
    tick(i, o, p) {
      const pitch = i[0], gate = i[1];
      const sawL = p[0], pulseL = p[1], subL = p[2], noiseL = p[3], attack = p[4], dec = p[5], sustain = p[6], release = p[7];
      const cutoff = p[8], reso = p[9], drive = p[10], envAmt = p[11], kbd = p[12], tune = p[13], glide = p[14], pw = p[15], fAtk = p[16], fDec = p[17], level = p[18];

      const rose = this.gate.tick(gate), held = this.gate.high;
      const seen = this.seen;
      if (attack !== seen[0] || dec !== seen[1] || release !== seen[2] || fAtk !== seen[3] || fDec !== seen[4] || glide !== seen[5]) {
        seen[0] = attack; seen[1] = dec; seen[2] = release; seen[3] = fAtk; seen[4] = fDec; seen[5] = glide;
        const dt = this.dt;
        // the attack heads for 1.25 and stops at 1, which takes 1.6 of its time constants
        this.ka = 1 - Math.exp((-dt * 1.6) / expmap(attack, 0.001, 4));
        this.kd = Math.exp((-dt * 3) / expmap(dec, 0.005, 4));   // 95 % of the way in the time shown
        this.kr = Math.exp((-dt * 3) / expmap(release, 0.005, 6));
        this.kfa = 1 - Math.exp((-dt * 1.6) / expmap(fAtk, 0.001, 2));
        this.kfd = Math.exp((-dt * 3) / expmap(fDec, 0.01, 4));
        this.kg = 1 - Math.exp(-dt / expmap(glide, 0.002, 1));
      }
      if (rose) { this.stage = 1; this.fStage = 1; }
      if (!held) this.stage = 0;
      if (this.stage === 1) {
        this.ae += (1.25 - this.ae) * this.ka;
        if (this.ae >= 1) { this.ae = 1; this.stage = 2; }
      } else if (this.stage === 2) this.ae = sustain + (this.ae - sustain) * this.kd;
      else this.ae = this.ae * this.kr + DENORMAL;
      if (this.fStage === 1) {
        this.fe += (1.25 - this.fe) * this.kfa;
        if (this.fe >= 1) { this.fe = 1; this.fStage = 0; }
      } else this.fe = this.fe * this.kfd + DENORMAL;

      if (glide > 0 && this.primed) this.pv += (pitch - this.pv) * this.kg;
      else this.pv = pitch;
      this.primed = true;
      const v = this.pv + tune / 12;
      if (v !== this.keyV) { this.keyV = v; this.inc = Math.min((C4 * 2 ** v) / this.fs, 0.45); }

      const oct = cutoff + kbd * this.pv + envAmt * this.fe;
      if (Math.abs(oct - this.keyOct) > 0.002) {
        this.keyOct = oct;
        const g = Math.tan((Math.PI * clamp(C4 * 2 ** oct, 16, this.top)) / this.fs);
        this.G = g / (1 + g);
      }
      const G = this.G, H = 1 - G, k = 4.15 * reso, G2 = G * G, G3 = G2 * G, solve = 1 / (1 + k * G2 * G2);
      const dt = this.inc, ds = dt * 0.5, push = 1 + 7 * drive * drive, trim = 1 / (1 + 0.15 * (push - 1));
      let t = this.t, ts = this.ts, s1 = this.s1, s2 = this.s2, s3 = this.s3, s4 = this.s4, a = 0, b = 0;
      for (let n = 0; n < 2; n++) {
        t += dt;
        if (t >= 1) t -= 1;
        ts += ds;
        if (ts >= 1) ts -= 1;
        const bt = polyblep(t, dt);
        let t2 = t + 1 - pw;
        if (t2 >= 1) t2 -= 1;
        let t3 = ts + 0.5;
        if (t3 >= 1) t3 -= 1;
        const mix = sawL * (2 * t - 1 - bt) + pulseL * ((t < pw ? 1 : -1) + bt - polyblep(t2, dt) + 1 - 2 * pw)
          + subL * ((ts < 0.5 ? 1 : -1) + polyblep(ts, ds) - polyblep(t3, ds)) + noiseL * this.rng.bipolar();
        const x = tanh(mix * push) * trim;
        // A zero-delay ladder: solved for its own feedback, then bent. Tuned at any cutoff.
        const S = H * (G3 * s1 + G2 * s2 + G * s3 + s4);
        const u = tanh((x - k * S) * solve);
        let c = (u - s1) * G, y = c + s1;
        s1 = y + c;
        c = (y - s2) * G; y = c + s2;
        s2 = y + c;
        c = (y - s3) * G; y = c + s3;
        s3 = y + c;
        c = (y - s4) * G; y = c + s4;
        s4 = y + c;
        if (n === 0) a = y; else b = y;
      }
      this.t = t; this.ts = ts;
      this.s1 = s1; this.s2 = s2; this.s3 = s3; this.s4 = s4;
      const body = this.down.down(a, b) * (1 + 0.5 * k); // half of what the feedback takes from the bass
      o[0] = 6.6 * body * this.ae * level * 1.25;
      this.ui[0] = held ? 1 : 0;
    }
  },
};

export const voice = [acid, mono];
