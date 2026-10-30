// Oscillators and noise.
import {
  Module, C4, TAU, DENORMAL, Trigger, Rng, DCBlock, clamp, expmap,
  Blep, BLEP_DELAY, WT_FRAMES, WT_TOP, WT_MIPS, wtRead,
  fmtSt, fmtPct, fmtExp, fmtExpHz, fmtRatio,
} from './lib/index.js';

export const vco = {
  type: 'vco', title: 'VCO', category: 'source',
  description: 'Analog oscillator: saw, pulse, triangle, sine and sub outs, sync, FM, PWM',
  tags: ['oscillator'],
  inputs: [
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
    { name: 'fm', label: 'FM', kind: 'audio' },
    { name: 'sync', label: 'SYNC', kind: 'gate' },
  ],
  outputs: [
    { name: 'saw', label: 'SAW', kind: 'audio' },
    { name: 'pulse', label: 'PULSE', kind: 'audio' },
    { name: 'tri', label: 'TRI', kind: 'audio' },
    { name: 'sine', label: 'SINE', kind: 'audio' },
    { name: 'sub', label: 'SUB', kind: 'audio' },
  ],
  params: [
    { name: 'tune', label: 'TUNE', min: -36, max: 36, default: 0, step: 1, size: 'L', format: fmtSt },
    { name: 'fine', label: 'FINE', min: -1, max: 1, default: 0, format: fmtSt },
    { name: 'fmAmt', label: 'FM AMT', min: 0, max: 1, default: 0 },
    { name: 'pw', label: 'PW', min: 0.05, max: 0.95, default: 0.5, cv: true },
  ],
  dsp: class VCO extends Module {
    constructor(sr) {
      super(sr);
      this.phase = 0;
      this.v = NaN;      // exponent the increment was computed for
      this.inc = 0;
      this.high = true;  // the pulse's state
      this.subSign = 1;
      this.sync = new Trigger();
      this.lastSync = 0;
      this.bSaw = new Blep();
      this.bPulse = new Blep();
      this.bTri = new Blep();
      this.bSine = new Blep();
      this.bSub = new Blep();
    }
    tick(i, o, p) {
      const pitch = i[0], fm = i[1], sync = i[2];
      const tune = p[0], fine = p[1], fmAmt = p[2], pw = p[3];
      const v = pitch + (tune + fine) / 12 + fm * fmAmt;
      if (v !== this.v) { this.v = v; this.inc = Math.min(C4 * 2 ** v * this.dt, 0.49); }
      const dt = this.inc, old = this.phase, u = old + dt;
      let t = u, wrapped = false;

      if (this.sync.tick(sync)) {
        // reset where the input crossed 2 V, and pay for every jump that makes
        const e = clamp((sync - 2) / (sync - this.lastSync + 1e-9), 0, 0.999);
        let ts = old + (1 - e) * dt;
        if (ts >= 1) ts -= 1;
        const tsd = ts - BLEP_DELAY * dt;
        this.bSaw.step(e, -2 * ts);
        if (!this.high) { this.bPulse.step(e, 2); this.high = true; }
        const triNow = ts < 0.25 ? 4 * ts : ts < 0.75 ? 2 - 4 * ts : 4 * ts - 4;
        this.bTri.step(e, -triNow);
        if (ts >= 0.25 && ts < 0.75) this.bTri.ramp(e, 8 * dt);
        this.bSine.step(e, -Math.sin(TAU * tsd));
        this.bSub.step(e, -2 * this.subSign);
        this.subSign = -this.subSign;
        t = e * dt;
      } else {
        // the triangle's corners
        if (old < 0.25 && u >= 0.25) this.bTri.ramp((u - 0.25) / dt, -8 * dt);
        else if (old < 0.75 && u >= 0.75) this.bTri.ramp((u - 0.75) / dt, 8 * dt);
        else if (u >= 1.25) this.bTri.ramp((u - 1.25) / dt, -8 * dt);
        if (u >= 1) {
          t = u - 1;
          wrapped = true;
          const e = t / dt;
          this.bSaw.step(e, -2);
          if (this.high) this.bPulse.step(Math.min((u - pw) / dt, 0.999), -2);
          this.bPulse.step(e, 2);
          this.high = true;
          this.bSub.step(e, -2 * this.subSign);
          this.subSign = -this.subSign;
        }
      }
      this.lastSync = sync;
      this.phase = t;

      // the falling edge; if PW swept back over the phase, the edge goes the other way
      if (this.high) {
        if (t >= pw) { this.bPulse.step(Math.min((t - pw) / dt, 0.999), -2); this.high = false; }
      } else if (t < pw && !wrapped) { this.bPulse.step(0.5, 2); this.high = true; }

      // every edge lands BLEP_DELAY samples late, so the smooth waves run that late too
      let d = t - BLEP_DELAY * dt;
      if (d < 0) d += 1;
      const tri = d < 0.25 ? 4 * d : d < 0.75 ? 2 - 4 * d : 4 * d - 4;

      o[0] = 5 * (2 * t - 1 - 2 * BLEP_DELAY * dt + this.bSaw.next());
      o[1] = 5 * ((this.high ? 1 : -1) + 1 - 2 * pw + this.bPulse.next()); // no DC, whatever the PW
      o[2] = 5 * (tri + this.bTri.next());
      o[3] = 5 * (Math.sin(TAU * d) + this.bSine.next());
      o[4] = 5 * (this.subSign + this.bSub.next());
    }
  },
};

export const supersaw = {
  type: 'supersaw', title: 'SUPERSAW', category: 'source',
  description: 'Seven detuned saws in stereo, the classic hoover wall',
  tags: ['oscillator', 'unison', 'detune', 'stereo'],
  inputs: [{ name: 'pitch', label: 'V/OCT', kind: 'pitch' }],
  outputs: [
    { name: 'l', label: 'L', kind: 'audio' },
    { name: 'r', label: 'R', kind: 'audio' },
  ],
  params: [
    { name: 'tune', label: 'TUNE', min: -36, max: 36, default: 0, step: 1, size: 'L', format: fmtSt },
    { name: 'detune', label: 'DETUNE', min: 0, max: 1, default: 0.5, cv: true, format: fmtPct },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.6, cv: true, format: fmtPct },
    { name: 'width', label: 'WIDTH', min: 0, max: 1, default: 0.8, format: fmtPct },
  ],
  dsp: class Supersaw extends Module {
    // Szabó's measurements of the original: where each voice sits, relative to the note
    static SPREAD = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
    static PAN = [-1, 0.8, -0.55, 0, 0.55, -0.8, 1]; // neighbours swap sides, so close pairs beat across the room
    constructor(sr) {
      super(sr);
      const rng = new Rng(7001);
      this.phase = new Float64Array(7);
      for (let k = 0; k < 7; k++) this.phase[k] = rng.next(); // free-running, never in step
      this.inc = new Float64Array(7);
      this.gl = new Float64Array(7);
      this.gr = new Float64Array(7);
      this.keyV = NaN; this.keyDetune = NaN; this.keyMix = NaN; this.keyWidth = NaN;
      this.hpA = 0;
      this.xl = 0; this.yl = 0; this.xr = 0; this.yr = 0;
      this.bl = new Blep();
      this.br = new Blep();
    }
    setPitch(v, detune) {
      const dt = C4 * 2 ** v * this.dt;
      // his 11th-order fit of the knob: gentle up to half way, wild at the top
      let y = 10028.7312891634;
      y = y * detune - 50818.8652045924;
      y = y * detune + 111363.4808729368;
      y = y * detune - 138150.6761080548;
      y = y * detune + 106649.6679158292;
      y = y * detune - 53046.9642751875;
      y = y * detune + 17019.951858008;
      y = y * detune - 3425.0836591318;
      y = y * detune + 404.2703938388;
      y = y * detune - 24.1878824391;
      y = y * detune + 0.6717417634;
      y = y * detune + 0.0030115596;
      for (let k = 0; k < 7; k++) this.inc[k] = Math.min(dt * (1 + Supersaw.SPREAD[k] * y), 0.49);
      // the original's high-pass tracks the note and takes out the mud the detuning makes
      this.hpA = Math.exp(-TAU * Math.min(dt, 0.25));
    }
    setGains(mix, width) {
      const center = -0.55366 * mix + 0.99785, side = -0.73764 * mix * mix + 1.2841 * mix + 0.04471;
      const norm = 0.9 / Math.sqrt(center * center + 6 * side * side);
      for (let k = 0; k < 7; k++) {
        const g = (k === 3 ? center : side) * norm;
        const a = ((Supersaw.PAN[k] * width + 1) * Math.PI) / 4;
        this.gl[k] = g * Math.cos(a) * Math.SQRT2;
        this.gr[k] = g * Math.sin(a) * Math.SQRT2;
      }
    }
    tick(i, o, p) {
      const pitch = i[0];
      const tune = p[0], detune = p[1], mix = p[2], width = p[3];
      const v = pitch + tune / 12;
      if (v !== this.keyV || detune !== this.keyDetune) { this.keyV = v; this.keyDetune = detune; this.setPitch(v, detune); }
      if (mix !== this.keyMix || width !== this.keyWidth) { this.keyMix = mix; this.keyWidth = width; this.setGains(mix, width); }
      const phase = this.phase, inc = this.inc, gl = this.gl, gr = this.gr, bl = this.bl, br = this.br;
      let l = 0, r = 0;
      for (let k = 0; k < 7; k++) {
        let t = phase[k] + inc[k];
        if (t >= 1) {
          t -= 1;
          const e = t / inc[k];
          bl.step(e, -2 * gl[k]);
          br.step(e, -2 * gr[k]);
        }
        phase[k] = t;
        const s = 2 * t - 1;
        l += gl[k] * s;
        r += gr[k] * s;
      }
      l += bl.next();
      r += br.next();
      const a = this.hpA;
      this.yl = a * (this.yl + l - this.xl) + DENORMAL;
      this.yr = a * (this.yr + r - this.xr) + DENORMAL;
      this.xl = l;
      this.xr = r;
      o[0] = Supersaw.knee(5 * this.yl);
      o[1] = Supersaw.knee(5 * this.yr);
    }
    // Clean to 7 V. Seven wraps only rarely land together, and that is all this ever touches.
    static knee(x) {
      const a = Math.abs(x) - 7;
      if (a <= 0) return x;
      const y = 7 + a / (1 + a / 3);
      return x < 0 ? -y : y;
    }
  },
};

export const chord = {
  type: 'chord', title: 'CHORD', category: 'source',
  description: 'A whole chord from one pitch: detuned saws or pulses, for dub stabs',
  tags: ['oscillator', 'stab', 'dub techno', 'poly'],
  inputs: [{ name: 'pitch', label: 'V/OCT', kind: 'pitch' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'tune', label: 'TUNE', min: -36, max: 36, default: 0, step: 1, size: 'L', format: fmtSt },
    { name: 'kind', label: 'CHORD', type: 'select', options: ['MINOR', 'MIN7', 'MIN9', 'MAJ7', 'SUS2', 'SUS4', '5TH', 'M11'], default: 7, cv: true },
    { name: 'inv', label: 'INV', type: 'select', options: ['ROOT', '1ST', '2ND', '3RD'], default: 0 },
    { name: 'wave', label: 'WAVE', type: 'select', options: ['SAW', 'PULSE'], default: 0 },
    { name: 'detune', label: 'DETUNE', min: 0, max: 30, default: 9, format: (c) => `${c.toFixed(1)} ct` },
  ],
  dsp: class Chord extends Module {
    // semitones above the root; the last is the stack a dub chord is
    static SEMIS = [[0, 3, 7], [0, 3, 7, 10], [0, 3, 7, 10, 14], [0, 4, 7, 11], [0, 2, 7], [0, 5, 7], [0, 7, 12], [0, 3, 7, 10, 14, 17]];
    constructor(sr) {
      super(sr);
      const rng = new Rng(4099);
      this.phase = new Float64Array(12);
      for (let k = 0; k < 12; k++) this.phase[k] = rng.next();
      this.inc = new Float64Array(12);
      this.n = 0;
      this.g = 0;
      this.keyV = NaN; this.keyKind = NaN; this.keyInv = NaN; this.keyDetune = NaN;
      this.blep = new Blep();
      this.dc = new DCBlock(sr);
    }
    voice(v, kind, inv, detune) {
      const semis = Chord.SEMIS[kind], n = semis.length, dt = C4 * 2 ** v * this.dt;
      const up = 2 ** (detune / 1200), down = 1 / up;
      for (let k = 0; k < n; k++) {
        const ratio = 2 ** ((semis[k] + (k < inv ? 12 : 0)) / 12);
        this.inc[k * 2] = Math.min(dt * ratio * up, 0.49);
        this.inc[k * 2 + 1] = Math.min(dt * ratio * down, 0.49);
      }
      this.n = n * 2;
      this.g = 0.82 / Math.sqrt(n * 2);
    }
    tick(i, o, p) {
      const pitch = i[0];
      const tune = p[0], kind = p[1], inv = p[2], wave = p[3], detune = p[4];
      const v = pitch + tune / 12;
      if (v !== this.keyV || kind !== this.keyKind || inv !== this.keyInv || detune !== this.keyDetune) {
        this.keyV = v; this.keyKind = kind; this.keyInv = inv; this.keyDetune = detune;
        this.voice(v, kind, inv, detune);
      }
      const n = this.n, phase = this.phase, inc = this.inc, blep = this.blep;
      const g = wave === 0 ? this.g : this.g * 0.577; // a square has √3 the power of a saw
      let s = 0;
      if (wave === 0) {
        for (let k = 0; k < n; k++) {
          let t = phase[k] + inc[k];
          if (t >= 1) { t -= 1; blep.step(t / inc[k], -2 * g); }
          phase[k] = t;
          s += g * (2 * t - 1);
        }
      } else {
        for (let k = 0; k < n; k++) {
          const old = phase[k], dt = inc[k];
          let t = old + dt;
          if (old < 0.5 && t >= 0.5) blep.step((t - 0.5) / dt, -2 * g);
          if (t >= 1) { t -= 1; blep.step(t / dt, 2 * g); }
          phase[k] = t;
          s += t < 0.5 ? g : -g;
        }
      }
      o[0] = 5 * this.dc.tick(s + blep.next());
    }
  },
};

export const fm = {
  type: 'fm', title: 'FM', category: 'source',
  description: 'Two-operator FM voice: ratio, index and modulator feedback, bells to bass',
  tags: ['oscillator', 'digital', 'operator', 'bell'],
  inputs: [
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
    { name: 'gate', label: 'GATE', kind: 'gate' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'tune', label: 'TUNE', min: -36, max: 36, default: 0, step: 1, size: 'L', format: fmtSt },
    { name: 'ratio', label: 'RATIO', min: 0.5, max: 12, default: 2, step: 0.25, format: fmtRatio },
    { name: 'index', label: 'INDEX', min: 0, max: 12, default: 2.5, cv: true },
    { name: 'feedback', label: 'FDBK', min: 0, max: 1, default: 0.15, format: fmtPct },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.5, format: fmtExp(0.02, 3) },
  ],
  dsp: class FM extends Module {
    constructor(sr) {
      super(sr);
      this.pc = 0;
      this.pm = 0;
      this.y1 = 0;
      this.y2 = 0;
      this.env = 0;
      this.amp = 0;
      this.keyV = NaN;
      this.keyRatio = NaN;
      this.keyDecay = NaN;
      this.incC = 0;
      this.incM = 0;
      this.top = 0;
      this.fbTop = 1;
      this.kEnv = 1;
      this.kAmp = 1;
      this.hold = 0;
      this.kAtk = 1 - Math.exp(-this.dt / 0.001);
      this.kRel = 1 - Math.exp(-this.dt / 0.03);
      this.gate = new Trigger();
    }
    tick(i, o, p) {
      const pitch = i[0], gate = i[1];
      const tune = p[0], ratio = p[1], index = p[2], feedback = p[3], decay = p[4];
      const v = pitch + tune / 12;
      if (v !== this.keyV || ratio !== this.keyRatio) {
        this.keyV = v;
        this.keyRatio = ratio;
        const c = Math.min(C4 * 2 ** v * this.dt, 0.45), m = Math.min(c * ratio, 0.45);
        this.incC = c;
        this.incM = m;
        // The n-th sideband folds back below 20 kHz. Past that the index is capped where
        // J_n(index) is 40 dB down: 2 (0.01 n!)^(1/n), which is close to a line in n.
        this.top = Math.max((0.74 * (0.58 - c)) / m - 1.54, 0);
        this.fbTop = clamp(1 - m / 0.25, 0, 1); // feedback makes a saw, and a saw needs room too
      }
      if (decay !== this.keyDecay) {
        this.keyDecay = decay;
        const s = expmap(decay, 0.02, 3);
        this.kEnv = Math.exp(-this.dt / s);
        this.kAmp = Math.exp(-this.dt / (s * 3));
      }
      // no gate cable, no envelope: a drone
      let env = 1, amp = 1;
      if (this.linked[1]) {
        if (this.gate.tick(gate)) {
          if (this.amp < 0.02) { this.pc = 0; this.pm = 0; } // key sync, unless it would click
          this.env = 1;
          this.hold = 1;
        }
        this.env = this.env * this.kEnv + DENORMAL;
        this.hold = this.hold * this.kAmp + DENORMAL;
        const target = this.gate.high ? this.hold : 0;
        this.amp += (target - this.amp) * (target > this.amp ? this.kAtk : this.kRel);
        env = this.env;
        amp = this.amp;
      }
      const pm = this.pm + this.incM, pc = this.pc + this.incC;
      this.pm = pm >= 1 ? pm - 1 : pm;
      this.pc = pc >= 1 ? pc - 1 : pc;
      // the average of two samples keeps it from hunting. y = sin(x + b y) is a saw at b = 1;
      // much past that it stops being a function of x and turns to noise, so the knob ends there
      const fb = 0.55 * feedback * this.fbTop * (this.y1 + this.y2);
      const m = Math.sin(TAU * this.pm + fb);
      this.y2 = this.y1;
      this.y1 = m;
      const dev = Math.min(index, this.top) * env;
      o[0] = 5 * amp * Math.sin(TAU * this.pc + dev * m);
    }
  },
};

export const wavetable = {
  type: 'wavetable', title: 'WAVETABLE', category: 'source',
  description: 'Morphing wavetables: analog, vowels, folds and sync, band-limited at every note',
  tags: ['oscillator', 'digital', 'morph', 'ppg'],
  inputs: [{ name: 'pitch', label: 'V/OCT', kind: 'pitch' }],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'tune', label: 'TUNE', min: -36, max: 36, default: 0, step: 1, size: 'L', format: fmtSt },
    { name: 'bank', label: 'BANK', type: 'select', options: ['ANLG', 'VOX', 'FOLD', 'SYNC'], default: 0 },
    { name: 'morph', label: 'MORPH', min: 0, max: 1, default: 0.42, size: 'L', cv: true, format: fmtPct },
  ],
  dsp: class Wavetable extends Module {
    constructor(sr) {
      super(sr);
      this.phase = 0;
      this.key = NaN;
      this.inc = 0;
      this.m0 = 0;
      this.m1 = 0;
      this.fade = 0;
    }
    tick(i, o, p) {
      const pitch = i[0];
      const tune = p[0], bank = p[1], morph = p[2];
      const v = pitch + tune / 12;
      if (v !== this.key) {
        this.key = v;
        const dt = Math.min(C4 * 2 ** v * this.dt, 0.45);
        this.inc = dt;
        // Mip m is on its own at the bottom of its octave and gone by the top, so its highest
        // harmonic sits at 0.29 sr and only reaches 0.58 sr, which folds to above 20 kHz, as it fades out.
        const x = clamp(Math.log2((dt * WT_TOP) / 0.29), 0, WT_MIPS - 1.001);
        this.m0 = x | 0;
        this.m1 = Math.min(this.m0 + 1, WT_MIPS - 1);
        this.fade = x - this.m0;
      }
      let t = this.phase + this.inc;
      if (t >= 1) t -= 1;
      this.phase = t;
      const f = clamp(morph, 0, 1) * (WT_FRAMES - 1), f0 = Math.min(f | 0, WT_FRAMES - 2), mix = f - f0;
      const m0 = this.m0, m1 = this.m1, fade = this.fade;
      const a0 = wtRead(bank, f0, m0, t), b0 = wtRead(bank, f0 + 1, m0, t);
      const a1 = wtRead(bank, f0, m1, t), b1 = wtRead(bank, f0 + 1, m1, t);
      const s0 = a0 + (b0 - a0) * mix, s1 = a1 + (b1 - a1) * mix;
      o[0] = 5 * (s0 + (s1 - s0) * fade);
    }
  },
};

export const noise = {
  type: 'noise', title: 'NOISE', category: 'source',
  description: 'White, pink and brown noise, plus crackle: sparse random impulses',
  tags: ['hiss', 'vinyl', 'random'],
  inputs: [],
  outputs: [
    { name: 'white', label: 'WHITE', kind: 'audio' },
    { name: 'pink', label: 'PINK', kind: 'audio' },
    { name: 'brown', label: 'BROWN', kind: 'audio' },
    { name: 'crackle', label: 'CRACKLE', kind: 'audio' },
  ],
  params: [
    { name: 'density', label: 'DENSITY', min: 0, max: 1, default: 0.45, size: 'L', format: (t) => `${expmap(t, 0.5, 300).toFixed(t > 0.6 ? 0 : 1)} /s` },
  ],
  dsp: class Noise extends Module {
    constructor(sr) {
      super(sr);
      this.rng = new Rng(9176);
      this.rngC = new Rng(31337);
      // pink: pole-zero pairs two octaves apart average out to -3 dB/oct (bilinear, so any sr)
      this.n = 0;
      this.b0 = new Float64Array(8); this.b1 = new Float64Array(8); this.a1 = new Float64Array(8);
      this.x1 = new Float64Array(8); this.y1 = new Float64Array(8);
      let f = 5;
      for (let k = 0; k < 8; k++, f *= 4) {
        const z = f * 2;
        if (z > 0.45 * sr) break;
        const wp = Math.tan((Math.PI * f) / sr), wz = Math.tan((Math.PI * z) / sr), d = 1 + wp;
        this.b0[k] = (1 + wz) / d;
        this.b1[k] = (wz - 1) / d;
        this.a1[k] = (wp - 1) / d;
        this.n = k + 1;
      }
      // Bilinear sections pin the gain at Nyquist, so level it where it counts: at 1 kHz, and
      // with white noise spreading thinner per Hz as sr rises
      const w1k = (TAU * 1000) / sr, cr = Math.cos(w1k), ci = Math.sin(w1k);
      let at1k = 1;
      for (let k = 0; k < this.n; k++) {
        at1k *= Math.hypot(this.b0[k] + this.b1[k] * cr, this.b1[k] * ci) / Math.hypot(1 + this.a1[k] * cr, this.a1[k] * ci);
      }
      this.pinkGain = (4.75 * Math.sqrt(sr / 48000)) / at1k;
      // brown: a leaky integrator from 8 Hz. var(y) = a G² var(w) / (2 - a), so G sets the RMS
      this.a = 1 - Math.exp((-TAU * 8) / sr);
      this.brownGain = 1.7 * Math.sqrt((3 * (2 - this.a)) / this.a);
      this.brown = 0;
      this.c = 0;
      this.cDecay = Math.exp(-this.dt / 0.00025);
      this.keyD = NaN;
      this.pHit = 0;
    }
    tick(i, o, p) {
      const density = p[0];
      if (density !== this.keyD) { this.keyD = density; this.pHit = expmap(density, 0.5, 300) * this.dt; }
      const w = this.rng.bipolar();
      o[0] = 5 * w;
      let y = w;
      const b0 = this.b0, b1 = this.b1, a1 = this.a1, x1 = this.x1, y1 = this.y1, n = this.n;
      for (let k = 0; k < n; k++) {
        const out = b0[k] * y + b1[k] * x1[k] - a1[k] * y1[k] + DENORMAL;
        x1[k] = y;
        y1[k] = out;
        y = out;
      }
      o[1] = this.pinkGain * y;
      this.brown += this.a * (this.brownGain * w - this.brown) + DENORMAL;
      o[2] = this.brown;
      this.c *= this.cDecay;
      if (this.rngC.next() < this.pHit) {
        const r = this.rngC.next(); // mostly ticks, the odd pop
        this.c += (this.rngC.next() < 0.5 ? -1 : 1) * (2.5 + 6.5 * r * r);
      }
      if (Math.abs(this.c) < 1e-12) this.c = 0;
      o[3] = this.c;
    }
  },
};

export const pluck = {
  type: 'pluck', title: 'PLUCK', category: 'source',
  description: 'Karplus-Strong plucked string, tuned to the cent across the keyboard',
  tags: ['oscillator', 'string', 'karplus', 'physical model'],
  inputs: [
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
    { name: 'trig', label: 'TRIG', kind: 'gate' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'tune', label: 'TUNE', min: -36, max: 36, default: 0, step: 1, size: 'L', format: fmtSt },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.55, format: fmtExp(0.1, 12) },
    { name: 'damp', label: 'DAMP', min: 0, max: 1, default: 0.4, format: fmtPct },
    { name: 'pick', label: 'PICK', min: 0.04, max: 0.5, default: 0.14, format: fmtPct },
    { name: 'hit', label: 'HIT', type: 'button' },
  ],
  dsp: class Pluck extends Module {
    constructor(sr) {
      super(sr);
      const n = Math.ceil(sr / 20) + 8;
      let size = 2;
      while (size < n) size *= 2;
      this.buf = new Float64Array(size);
      this.mask = size - 1;
      this.w = 0;
      this.grain = new Float64Array(8192);
      const rng = new Rng(6211);
      for (let k = 0; k < 8192; k++) this.grain[k] = rng.bipolar();
      this.rng = rng;
      this.period = 0;
      this.keyV = NaN; this.keyDecay = NaN; this.keyDamp = NaN;
      this.di = 0;
      this.c0 = 0; this.c1 = 1; this.c2 = 0; this.c3 = 0;
      this.g = 0;
      this.a = 1;
      this.s = 0;
      this.left = 0;
      this.at = 0;
      this.tap = 0;
      this.lp = 0;
      this.trig = new Trigger();
      this.hit = new Trigger();
      this.dc = new DCBlock(sr, 8);
    }
    // The loop is the delay plus a one-pole. The pole's delay at the fundamental is computed
    // exactly and taken off, which is the whole of the tuning.
    voice(hz, decay, damp) {
      const period = this.sr / clamp(hz, 20, this.sr / 7);
      this.period = period;
      const w = TAU / period;
      // DAMP is in harmonics, so it means the same at every note
      const a = 1 - Math.exp(-w * 120 * (1 / 15) ** damp), r = 1 - a;
      this.a = a;
      const re = 1 - r * Math.cos(w), im = r * Math.sin(w);
      const d = period - Math.atan2(im, re) / w;
      const whole = Math.floor(d), mu = d - whole + 1; // mu in 1..2: the flat middle of the Lagrange
      this.di = whole - 1;
      this.c0 = (-(mu - 1) * (mu - 2) * (mu - 3)) / 6;
      this.c1 = (mu * (mu - 2) * (mu - 3)) / 2;
      this.c2 = (-mu * (mu - 1) * (mu - 3)) / 2;
      this.c3 = (mu * (mu - 1) * (mu - 2)) / 6;
      // loop gain, so the fundamental takes `decay` to fall 60 dB. The pole can only lose: a dark
      // high note stops shorter than the knob says, as a real one does
      this.g = Math.min(10 ** ((-3 * period) / (this.sr * expmap(decay, 0.1, 12))) * (Math.hypot(re, im) / a), 0.99999);
    }
    tick(i, o, p) {
      const pitch = i[0], trig = i[1];
      const tune = p[0], decay = p[1], damp = p[2], pick = p[3], hit = p[4];
      const v = pitch + tune / 12;
      if (v !== this.keyV || decay !== this.keyDecay || damp !== this.keyDamp) {
        this.keyV = v; this.keyDecay = decay; this.keyDamp = damp;
        this.voice(C4 * 2 ** v, decay, damp);
      }
      const fired = this.trig.tick(trig), pressed = this.hit.tick(hit * 10);
      if (fired || pressed) {
        this.left = Math.ceil(this.period);
        this.at = (this.rng.next() * 8192) | 0;
        this.tap = Math.round(this.period * pick);
      }
      const buf = this.buf, mask = this.mask, r = this.w - this.di;
      const x = this.c0 * buf[r & mask] + this.c1 * buf[(r - 1) & mask] + this.c2 * buf[(r - 2) & mask] + this.c3 * buf[(r - 3) & mask];
      this.s += (x - this.s) * this.a + DENORMAL;
      const y = this.g * this.s;
      let e = 0;
      if (this.left > 0) {
        this.left--;
        const g = this.grain, n = this.at & 8191;
        e = 2.4 * (g[n] - g[(n - this.tap) & 8191]); // a comb: the pick's place on the string, and no DC
        this.at = n + 1;
      }
      const ea = 0.75 - 0.6 * damp;
      this.lp += (e - this.lp) * ea;
      const out = clamp(y + this.lp * Math.sqrt((2 - ea) / ea), -11, 11) + DENORMAL; // same level at any DAMP
      buf[this.w & mask] = out;
      this.w = (this.w + 1) & mask;
      o[0] = this.dc.tick(out);
    }
  },
};

export const source = [vco, supersaw, chord, fm, wavetable, noise, pluck];
