// Effects. Stereo in and out; an unpatched right input follows the left.
import {
  Module, TAU, OnePole, DCBlock, DelayLine, Trigger, clamp, expmap, tanh, vToHz,
  fmtExp, fmtExpHz, fmtDb, fmtPct, fmtRatio, fmtVHz,
  FxLine, FxRot, FxClock, FxBiquad, FxCross, FxCrossAllpass, FxAllpass, FxChirp, FxMix, fxKillGain, fxRail,
} from './lib/index.js';

const stereoIn = [{ name: 'inL', label: 'IN L', kind: 'audio' }, { name: 'inR', label: 'IN R', kind: 'audio' }];
const stereoOut = [{ name: 'outL', label: 'OUT L', kind: 'audio' }, { name: 'outR', label: 'OUT R', kind: 'audio' }];

export const delay = {
  type: 'delay', title: 'TAPE DELAY', category: 'fx',
  description: 'Stereo tape echo: saturating feedback, wow, ping-pong. Locks to 1/16 pulses on CLK',
  tags: ['echo', 'dub', 'ping-pong', 'feedback', 'clock'],
  inputs: [...stereoIn, { name: 'clk', label: 'CLK', kind: 'gate' }],
  outputs: stereoOut,
  params: [
    { name: 'time', label: 'TIME', min: 0, max: 1, default: 0.77, size: 'L', format: fmtExp(0.001, 2), cv: true },
    { name: 'feedback', label: 'FEEDBACK', min: 0, max: 1.2, default: 0.5, format: fmtPct, cv: true },
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.55 },
    { name: 'wow', label: 'WOW', min: 0, max: 1, default: 0.12 },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.3, format: fmtPct, cv: true },
    { name: 'mode', label: 'MODE', type: 'select', options: ['MONO', 'PING-PONG'], default: 1 },
    { name: 'div', label: 'DIV', type: 'select', options: ['1/16', '1/8', '1/8.', '1/4', '1/2'], default: 2 },
  ],
  dsp: class Tape extends Module {
    constructor(sr) {
      super(sr);
      this.max = 2 * sr;              // the longest echo
      const room = this.max + 0.01 * sr + 8;
      this.l = new FxLine(room);
      this.r = new FxLine(room);
      this.clock = new FxClock();
      this.d = -1;                    // head spacing in samples; −1 until the first tick
      this.glide = 1 - Math.exp(-1 / (0.1 * sr));
      this.kTime = -1; this.free = 0;
      this.kTone = -1;
      this.lpL = new OnePole(sr); this.lpR = new OnePole(sr);
      this.hpL = new OnePole(sr); this.hpR = new OnePole(sr);
      this.wowA = new FxRot(0.37, sr);
      this.wowB = new FxRot(0.83, sr);
      this.wowMax = 0.004 * sr;
      this.lag = 0;                   // what TONE delays a repeat by at 1 kHz, in samples
      this.mix = new FxMix();
    }
    static DIVS = [1, 2, 3, 4, 8];    // in clock pulses: one pulse is a 1/16
    tone(t) {
      const lp = expmap(t, 700, 16000), hp = expmap(t, 250, 40);
      this.kTone = t;
      this.lpL.setHz(lp); this.lpR.setHz(lp);
      this.hpL.setHz(hp); this.hpR.setHz(hp);
      // phase of (lowpass − lowpass) at 1 kHz: the delay the repeat head has to make up
      const w = TAU * 1000 * this.dt, cw = Math.cos(w), sw = Math.sin(w), a = this.lpL.a, b = this.hpL.a;
      const ar = 1 - (1 - a) * cw, ai = (1 - a) * sw, am = a / (ar * ar + ai * ai);
      const br = 1 - (1 - b) * cw, bi = (1 - b) * sw, bm = b / (br * br + bi * bi);
      this.lag = -Math.atan2(-ai * am + bi * bm, ar * am - br * bm) / w;
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL, fb = p[1], wow = p[3];
      this.mix.set(p[4]);
      if (p[0] !== this.kTime) { this.kTime = p[0]; this.free = expmap(p[0], 0.001, 2) * this.sr; }
      if (p[2] !== this.kTone) this.tone(p[2]);

      // a measured clock overrides TIME; TIME holds until there is one
      const clk = this.linked[2] ? this.clock.tick(i[2]) : 0;
      let want = clk > 0 ? clk * Tape.DIVS[p[6]] : this.free;
      while (want > this.max) want *= 0.5;
      if (want < 8) want = 8;

      // the motor: the heads glide, never so fast that the tape would play backwards
      let d = this.d;
      if (d < 0) d = want;
      else if (d !== want) {
        const v = clamp((want - d) * this.glide, -3, 0.75);
        d = Math.abs(want - d) < 1e-6 ? want : d + v;
      }
      this.d = d;

      this.wowA.tick(); this.wowB.tick();
      const depth = wow * Math.min(0.25 * d, this.wowMax);
      const dL = d + depth * (0.6 * this.wowA.s + 0.4 * this.wowB.s), dR = d + depth * (0.6 * this.wowA.c + 0.4 * this.wowB.c);
      const rL = this.l.hermite(dL), rR = this.r.hermite(dR);

      // the repeat head sits ahead of the output by TONE's own delay, so the loop stays D long
      const eL = dL - this.lag > 3 ? this.l.hermite(dL - this.lag) : this.l.hermite(3);
      const eR = dR - this.lag > 3 ? this.r.hermite(dR - this.lag) : this.r.hermite(3);
      // → TONE → record head; each repeat gets narrower
      const fL = this.lpL.tick(eL) - this.hpL.tick(eL), fR = this.lpR.tick(eR) - this.hpR.tick(eR);
      if (p[5] === 1) {
        this.l.write(7 * tanh((0.5 * (inL + inR) + fb * fR) / 7));
        this.r.write(7 * tanh((fb * fL) / 7));
      } else {
        this.l.write(7 * tanh((inL + fb * fL) / 7));
        this.r.write(7 * tanh((inR + fb * fR) / 7));
      }
      o[0] = inL * this.mix.dry + rL * this.mix.wet;
      o[1] = inR * this.mix.dry + rR * this.mix.wet;
    }
  },
};

export const reverb = {
  type: 'reverb', title: 'REVERB', category: 'fx',
  description: 'Dattorro plate: figure-of-eight tank, modulated diffusion, a wide smooth tail',
  tags: ['plate', 'space', 'dattorro'],
  inputs: stereoIn,
  outputs: stereoOut,
  params: [
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.4, size: 'L', format: fmtExp(0.5, 16), cv: true },
    { name: 'predelay', label: 'PREDELAY', min: 0, max: 1, default: 0.5, format: fmtExp(0.001, 0.25) },
    { name: 'damp', label: 'DAMP', min: 0, max: 1, default: 0.4 },
    { name: 'size', label: 'SIZE', min: 0, max: 1, default: 0.693 },  // 1.0: the published plate
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.25, format: fmtPct, cv: true },
  ],
  dsp: class Plate extends Module {
    constructor(sr) {
      super(sr);
      const f = sr / 29761, line = (n) => new FxLine(Math.ceil(n * f * Plate.BIG) + 64);
      this.f = f;
      this.pre = new DelayLine(0.25 * sr + 8);
      this.preD = -1;
      this.preA = 1 - Math.exp(-1 / (0.05 * sr));
      this.dc = new DCBlock(sr, 8);
      this.bw = new OnePole(sr, 10000);
      this.d0 = new FxAllpass(Math.round(142 * f));
      this.d1 = new FxAllpass(Math.round(107 * f));
      this.d2 = new FxAllpass(Math.round(379 * f));
      this.d3 = new FxAllpass(Math.round(277 * f));
      // the tank, named after the nodes in the paper
      this.a = line(672 + 32); this.b = line(4453); this.c = line(1800 + 16); this.d = line(3720);
      this.e = line(908 + 32); this.f4 = line(4217); this.g = line(2656 + 16); this.h = line(3163);
      this.dampL = 0; this.dampR = 0;
      this.damp = 0;
      this.gain = 0.5; this.dd1 = 0.7; this.dd2 = 0.5;
      this.lfo = new FxRot(1, sr);
      this.exc = 16 * f;
      // Beyond the paper: the two long allpasses drift as well, or modes sit where their group
      // delay peaks coincide and outlast the tail by 10 dB
      this.lfo2 = new FxRot(0.77, sr);
      this.exc2 = 6 * f;
      this.kDecay = -1; this.kDamp = -1; this.kSize = -1; this.ctl = 0;
      this.kPre = -1; this.preT = 0;
      // lengths and taps slide to new integer targets when SIZE moves; at rest every read is exact
      const n = Plate.LEN.length;
      this.cur = new Float64Array(n);
      this.tgt = new Float64Array(n);
      this.stp = new Float64Array(n);
      this.w = new Float64Array(n);   // output tap gains
      this.slide = 0;
      this.slideLen = Math.round(0.1 * sr);
      this.mix = new FxMix();
    }
    static BIG = 1.5;                 // largest SIZE
    // tank delays, then the output taps of Dattorro's table 2, at 29761 Hz
    static LEN = [672, 4453, 1800, 3720, 908, 4217, 2656, 3163,
      266, 2974, 1913, 1996, 1990, 187, 1066, 353, 3627, 1228, 2673, 2111, 335, 121];
    // how far into the tank each tap's line starts, for the first arrival
    static AHEAD = [908, 908, 5125, 7781, 672, 5125, 6925, 672, 672, 5125, 6925, 908, 5125, 7781];
    static LOOP = 21589;              // the whole figure of eight
    tune(decay, damp, size) {
      const rt = expmap(decay, 0.5, 16), hz = expmap(1 - damp, 1500, 18000), scale = expmap(size, 0.4, Plate.BIG);
      const loop = (Plate.LOOP * scale) / 29761;
      // four gains and two dampers go by per trip round the eight; DECAY is what 500 Hz does
      const trip = 10 ** ((-3 * loop) / rt) * (1 + (500 / hz) ** 2);
      this.gain = Math.min(0.9985, trip ** 0.25);
      this.dd2 = clamp(this.gain + 0.15, 0.25, 0.5);
      // 0.7 rings on its own for 19 trips of the allpass: a short DECAY has to loosen it
      this.dd1 = Math.min(0.7, 10 ** ((-3 * 908 * scale) / (29761 * rt)));
      this.damp = 1 - Math.exp((-TAU * hz) / this.sr);
      // the first pass reaches a tap with at most one decay gain behind it: weigh each tap down to
      // where the decay curve is at that moment, or a short DECAY ends in a loud first pass
      const m = Plate.LEN.length, slope = (-3 * Math.LN10 * scale) / (29761 * rt);
      for (let k = 8; k < m; k++) {
        const ahead = Plate.AHEAD[k - 8], curve = Math.exp(slope * (Plate.LEN[k] + ahead));
        this.w[k] = 0.6 * Math.min(1, ahead > 1000 ? curve / this.gain : curve);
      }
      if (size !== this.kSize) {
        const first = this.kSize < 0;
        for (let k = 0; k < m; k++) {
          this.tgt[k] = Math.max(1, Math.round(Plate.LEN[k] * this.f * scale));
          if (first) this.cur[k] = this.tgt[k];
          this.stp[k] = (this.tgt[k] - this.cur[k]) / this.slideLen;
        }
        this.slide = first ? 0 : this.slideLen;
      }
      this.kDecay = decay; this.kDamp = damp; this.kSize = size;
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL;
      this.mix.set(p[4]);
      if (this.ctl-- === 0) {         // a CV on DECAY costs 1/64 of a retune per sample
        this.ctl = 63;
        if (p[0] !== this.kDecay || p[2] !== this.kDamp || p[3] !== this.kSize) this.tune(p[0], p[2], p[3]);
      }
      const n = this.cur;
      if (this.slide > 0) {
        const m = n.length;
        if (--this.slide === 0) for (let k = 0; k < m; k++) n[k] = this.tgt[k];
        else for (let k = 0; k < m; k++) n[k] += this.stp[k];
      }

      // predelay, bandwidth, four input diffusers
      if (p[1] !== this.kPre) { this.kPre = p[1]; this.preT = Math.round(expmap(p[1], 0.001, 0.25) * this.sr); }
      const preT = this.preT;
      if (this.preD < 0) this.preD = preT;
      else if (this.preD !== preT) this.preD = Math.abs(preT - this.preD) < 1e-3 ? preT : this.preD + (preT - this.preD) * this.preA;
      const dry = this.pre.read(this.preD);
      this.pre.write(this.dc.tick(0.5 * (inL + inR)));
      let x = this.bw.tick(dry);
      x = this.d1.tick(this.d0.tick(x, 0.75), 0.75);
      x = this.d3.tick(this.d2.tick(x, 0.625), 0.625);

      // every read happens before any write, so tank delays are exactly their lengths
      this.lfo.tick(); this.lfo2.tick();
      const g = this.gain, dd1 = this.dd1, dd2 = this.dd2, da = this.damp;
      const za = this.a.hermite(n[0] + this.exc * this.lfo.s), zb = this.b.read(n[1]), zc = this.c.hermite(n[2] + this.exc2 * this.lfo2.s), zd = this.d.read(n[3]);
      const ze = this.e.hermite(n[4] + this.exc * this.lfo.c), zf = this.f4.read(n[5]), zg = this.g.hermite(n[6] + this.exc2 * this.lfo2.c), zh = this.h.read(n[7]);

      const w = this.w, b = this.b, c = this.c, d = this.d, f = this.f4, h = this.h, g2 = this.g;
      const outL = w[8] * f.read(n[8]) + w[9] * f.read(n[9]) - w[10] * g2.read(n[10]) + w[11] * h.read(n[11])
        - w[12] * b.read(n[12]) - w[13] * c.read(n[13]) - w[14] * d.read(n[14]);
      const outR = w[15] * b.read(n[15]) + w[16] * b.read(n[16]) - w[17] * c.read(n[17]) + w[18] * d.read(n[18])
        - w[19] * f.read(n[19]) - w[20] * g2.read(n[20]) - w[21] * h.read(n[21]);

      // left half: −dd1 allpass, delay, damper, gain, +dd2 allpass, delay, gain, over to the right
      const vl = x + g * zh + dd1 * za;
      this.a.write(vl);
      this.b.write(za - dd1 * vl);
      this.dampL += da * (zb - this.dampL);
      const wl = 40 * tanh((g * this.dampL) / 40) - dd2 * zc;
      this.c.write(wl);
      this.d.write(zc + dd2 * wl);

      const vr = x + g * zd + dd1 * ze;
      this.e.write(vr);
      this.f4.write(ze - dd1 * vr);
      this.dampR += da * (zf - this.dampR);
      const wr = 40 * tanh((g * this.dampR) / 40) - dd2 * zg;
      this.g.write(wr);
      this.h.write(zg + dd2 * wr);

      o[0] = inL * this.mix.dry + fxRail(outL) * this.mix.wet;
      o[1] = inR * this.mix.dry + fxRail(outR) * this.mix.wet;
    }
  },
};

export const spring = {
  type: 'spring', title: 'SPRING', category: 'fx',
  description: 'Spring tank: three springs and dispersive allpass chains. The boing of dub',
  tags: ['reverb', 'dub', 'boing', 'chirp'],
  inputs: stereoIn,
  outputs: stereoOut,
  params: [
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.45, size: 'L', format: fmtExp(0.5, 6), cv: true },
    { name: 'boing', label: 'BOING', min: 0, max: 1, default: 0.7 },
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.6 },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.3, format: fmtPct, cv: true },
  ],
  dsp: class Spring extends Module {
    constructor(sr) {
      super(sr);
      this.k = Math.max(2, Math.round(sr / 8000));   // stretch: the chirp tops out near 4 kHz
      const n = Spring.TD.length, fc = sr / (2 * this.k);
      this.chain = [];
      this.tail = [];
      this.line = [];
      this.lp0 = [];
      this.lp1 = [];
      this.damp = [];
      for (let s = 0; s < n; s++) {
        this.chain.push(new FxChirp(Spring.FIXED, this.k));
        this.tail.push(new FxChirp(Spring.BOING, this.k));
        this.line.push(new FxLine(Math.ceil(Spring.TD[s] * sr * 1.05) + 16));
        this.lp0.push(new FxBiquad().lowpass(fc * 0.9, 0.5412, sr));
        this.lp1.push(new FxBiquad().lowpass(fc * 0.9, 1.3066, sr));
        this.damp.push(new OnePole(sr, 4000));
      }
      this.hp = new FxBiquad().highpass(120, 0.7071, sr);
      this.fb = new Float64Array(n);
      this.gain = new Float64Array(n);
      this.lfo = new FxRot(0.67, sr);
      this.wob = 0.00012 * sr;
      this.kDecay = -1; this.kBoing = -1; this.kTone = -1; this.ctl = 0;
      this.mix = new FxMix();
    }
    // stages that always disperse, and stages BOING fades from dispersion into plain delay
    static FIXED = 40;
    static BOING = 60;
    static A = 0.62;
    static TD = [0.0331, 0.0397, 0.0451];            // transit times of the three springs, s
    stage(a, c) { return (this.k * (1 - a * a)) / (1 + 2 * a * c + a * a); }
    tune(decay, boing, tone) {
      const rt = expmap(decay, 0.5, 6), b = Spring.A * boing, hz = expmap(tone, 800, 9000), n = Spring.TD.length;
      // DECAY is what 500 Hz does: its delay through the chains, and what TONE takes from it each trip
      const c = Math.cos((TAU * 500 * this.k) * this.dt);
      const chain = (Spring.FIXED * this.stage(Spring.A, c) + Spring.BOING * this.stage(b, c)) * this.dt;
      const lift = Math.sqrt(1 + (500 / hz) ** 2);
      for (let s = 0; s < n; s++) {
        this.chain[s].a = Spring.A;
        this.tail[s].a = b;
        this.damp[s].setHz(hz);
        this.gain[s] = Math.min(0.985, lift * 10 ** ((-3 * (Spring.TD[s] + chain)) / rt));
      }
      this.kDecay = decay; this.kBoing = boing; this.kTone = tone;
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL;
      this.mix.set(p[3]);
      if (this.ctl-- === 0) {
        this.ctl = 63;
        if (p[0] !== this.kDecay || p[1] !== this.kBoing || p[2] !== this.kTone) this.tune(p[0], p[1], p[2]);
      }
      this.lfo.tick();
      const x = 6 * tanh(this.hp.tick(0.5 * (inL + inR)) / 6);
      const wob = this.wob * this.lfo.s, wob2 = this.wob * this.lfo.c;

      let y0 = 0, y1 = 0, y2 = 0;
      for (let s = 0; s < 3; s++) {
        const line = this.line[s];
        let y = line.hermite(Spring.TD[s] * this.sr + (s === 1 ? wob2 : wob));
        y = this.tail[s].tick(this.chain[s].tick(y));
        y = this.lp1[s].tick(this.lp0[s].tick(y));
        line.write(x + this.gain[s] * this.damp[s].tick(this.fb[s]));
        this.fb[s] = 6 * tanh(y / 6);
        if (s === 0) y0 = y; else if (s === 1) y1 = y; else y2 = y;
      }
      const wetL = y0 + 0.6 * y1 - 0.4 * y2, wetR = y2 - 0.6 * y1 + 0.4 * y0;
      o[0] = inL * this.mix.dry + fxRail(wetL) * this.mix.wet;
      o[1] = inR * this.mix.dry + fxRail(wetR) * this.mix.wet;
    }
  },
};

export const chorus = {
  type: 'chorus', title: 'CHORUS', category: 'fx',
  description: 'BBD stereo chorus, Juno flavour: modes 1, 2 and 1+2',
  tags: ['juno', 'bbd', 'ensemble', 'width'],
  inputs: stereoIn,
  outputs: stereoOut,
  params: [
    { name: 'mode', label: 'MODE', type: 'select', options: ['1', '2', '1+2'], default: 0 },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.5, format: fmtPct, cv: true },
  ],
  lights: [{ name: 'lfo', label: '', color: 'red' }],
  dsp: class Chorus extends Module {
    constructor(sr) {
      super(sr);
      const n = 0.007 * sr + 8;
      this.l = new FxLine(n); this.r = new FxLine(n);
      this.phase = 0;
      this.mid = -1; this.exc = 0;
      this.ease = 1 - Math.exp(-1 / (0.02 * sr));
      // anti-alias in front of the bucket brigade, reconstruction after it
      const lp = () => new FxBiquad().lowpass(10000, 0.7071, sr);
      this.preL = lp(); this.preR = lp(); this.postL = lp(); this.postR = lp();
      this.mix = new FxMix();
    }
    // triangle LFO in Hz, and the delay range it sweeps, in seconds
    static RATE = [0.513, 0.863, 9.75];
    static MIN = [0.00154, 0.00154, 0.00322];
    static MAX = [0.00515, 0.00515, 0.00356];
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL, mode = p[0];
      this.mix.set(p[1]);
      let ph = this.phase + Chorus.RATE[mode] * this.dt;
      if (ph >= 1) ph -= 1;
      this.phase = ph;
      const tri = 1 - 4 * Math.abs(ph - 0.5);    // −1 at phase 0, +1 at phase ½
      const midT = 0.5 * (Chorus.MIN[mode] + Chorus.MAX[mode]) * this.sr;
      const excT = 0.5 * (Chorus.MAX[mode] - Chorus.MIN[mode]) * this.sr;
      if (this.mid < 0) { this.mid = midT; this.exc = excT; }
      else { this.mid += (midT - this.mid) * this.ease; this.exc += (excT - this.exc) * this.ease; }

      const rL = this.postL.tick(this.l.hermite(this.mid + this.exc * tri));
      const rR = this.postR.tick(this.r.hermite(this.mid - this.exc * tri));
      this.l.write(7 * tanh(this.preL.tick(inL) / 7));
      this.r.write(7 * tanh(this.preR.tick(inR) / 7));
      o[0] = inL * this.mix.dry + rL * this.mix.wet;
      o[1] = inR * this.mix.dry + rR * this.mix.wet;
      this.ui[0] = 0.5 + 0.5 * tri;
    }
  },
};

export const phaser = {
  type: 'phaser', title: 'PHASER', category: 'fx',
  description: '4, 6 or 12 allpass stages, feedback, and an LFO that spreads across the stereo field',
  tags: ['allpass', 'sweep', 'notch'],
  inputs: stereoIn,
  outputs: stereoOut,
  params: [
    { name: 'stages', label: 'STAGES', type: 'select', options: ['4', '6', '12'], default: 1 },
    { name: 'center', label: 'CENTER', min: -2, max: 4, default: 1.5, format: fmtVHz, cv: true },
    { name: 'rate', label: 'RATE', min: 0, max: 1, default: 0.3, format: fmtExpHz(0.02, 8), cv: true },
    { name: 'depth', label: 'DEPTH', min: 0, max: 1, default: 0.7 },
    { name: 'feedback', label: 'FEEDBACK', min: -0.9, max: 0.9, default: 0.25, format: fmtPct, cv: true },
    { name: 'spread', label: 'SPREAD', min: 0, max: 1, default: 0.5, format: fmtPct },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.45, format: fmtPct, cv: true },
  ],
  dsp: class Phaser extends Module {
    constructor(sr) {
      super(sr);
      this.zL = new Float64Array(12); this.zR = new Float64Array(12);
      this.aL = 0; this.aR = 0; this.daL = 0; this.daR = 0;
      this.yL = 0; this.yR = 0;
      this.phase = 0;
      this.left = 0;
      this.first = true;
      this.mix = new FxMix();
    }
    static STAGES = [4, 6, 12];
    static BLOCK = 16;                // the LFO and the coefficients run this much slower
    coef(hz) {
      const t = Math.tan((Math.PI * clamp(hz, 5, this.sr * 0.45)) * this.dt);
      return (t - 1) / (t + 1);
    }
    control(center, rate, depth, spread) {
      const B = Phaser.BLOCK;
      this.phase += expmap(rate, 0.02, 8) * this.dt * B;
      if (this.phase >= 1) this.phase -= 1;
      const f0 = vToHz(center), oct = 2 * depth;
      const tL = this.coef(f0 * 2 ** (oct * Math.sin(TAU * this.phase)));
      const tR = this.coef(f0 * 2 ** (oct * Math.sin(TAU * this.phase + Math.PI * spread)));
      if (this.first) { this.first = false; this.aL = tL; this.aR = tR; }
      this.daL = (tL - this.aL) / B; this.daR = (tR - this.aR) / B;
      this.left = B;
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL, n = Phaser.STAGES[p[0]], fb = p[4];
      this.mix.set(p[6]);
      if (this.left === 0) this.control(p[1], p[2], p[3], p[5]);
      this.left--;
      const aL = (this.aL += this.daL), aR = (this.aR += this.daR), zL = this.zL, zR = this.zR;
      let l = inL + fb * this.yL, r = inR + fb * this.yR;
      for (let k = 0; k < n; k++) {
        const yl = aL * l + zL[k];
        zL[k] = l - aL * yl;
        l = yl;
        const yr = aR * r + zR[k];
        zR[k] = r - aR * yr;
        r = yr;
      }
      this.yL = 7 * tanh(l / 7);
      this.yR = 7 * tanh(r / 7);
      o[0] = inL * this.mix.dry + fxRail(l) * this.mix.wet;
      o[1] = inR * this.mix.dry + fxRail(r) * this.mix.wet;
    }
  },
};

export const flanger = {
  type: 'flanger', title: 'FLANGER', category: 'fx',
  description: 'Short modulated delay in stereo quadrature, with positive or negative feedback',
  tags: ['comb', 'jet', 'sweep'],
  inputs: stereoIn,
  outputs: stereoOut,
  params: [
    { name: 'time', label: 'TIME', min: 0, max: 1, default: 0.45, format: fmtExp(0.0005, 0.012), cv: true },
    { name: 'depth', label: 'DEPTH', min: 0, max: 1, default: 0.7 },
    { name: 'rate', label: 'RATE', min: 0, max: 1, default: 0.3, format: fmtExpHz(0.02, 5), cv: true },
    { name: 'feedback', label: 'FEEDBACK', min: -0.95, max: 0.95, default: 0.5, format: fmtPct, cv: true },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 0.5, format: fmtPct, cv: true },
  ],
  dsp: class Flanger extends Module {
    constructor(sr) {
      super(sr);
      const n = 0.012 * 1.9 * sr + 8;
      this.l = new FxLine(n); this.r = new FxLine(n);
      this.lfo = new FxRot(0.2, sr);
      this.base = -1;
      this.ease = 1 - Math.exp(-1 / (0.05 * sr));
      this.kRate = -1;
      this.kTime = -1; this.want = 0;
      this.mix = new FxMix();
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL, depth = 0.85 * p[1], fb = p[3];
      this.mix.set(p[4]);
      if (p[2] !== this.kRate) { this.kRate = p[2]; this.lfo.setHz(expmap(p[2], 0.02, 5)); }
      if (p[0] !== this.kTime) { this.kTime = p[0]; this.want = expmap(p[0], 0.0005, 0.012) * this.sr; }
      this.base = this.base < 0 ? this.want : this.base + (this.want - this.base) * this.ease;
      this.lfo.tick();
      const dL = this.base * (1 + depth * this.lfo.s), dR = this.base * (1 + depth * this.lfo.c);
      const rL = this.l.hermite(dL < 3 ? 3 : dL), rR = this.r.hermite(dR < 3 ? 3 : dR);
      this.l.write(7 * tanh((inL + fb * rL) / 7));
      this.r.write(7 * tanh((inR + fb * rR) / 7));
      o[0] = inL * this.mix.dry + fxRail(rL) * this.mix.wet;
      o[1] = inR * this.mix.dry + fxRail(rR) * this.mix.wet;
    }
  },
};

export const comp = {
  type: 'comp', title: 'COMPRESSOR', category: 'fx',
  description: 'Stereo bus compressor with soft knee. SIDE keys it from outside: how a kick ducks the bass',
  tags: ['dynamics', 'sidechain', 'ducking', 'glue', 'pump'],
  inputs: [...stereoIn, { name: 'side', label: 'SIDE', kind: 'audio' }],
  outputs: stereoOut,
  params: [
    { name: 'thresh', label: 'THRESH', min: -40, max: 0, default: -14, size: 'L', format: fmtDb, cv: true },
    { name: 'ratio', label: 'RATIO', min: 1, max: 20, default: 3, format: fmtRatio },
    { name: 'attack', label: 'ATTACK', min: 0, max: 1, default: 0.6, format: fmtExp(0.0001, 0.1) },
    { name: 'release', label: 'RELEASE', min: 0, max: 1, default: 0.45, format: fmtExp(0.01, 2) },
    { name: 'makeup', label: 'MAKEUP', min: 0, max: 24, default: 3, format: fmtDb },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 1, format: fmtPct, cv: true },
  ],
  lights: [{ name: 'gr', label: 'GR', color: 'red' }],
  dsp: class Comp extends Module {
    constructor(sr) {
      super(sr);
      this.peak = 0;                  // gain reduction before and after the attack, in dB
      this.gr = 0;
      this.kAtk = -1; this.kRel = -1; this.kMake = NaN; this.kThresh = NaN;
      this.atk = 0; this.rel = 0; this.make = 1; this.floor = 0;
    }
    static KNEE = 6;                  // dB, centred on the threshold
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL, T = p[0], ratio = p[1], mix = p[5];
      if (p[2] !== this.kAtk) { this.kAtk = p[2]; this.atk = 1 - Math.exp(-this.dt / expmap(p[2], 0.0001, 0.1)); }
      if (p[3] !== this.kRel) { this.kRel = p[3]; this.rel = Math.exp(-this.dt / expmap(p[3], 0.01, 2)); }
      if (p[4] !== this.kMake) { this.kMake = p[4]; this.make = 10 ** (p[4] / 20); }
      // below this the knee hasn't started, and the log isn't worth taking
      if (T !== this.kThresh) { this.kThresh = T; this.floor = 10 * 10 ** ((T - Comp.KNEE / 2) / 20); }

      // level: peak of the key, 0 dB = 10 V (full scale at the master)
      const aL = Math.abs(inL), aR = Math.abs(inR);
      const key = this.linked[2] ? Math.abs(i[2]) : aL > aR ? aL : aR;
      let want = 0;
      if (key > this.floor) {
        const over = 20 * Math.log10(key * 0.1) - T, W = Comp.KNEE, s = 1 - 1 / ratio;
        want = over >= W / 2 ? s * over : (s * (over + W / 2) * (over + W / 2)) / (2 * W);
      }
      // smooth, decoupled detector (Giannoulis et al. 2012): release in dB, attack after it
      const r = this.rel * this.peak + (1 - this.rel) * want;
      this.peak = want > r ? want : r;
      this.gr += this.atk * (this.peak - this.gr);

      const g = Math.exp(-0.11512925464970229 * this.gr) * this.make;
      o[0] = inL + (g * inL - inL) * mix;
      o[1] = inR + (g * inR - inR) * mix;
      this.ui[0] = clamp(this.gr / 20, 0, 1);
    }
  },
};

const fmtEq = (v) => (v <= -1 ? '-inf dB' : fmtDb(20 * Math.log10(fxKillGain(v))));

export const eq3 = {
  type: 'eq3', title: 'EQ3', category: 'fx',
  description: 'DJ isolator: three Linkwitz-Riley bands that kill to silence and boost to +6 dB',
  tags: ['equalizer', 'kill', 'isolator', 'dj', 'tone'],
  inputs: stereoIn,
  outputs: stereoOut,
  params: [
    { name: 'low', label: 'LOW', min: -1, max: 1, default: 0, size: 'L', format: fmtEq, cv: true },
    { name: 'mid', label: 'MID', min: -1, max: 1, default: 0, size: 'L', format: fmtEq, cv: true },
    { name: 'high', label: 'HIGH', min: -1, max: 1, default: 0, size: 'L', format: fmtEq, cv: true },
  ],
  dsp: class EQ3 extends Module {
    constructor(sr) {
      super(sr);
      this.lowL = new FxCross(250, sr); this.lowR = new FxCross(250, sr);
      this.topL = new FxCross(2500, sr); this.topR = new FxCross(2500, sr);
      this.apL = new FxCrossAllpass(2500, sr); this.apR = new FxCrossAllpass(2500, sr);
      this.gLo = -1; this.gMi = 0; this.gHi = 0;
      this.ease = 1 - Math.exp(-1 / (0.004 * sr));
      this.kLo = NaN; this.kMi = NaN; this.kHi = NaN;
      this.tLo = 1; this.tMi = 1; this.tHi = 1;
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL;
      if (p[0] !== this.kLo) { this.kLo = p[0]; this.tLo = fxKillGain(p[0]); }
      if (p[1] !== this.kMi) { this.kMi = p[1]; this.tMi = fxKillGain(p[1]); }
      if (p[2] !== this.kHi) { this.kHi = p[2]; this.tHi = fxKillGain(p[2]); }
      if (this.gLo < 0) { this.gLo = this.tLo; this.gMi = this.tMi; this.gHi = this.tHi; }
      const e = this.ease;
      this.gLo += (this.tLo - this.gLo) * e;
      this.gMi += (this.tMi - this.gMi) * e;
      this.gHi += (this.tHi - this.gHi) * e;

      const xl = this.lowL, xr = this.lowR, tl = this.topL, tr = this.topR;
      xl.tick(inL); xr.tick(inR);
      tl.tick(xl.hi); tr.tick(xr.hi);
      o[0] = this.gLo * this.apL.tick(xl.lo) + this.gMi * tl.lo + this.gHi * tl.hi;
      o[1] = this.gLo * this.apR.tick(xr.lo) + this.gMi * tr.lo + this.gHi * tr.hi;
    }
  },
};

export const stutter = {
  type: 'stutter', title: 'STUTTER', category: 'fx',
  description: 'Beat repeat: while GATE is high it loops the slice that started at the gate. 1/16 pulses on CLK',
  tags: ['glitch', 'roll', 'repeat', 'buffer', 'clock'],
  inputs: [...stereoIn, { name: 'gate', label: 'GATE', kind: 'gate' }, { name: 'clk', label: 'CLK', kind: 'gate' }],
  outputs: stereoOut,
  params: [
    { name: 'div', label: 'DIV', type: 'select', options: ['1/4', '1/8', '1/16', '1/32'], default: 2, cv: true },
    { name: 'mix', label: 'MIX', min: 0, max: 1, default: 1, format: fmtPct, cv: true },
  ],
  lights: [{ name: 'loop', label: 'LOOP', color: 'red' }],
  dsp: class Stutter extends Module {
    constructor(sr) {
      super(sr);
      this.l = new DelayLine(4 * sr); this.r = new DelayLine(4 * sr);
      this.max = this.l.buf.length >> 1;
      this.clock = new FxClock();
      this.gate = new Trigger();
      this.active = false;
      this.start = 0;                 // where the slice begins in the ring
      this.len = 1;                   // loop length in samples
      this.cap = 0;                   // how much of it has been recorded
      this.q = 0;                     // playback position in the slice
      this.amt = 0;                   // 1 while looping, fades to 0 after the gate falls
      this.div = -1;
      this.fadeMax = Math.round(0.005 * sr);
      this.fade = this.fadeMax;
      this.step = 1 / this.fadeMax;
      this.pulse = 0.125 * sr;        // a 1/16 at 120 BPM until a clock has been measured
    }
    static DIVS = [4, 2, 1, 0.5];     // in clock pulses: one pulse is a 1/16
    size(div) {
      const per = this.clock.period > 0 ? this.clock.period : this.pulse;
      let n = per * Stutter.DIVS[div];
      while (n > this.max) n *= 0.5;
      return Math.max(32, Math.round(n));
    }
    setLen(n) {
      this.len = n;
      this.fade = Math.min(this.fadeMax, n >> 2);
      if (this.q >= n) this.q %= n;
    }
    tick(i, o, p) {
      const inL = i[0], inR = this.linked[1] ? i[1] : inL, div = p[0], mix = p[1];
      if (this.linked[3]) this.clock.tick(i[3]);
      this.gate.tick(i[2]);
      const held = this.gate.high, L = this.l, R = this.r, m = L.mask;

      if (held && !this.active && this.amt === 0) {
        this.active = true;
        this.start = L.w;
        this.cap = 0;
        this.q = 0;
        this.amt = 1;
        this.div = div;
        this.setLen(this.size(div));
      } else if (this.active) {
        if (!held) this.active = false;
        else if (div !== this.div) {
          // a new DIV mid-roll: shorter always works, longer only as far as it was recorded
          this.div = div;
          const n = this.size(div);
          this.setLen(this.cap < this.len ? n : Math.min(n, this.cap));
        }
      }

      // the tape runs until the slice is complete, then holds it for as long as the gate does
      if (!this.active || this.cap < this.len) {
        L.write(inL); R.write(inR);
        if (this.active) this.cap++;
      }

      let outL = inL, outR = inR;
      if (this.amt > 0) {
        const q = this.q, len = this.len, a = (this.start + q) & m;
        let wetL = L.buf[a], wetR = R.buf[a];
        const t = q - (len - this.fade);
        if (t >= 0) {
          // the last moments fade into what came just before the slice, which arrives on its first sample
          const b = (this.start + q - len) & m, u = 0.5 - 0.5 * Math.cos((Math.PI * (t + 1)) / (this.fade + 1));
          wetL += (L.buf[b] - wetL) * u;
          wetR += (R.buf[b] - wetR) * u;
        }
        this.q = q + 1 >= len ? 0 : q + 1;
        const k = this.amt * mix;
        outL = inL + (wetL - inL) * k;
        outR = inR + (wetR - inR) * k;
        if (!this.active) {
          this.amt -= this.step;
          if (this.amt < 0) this.amt = 0;
        }
      }
      o[0] = outL;
      o[1] = outR;
      this.ui[0] = this.active ? 1 : 0;
    }
  },
};

export const fx = [delay, reverb, spring, chorus, phaser, flanger, comp, eq3, stutter];
