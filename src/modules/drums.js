// Analog drum voices. Each takes a trigger and an accent, and rests at no cost once its tail is gone.
import {
  Module, Trigger, Rng, OnePole, TAU, DENORMAL, HITS, clamp, expmap, tanh, fmtHz, fmtExp, fmtExpHz, fmtPct, fmtSt, fmtRatio,
  DrumSVF, DrumDeclick, DrumMetal, drumK, drumAccent,
} from './lib/index.js';

const TRIG = { name: 'trig', label: 'TRIG', kind: 'gate' };
const ACCENT = { name: 'accent', label: 'ACC', kind: 'cv' };
const OUT = [{ name: 'out', label: 'OUT', kind: 'audio' }];

export const kick = {
  type: 'kick', title: 'KICK', category: 'drum',
  description: 'Bass drum: fast pitch sweep, click and drive, or a long gentle boom',
  tags: ['bass drum', 'bd'],
  inputs: [TRIG, ACCENT, { name: 'pitch', label: 'V/OCT', kind: 'pitch' }],
  outputs: OUT,
  params: [
    { name: 'tune', label: 'TUNE', min: 35, max: 80, default: 50, format: fmtHz },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.52, cv: true, format: fmtExp(0.12, 1.5) },
    { name: 'attack', label: 'ATTACK', min: 0, max: 1, default: 0.5, format: fmtPct },
    { name: 'sweep', label: 'SWEEP', min: 1.5, max: 9, default: 5, format: fmtRatio },
    { name: 'drive', label: 'DRIVE', min: 0, max: 1, default: 0.25, format: fmtPct },
    { name: 'mode', label: 'MODE', type: 'select', options: ['PUNCH', 'BOOM'], default: 0 },
  ],
  dsp: class Kick extends Module {
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.rng = new Rng(9090);
      this.fix = new DrumDeclick(sr);
      this.clickLp = new OnePole(sr, 6000);
      this.clickK = drumK(0.007, sr);
      this.on = false;
      this.phase = 0; this.sw = 0; this.swK = 0; this.depth = 0;
      this.env = 0; this.click = 0; this.gain = 1;
      this.pv = NaN; this.tv = NaN; this.base = 0;
      this.dv = NaN; this.mv = NaN; this.k = 0;
      this.drv = NaN; this.g = 1; this.norm = 1;
    }
    hit(accent, attack, sweep, mode) {
      // 909: the time to within 10 % of the base is 40 ms at any depth. 808: slower, and shallower.
      this.depth = (sweep - 1) * (mode ? 0.3 : 1);
      const tau = mode ? 0.013 : 0.04 / Math.log(this.depth * 10);
      this.swK = Math.exp(-1 / (tau * this.sr));
      this.sw = 1;
      this.phase = 0;
      this.env = 1;
      this.click = attack * attack * (mode ? 1 : 3.2);
      this.rng.s = 9090; // the same click every hit: a kick that varies loses its punch
      this.gain = 1 + clamp(accent, 0, 10) * 0.05; // ahead of the drive and after it: 10 V is about +5 dB
      this.fix.arm();
      this.on = true;
    }
    tick(i, o, p) {
      const accent = i[1], pitch = i[2];
      const tune = p[0], decay = p[1], attack = p[2], sweep = p[3], drive = p[4], mode = p[5];
      if (this.trig.tick(i[0])) { this.ui[HITS]++; this.hit(accent, attack, sweep, mode); }
      if (!this.on) { o[0] = 0; return; }
      if (pitch !== this.pv || tune !== this.tv) {
        this.pv = pitch; this.tv = tune;
        this.base = tune * 2 ** clamp(pitch, -4, 4) * this.dt;
      }
      if (decay !== this.dv || mode !== this.mv) {
        this.dv = decay; this.mv = mode;
        this.k = drumK(expmap(decay, 0.12, 1.5) * (mode ? 3 : 1), this.sr);
      }
      if (drive !== this.drv) {
        this.drv = drive;
        this.g = expmap(drive, 0.6, 12);
        this.norm = 1 / tanh(this.g);
      }
      let t = this.phase + Math.min(this.base * (1 + this.depth * this.sw), 0.45);
      if (t >= 1) t -= 1;
      this.phase = t;
      this.sw *= this.swK;

      const click = this.clickLp.tick(this.click * (0.85 + 0.3 * this.rng.bipolar()));
      this.click = this.click * this.clickK + DENORMAL;
      const x = Math.sin(TAU * t) * this.env + click;
      this.env *= this.k;
      o[0] = this.fix.tick(6.5 * this.gain * this.norm * tanh(this.g * this.gain * x));
      if (this.env < 1e-5) { this.on = false; this.fix.clear(); o[0] = 0; }
    }
  },
};

export const snare = {
  type: 'snare', title: 'SNARE', category: 'drum',
  description: 'Snare drum: two tuned drum tones with a pitch drop, and a burst of noise',
  tags: ['sd'],
  inputs: [TRIG, ACCENT],
  outputs: OUT,
  params: [
    { name: 'tune', label: 'TUNE', min: -7, max: 7, default: 0, format: fmtSt },
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.5, format: fmtPct },
    { name: 'snappy', label: 'SNAPPY', min: 0, max: 1, default: 0.6, format: fmtPct },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.5, format: fmtExp(0.08, 0.6) },
  ],
  dsp: class Snare extends Module {
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.rng = new Rng(7171);
      this.fix = new DrumDeclick(sr);
      this.hp = new DrumSVF(sr, 1400);
      this.lp = new OnePole(sr, 7000);
      this.swK = Math.exp(-1 / (0.008 * sr));
      this.noiseGain = Math.sqrt(sr / 48000);
      this.on = false;
      this.ph1 = 0; this.ph2 = 0; this.sw = 0;
      this.e1 = 0; this.e2 = 0; this.en = 0; this.gain = 1;
      this.tv = NaN; this.inc = 1;
      this.dv = NaN; this.k1 = 0; this.k2 = 0; this.kn = 0;
      this.cv = NaN;
    }
    tick(i, o, p) {
      const tune = p[0], tone = p[1], snappy = p[2], decay = p[3];
      if (this.trig.tick(i[0])) {
        this.ui[HITS]++;
        this.ph1 = 0; this.ph2 = 0; this.sw = 1;
        this.e1 = 1; this.e2 = 1; this.en = 1;
        this.gain = drumAccent(i[1]);
        this.fix.arm();
        this.on = true;
      }
      if (!this.on) { o[0] = 0; return; }
      if (tune !== this.tv) { this.tv = tune; this.inc = 2 ** (tune / 12) * this.dt; }
      if (decay !== this.dv) {
        this.dv = decay;
        const t = expmap(decay, 0.08, 0.6);
        this.kn = drumK(t, this.sr);
        this.k1 = drumK(t * 0.6, this.sr);
        this.k2 = drumK(t * 0.38, this.sr);
      }
      if (tone !== this.cv) {
        this.cv = tone;
        this.hp.set(expmap(tone, 900, 2400), 0.707);
        this.lp.setHz(expmap(tone, 3500, 14000));
      }
      const drop = 1 + 0.7 * this.sw;
      this.sw *= this.swK;
      let t1 = this.ph1 + Math.min(180 * this.inc * drop, 0.45);
      if (t1 >= 1) t1 -= 1;
      this.ph1 = t1;
      let t2 = this.ph2 + Math.min(330 * this.inc * drop, 0.45);
      if (t2 >= 1) t2 -= 1;
      this.ph2 = t2;

      const body = Math.sin(TAU * t1) * this.e1 + 0.7 * Math.sin(TAU * t2) * this.e2;
      this.hp.tick(this.rng.bipolar());
      const noise = this.lp.tick(this.hp.hp) * this.en * snappy * 3 * this.noiseGain;
      this.e1 *= this.k1; this.e2 *= this.k2; this.en *= this.kn;
      o[0] = this.fix.tick(6 * this.gain * tanh(0.7 * (body + noise)));
      if (this.en < 1e-5 && this.e1 < 1e-5) { this.on = false; this.fix.clear(); o[0] = 0; }
    }
  },
};

export const hats = {
  type: 'hats', title: 'HATS', category: 'drum',
  description: 'Hi-hats: six square oscillators in a tight band; closed chokes open',
  tags: ['hi-hat', 'hihat', 'cymbal'],
  inputs: [{ name: 'closed', label: 'CLOSED', kind: 'gate' }, { name: 'open', label: 'OPEN', kind: 'gate' }, ACCENT],
  outputs: OUT,
  params: [
    { name: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, format: fmtSt },
    { name: 'decayC', label: 'DEC C', min: 0, max: 1, default: 0.5, format: fmtExp(0.02, 0.3) },
    { name: 'decayO', label: 'DEC O', min: 0, max: 1, default: 0.5, format: fmtExp(0.12, 1.4) },
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.5, format: fmtExpHz(7000, 12000) },
  ],
  dsp: class Hats extends Module {
    static HZ = [205.3, 304.4, 369.6, 522.7, 540, 800];
    constructor(sr) {
      super(sr);
      this.closed = new Trigger();
      this.open = new Trigger();
      this.metal = new DrumMetal(sr, Hats.HZ);
      this.bp = new DrumSVF(sr, 9000, 1);
      this.hp1 = new DrumSVF(sr, 6000);
      this.hp2 = new DrumSVF(sr, 6000);
      this.chokeK = drumK(0.01, sr); // a closed hit takes an open one down 60 dB in 10 ms
      this.level = 36 * (1 + 5 * (9000 / sr) ** 2); // PolyBLEP's rolloff at the band, at low sample rates
      this.on = false;
      this.envC = 0; this.envO = 0; this.choked = false;
      this.tv = NaN;
      this.dcv = NaN; this.kc = 0;
      this.dov = NaN; this.ko = 0;
      this.cv = NaN;
    }
    setBand(tone) {
      this.cv = tone;
      const hz = expmap(tone, 7000, 12000);
      this.bp.set(hz, 1);
      this.hp1.set(hz * 0.68, 0.707);
      this.hp2.set(hz * 0.68, 0.707);
    }
    // the filter never stops on a real machine: run it up to speed before the VCA opens
    wake() {
      if (this.on) return;
      this.metal.rewind(32);
      for (let n = 0; n < 32; n++) this.bp.tick(this.metal.tick());
      this.on = true;
    }
    tick(i, o, p) {
      const tune = p[0], decayC = p[1], decayO = p[2], tone = p[3];
      if (tune !== this.tv) { this.tv = tune; this.metal.retune(2 ** (tune / 12)); }
      if (tone !== this.cv) this.setBand(tone);
      if (this.closed.tick(i[0])) {
        this.ui[HITS]++;
        this.wake();
        this.envC = drumAccent(i[2]);
        this.choked = true;
      }
      if (this.open.tick(i[1])) { // after the closed: both on one sample is an open hit
        this.ui[HITS]++;
        this.wake();
        this.envO = drumAccent(i[2]);
        this.choked = false;
      }
      if (!this.on) { this.metal.idle(); o[0] = 0; return; }
      if (decayC !== this.dcv) { this.dcv = decayC; this.kc = drumK(expmap(decayC, 0.02, 0.3), this.sr); }
      if (decayO !== this.dov) { this.dov = decayO; this.ko = drumK(expmap(decayO, 0.12, 1.4), this.sr); }
      this.bp.tick(this.metal.tick());
      this.hp1.tick(this.bp.bp * (this.envC + this.envO));
      this.hp2.tick(this.hp1.hp);
      this.envC = this.envC * this.kc + DENORMAL;
      this.envO = this.envO * (this.choked ? this.chokeK : this.ko) + DENORMAL;
      o[0] = this.level * this.hp2.hp;
      if (this.envC + this.envO < 1e-5) { this.on = false; this.envC = 0; this.envO = 0; o[0] = 0; }
    }
  },
};

export const clap = {
  type: 'clap', title: 'CLAP', category: 'drum',
  description: 'Hand clap: a flutter of noise bursts, then a reverberant tail',
  tags: ['handclap', 'cp'],
  inputs: [TRIG, ACCENT],
  outputs: OUT,
  params: [
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.37, format: fmtExpHz(600, 2400) },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.5, format: fmtExp(0.08, 1) },
    { name: 'spread', label: 'SPREAD', min: 0, max: 1, default: 0.511, format: fmtExp(0.004, 0.024) },
  ],
  dsp: class Clap extends Module {
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.rng = new Rng(6060);
      this.bp = new DrumSVF(sr, 1000, 1.6);
      this.burstK = drumK(0.024, sr);
      this.on = false;
      this.burst = 0; this.tail = 0; this.gain = 1;
      this.left = 0; this.wait = 0;
      this.tv = NaN; this.level = 1;
      this.dv = NaN; this.tailK = 0;
    }
    tick(i, o, p) {
      const tone = p[0], decay = p[1], spread = p[2];
      if (this.trig.tick(i[0])) {
        this.ui[HITS]++;
        this.left = 4; // the fourth burst opens the tail
        this.wait = 0;
        this.gain = drumAccent(i[1]);
        this.on = true;
      }
      if (!this.on) { o[0] = 0; return; }
      if (tone !== this.tv) {
        this.tv = tone;
        const hz = expmap(tone, 600, 2400);
        this.bp.set(hz, 1.6);
        this.level = 3.2 * Math.sqrt((1.6 * this.sr) / hz); // white noise in a band of hz/Q
      }
      if (decay !== this.dv) { this.dv = decay; this.tailK = drumK(expmap(decay, 0.08, 1), this.sr); }
      if (this.left > 0 && --this.wait <= 0) {
        this.left--;
        if (this.left > 0) this.burst = this.gain;
        else this.tail = Math.max(this.tail, 0.75 * this.gain);
        this.wait = Math.round(expmap(spread, 0.004, 0.024) * this.sr);
      }
      this.bp.tick(this.rng.bipolar() * Math.max(this.burst, this.tail)); // a capacitor recharging: never a sum
      this.burst *= this.burstK;
      this.tail *= this.tailK;
      o[0] = this.level * this.bp.bp;
      if (this.left === 0 && this.tail + this.burst < 1e-5) { this.on = false; this.burst = 0; this.tail = 0; o[0] = 0; }
    }
  },
};

export const tom = {
  type: 'tom', title: 'TOM', category: 'drum',
  description: 'Tom or conga: a tuned drum with a pitch sweep and a hint of noise',
  tags: ['conga'],
  inputs: [TRIG, ACCENT],
  outputs: OUT,
  params: [
    { name: 'tune', label: 'TUNE', min: 0, max: 1, default: 0.42, format: fmtExpHz(60, 320) },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.5, format: fmtExp(0.12, 1.2) },
    { name: 'sweep', label: 'SWEEP', min: 1, max: 3, default: 1.6, format: fmtRatio },
    { name: 'mode', label: 'MODE', type: 'select', options: ['TOM', 'CONGA'], default: 0 },
  ],
  dsp: class Tom extends Module {
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.rng = new Rng(4242);
      this.fix = new DrumDeclick(sr);
      this.noiseLp = new OnePole(sr, 2400);
      this.noiseK = drumK(0.05, sr);
      this.noiseGain = Math.sqrt(sr / 48000);
      this.on = false;
      this.phase = 0; this.sw = 0; this.swK = 0; this.depth = 0;
      this.env = 0; this.noise = 0; this.gain = 1;
      this.tv = NaN; this.mv = NaN; this.base = 0;
      this.dv = NaN; this.k = 0;
    }
    tick(i, o, p) {
      const tune = p[0], decay = p[1], sweep = p[2], mode = p[3];
      if (this.trig.tick(i[0])) {
        this.depth = (sweep - 1) * (mode ? 0.5 : 1);
        this.swK = Math.exp(-1 / ((mode ? 0.012 : 0.03) * this.sr));
        this.sw = 1;
        this.phase = 0;
        this.env = 1;
        this.noise = mode ? 0 : 0.25;
        this.gain = drumAccent(i[1]);
        this.fix.arm();
        this.on = true;
      }
      if (!this.on) { o[0] = 0; return; }
      if (tune !== this.tv || mode !== this.mv) {
        this.tv = tune;
        this.base = expmap(tune, 60, 320) * (mode ? 1.9 : 1) * this.dt;
      }
      if (decay !== this.dv || mode !== this.mv) {
        this.dv = decay;
        this.k = drumK(expmap(decay, 0.12, 1.2) * (mode ? 0.4 : 1), this.sr);
      }
      this.mv = mode;
      let t = this.phase + Math.min(this.base * (1 + this.depth * this.sw), 0.45);
      if (t >= 1) t -= 1;
      this.phase = t;
      this.sw *= this.swK;
      const n = this.noiseLp.tick(this.rng.bipolar()) * this.noise * this.noiseGain;
      this.noise *= this.noiseK;
      const x = Math.sin(TAU * t) * this.env + n;
      this.env *= this.k;
      o[0] = this.fix.tick(5.5 * this.gain * tanh(1.1 * x) * 1.25);
      if (this.env < 1e-5) { this.on = false; this.fix.clear(); o[0] = 0; }
    }
  },
};

export const perc = {
  type: 'perc', title: 'PERC', category: 'drum',
  description: 'Small percussion: rimshot, cowbell, clave and shaker',
  tags: ['rimshot', 'cowbell', 'clave', 'shaker', 'maracas'],
  inputs: [TRIG, ACCENT],
  outputs: OUT,
  params: [
    { name: 'mode', label: 'MODE', type: 'select', options: ['RIM', 'BELL', 'CLAVE', 'SHAKE'], default: 1 },
    { name: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, format: fmtSt },
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.5, format: (v) => `${expmap(v, 0.35, 2.85).toFixed(2)} ×` },
  ],
  dsp: class Perc extends Module {
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.rng = new Rng(3131);
      this.fix = new DrumDeclick(sr);
      this.metal = new DrumMetal(sr, [540, 800]);
      this.bp = new DrumSVF(sr, 2000, 1);
      this.hp = new DrumSVF(sr, 5500);
      this.air = new OnePole(sr, 13000);
      this.attackK = drumK(0.012, sr);
      this.noiseGain = Math.sqrt(sr / 48000);
      this.on = false;
      this.m = 0;
      this.ph1 = 0; this.ph2 = 0;
      this.e1 = 0; this.e2 = 0; this.gain = 1; this.rise = 0;
      this.k1 = 0; this.k2 = 0;
      this.tv = NaN; this.ratio = 1;
      this.dv = NaN; this.mv = NaN;
    }
    tick(i, o, p) {
      const mode = p[0], tune = p[1], decay = p[2];
      if (tune !== this.tv) {
        this.tv = tune;
        this.ratio = 2 ** (tune / 12);
        this.metal.retune(this.ratio);
        this.bp.set(2000 * this.ratio, 1);
        this.hp.set(5500 * this.ratio, 0.707);
        this.air.setHz(13000 * this.ratio);
      }
      if (this.trig.tick(i[0])) {
        if (mode !== 1 || this.m !== 1) this.fix.arm(); // the bell's filter runs on, nothing is cut
        this.m = mode;
        this.ph1 = 0; this.ph2 = 0;
        this.e1 = 1; this.e2 = 1; this.rise = 1;
        this.gain = drumAccent(i[1]);
        this.on = true;
        this.mv = NaN;
      }
      if (!this.on) { this.metal.idle(); o[0] = 0; return; }
      const m = this.m;
      if (decay !== this.dv || m !== this.mv) {
        this.dv = decay; this.mv = m;
        const s = expmap(decay, 0.35, 2.85), sr = this.sr;
        if (m === 0) { this.k1 = drumK(0.045 * s, sr); this.k2 = drumK(0.03 * s, sr); }
        else if (m === 1) { this.k1 = drumK(0.05 * s, sr); this.k2 = drumK(0.42 * s, sr); }
        else if (m === 2) { this.k1 = drumK(0.06 * s, sr); this.k2 = this.k1; }
        else { this.k1 = drumK(0.11 * s, sr); this.k2 = this.k1; }
      }
      const r = this.ratio * this.dt;
      let y = 0;
      if (m === 0) { // two resonators, overdriven
        let t1 = this.ph1 + Math.min(1700 * r, 0.45);
        if (t1 >= 1) t1 -= 1;
        this.ph1 = t1;
        let t2 = this.ph2 + Math.min(460 * r, 0.45);
        if (t2 >= 1) t2 -= 1;
        this.ph2 = t2;
        y = 4.5 * tanh(1.6 * (Math.sin(TAU * t1) * this.e1 + 0.8 * Math.sin(TAU * t2) * this.e2));
      } else if (m === 1) { // two squares in a bandpass, a sharp hit over a slower ring
        this.bp.tick(this.metal.tick() * (0.65 * this.e1 + 0.35 * this.e2));
        y = 5.5 * this.bp.bp;
      } else if (m === 2) { // one resonator, high and short
        let t1 = this.ph1 + Math.min(2500 * r, 0.45);
        if (t1 >= 1) t1 -= 1;
        this.ph1 = t1;
        y = 5 * Math.sin(TAU * t1) * this.e1;
      } else { // noise in a high band that swells in
        this.rise *= this.attackK;
        this.hp.tick(this.rng.bipolar() * this.noiseGain);
        y = 8 * this.air.tick(this.hp.hp) * this.e1 * (1 - this.rise);
      }
      if (m !== 1) this.metal.idle();
      this.e1 *= this.k1;
      this.e2 *= this.k2;
      o[0] = this.fix.tick(y * this.gain);
      if (this.e1 < 1e-5 && this.e2 < 1e-5) { this.on = false; this.fix.clear(); o[0] = 0; }
    }
  },
};

export const ride = {
  type: 'ride', title: 'RIDE', category: 'drum',
  description: 'Long metal cymbal, ride or crash: high square partials and noise',
  tags: ['cymbal', 'crash'],
  inputs: [TRIG, ACCENT],
  outputs: OUT,
  params: [
    { name: 'decay', label: 'DECAY', min: 0, max: 1, default: 0.5, format: fmtExp(0.6, 5) },
    { name: 'tone', label: 'TONE', min: 0, max: 1, default: 0.5, format: fmtExpHz(5000, 11000) },
    { name: 'mode', label: 'MODE', type: 'select', options: ['RIDE', 'CRASH'], default: 0 },
  ],
  dsp: class Ride extends Module {
    static HZ = [486.5, 721.4, 876, 1238.8, 1279.8, 1896];
    constructor(sr) {
      super(sr);
      this.trig = new Trigger();
      this.rng = new Rng(1212);
      this.metal = new DrumMetal(sr, Ride.HZ);
      this.hi = new DrumSVF(sr, 7500, 0.8);
      this.lo = new DrumSVF(sr, 3400, 1.4);
      this.hp1 = new DrumSVF(sr, 2600);
      this.hp2 = new DrumSVF(sr, 2600);
      this.pingK = drumK(0.14, sr);
      this.noiseGain = Math.sqrt(sr / 48000);
      this.on = false;
      this.wash = 0; this.ping = 0; this.m = 0;
      this.dv = NaN; this.mv = NaN; this.k = 0;
      this.tv = NaN;
    }
    ring() {
      const sq = this.metal.tick();
      this.hi.tick(sq);
      this.lo.tick(sq);
    }
    tick(i, o, p) {
      const decay = p[0], tone = p[1], mode = p[2];
      if (tone !== this.tv) { this.tv = tone; this.hi.set(expmap(tone, 5000, 11000), 0.8); }
      if (this.trig.tick(i[0])) {
        this.ui[HITS]++;
        if (!this.on) { // as in the hats: the filters are up to speed before the VCA opens
          this.metal.rewind(64);
          for (let n = 0; n < 64; n++) this.ring();
        }
        this.m = mode;
        this.wash = drumAccent(i[1]);
        this.ping = this.wash;
        this.on = true;
      }
      if (!this.on) { this.metal.idle(); o[0] = 0; return; }
      const m = this.m;
      if (decay !== this.dv || m !== this.mv) {
        this.dv = decay; this.mv = m;
        this.k = drumK(expmap(decay, 0.6, 5) * (m ? 1.5 : 1), this.sr);
      }
      this.ring();
      const noise = this.rng.bipolar() * this.noiseGain * (m ? 0.11 : 0.035);
      this.hp1.tick((this.hi.bp + noise) * this.wash + this.lo.bp * this.ping * (m ? 0.25 : 0.7));
      this.hp2.tick(this.hp1.hp);
      this.wash *= this.k;
      this.ping *= this.pingK;
      o[0] = 10 * this.hp2.hp;
      if (this.wash < 1e-5) { this.on = false; this.wash = 0; this.ping = 0; o[0] = 0; }
    }
  },
};

export const drums = [kick, snare, hats, clap, tom, perc, ride];
