// Sound coming in from outside: files, the microphone, MIDI.
import { Module, Trigger, Pulse, Rng, DCBlock, TAU, clamp, expmap, fmtExp, fmtPct, fmtSt, PLUGIN_BLOCK, PLUGIN_FRAME, PLUGIN_HEAD, PLUGIN_NOTES } from './lib/index.js';

export const deck = {
  type: 'deck', title: 'TRACK DECK', category: 'io', theme: 'black',
  description: 'Plays a dropped audio file. Its analysed beat grid drives a clock, so the wall locks to the track',
  tags: ['sample', 'player', 'track', 'audio file', 'beat', 'loop'],
  inputs: [
    { name: 'trig', label: 'RESTART', kind: 'gate' },
    { name: 'speed', label: 'SPEED', kind: 'cv' },
  ],
  outputs: [
    { name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' },
    { name: 's16', label: '1/16', kind: 'gate' }, { name: 'bar', label: 'BAR', kind: 'gate' },
    { name: 'kick', label: 'KICK', kind: 'gate' },
  ],
  params: [
    { name: 'rate', label: 'SPEED', min: -2, max: 2, default: 1, format: (v) => `${v.toFixed(2)} ×` },
    { name: 'gain', label: 'GAIN', min: 0, max: 2, default: 1, format: fmtPct },
    { name: 'loop', label: 'LOOP', type: 'toggle', default: 1 },
    { name: 'play', label: 'PLAY', type: 'toggle', default: 1 },
  ],
  widgets: [{ ui: 'waveform', w: 200, h: 70 }],
  dsp: class Deck extends Module {
    constructor(sr) {
      super(sr);
      this.L = null; this.R = null;
      this.pos = 0;
      this.ratio = 1;
      this.trig = new Trigger();
      this.grid = null; this.kicks = null; this.g = 0; this.c = 0;
      this.p16 = new Pulse(sr, 2); this.pBar = new Pulse(sr, 2); this.pKick = new Pulse(sr, 2);
    }
    onMessage(m) {
      if (m.kind === 'clear') { this.L = null; this.R = null; this.grid = null; this.kicks = null; return; }
      if (m.kind !== 'buffer') return;
      this.L = m.L; this.R = m.R ?? m.L;
      this.ratio = m.sr / this.sr;
      this.grid = m.grid ?? null;   // Float64Array of sixteenth times, seconds; every 16th a bar
      this.kicks = m.kicks ?? null;
      this.pos = 0; this.g = 0; this.c = 0;
    }
    tick(i, o, p) {
      const L = this.L;
      if (L === null) { o[0] = 0; o[1] = 0; o[2] = this.p16.tick(); o[3] = this.pBar.tick(); o[4] = this.pKick.tick(); return; }
      if (this.trig.tick(i[0])) { this.pos = 0; this.g = 0; this.c = 0; }
      const n = L.length;
      const k = Math.floor(this.pos), f = this.pos - k;
      if (p[3] > 0.5 && this.rack.running && k >= 0 && k + 1 < n) {
        o[0] = (L[k] + (L[k + 1] - L[k]) * f) * 5 * p[1];
        o[1] = (this.R[k] + (this.R[k + 1] - this.R[k]) * f) * 5 * p[1];
        const t = this.pos / (this.ratio * this.sr);
        const grid = this.grid;
        if (grid !== null) {
          while (this.g < grid.length && grid[this.g] <= t) {
            this.p16.fire();
            if (this.g % 16 === 0) this.pBar.fire();
            this.g++;
          }
        }
        const kicks = this.kicks;
        if (kicks !== null) {
          while (this.c < kicks.length && kicks[this.c] <= t) { this.pKick.fire(); this.c++; }
        }
        this.pos += (p[0] + i[1] * 0.1) * this.ratio;
      } else {
        o[0] = 0; o[1] = 0;
        if (p[3] > 0.5 && this.rack.running) {
          if (p[2] > 0.5) { this.pos = this.pos < 0 ? n - 2 : 0; this.g = 0; this.c = 0; }
        }
      }
      o[2] = this.p16.tick();
      o[3] = this.pBar.tick();
      o[4] = this.pKick.tick();
      this.ui[0] = n ? this.pos / n : 0;
    }
  },
};

export const sampler = {
  type: 'sampler', title: 'SAMPLER', category: 'io', theme: 'black',
  description: 'One-shot sampler: drop a file on it, then trigger and pitch it from cables',
  tags: ['sample', 'one shot', 'chop', 'stab'],
  inputs: [
    { name: 'trig', label: 'TRIG', kind: 'gate' },
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
  ],
  outputs: [{ name: 'out', label: 'OUT', kind: 'audio' }],
  params: [
    { name: 'tune', label: 'TUNE', min: -24, max: 24, default: 0, step: 1, format: fmtSt },
    { name: 'start', label: 'START', min: 0, max: 1, default: 0, format: fmtPct, cv: true },
    { name: 'len', label: 'LENGTH', min: 0, max: 1, default: 1, format: fmtPct, cv: true },
    { name: 'fade', label: 'FADE', min: 0, max: 1, default: 0.2, format: fmtExp(0.0005, 0.2) },
  ],
  widgets: [{ ui: 'waveform', w: 150, h: 60 }],
  dsp: class Sampler extends Module {
    constructor(sr) {
      super(sr);
      this.L = null;
      this.pos = -1;
      this.end = 0;
      this.ratio = 1;
      this.amp = 0; this.fadeIn = 0;
      this.trig = new Trigger();
    }
    onMessage(m) {
      if (m.kind === 'clear') { this.L = null; this.pos = -1; return; }
      if (m.kind !== 'buffer') return;
      this.L = m.L;
      this.ratio = m.sr / this.sr;
      this.pos = -1;
    }
    tick(i, o, p) {
      const L = this.L;
      if (L === null) { o[0] = 0; return; }
      const n = L.length;
      if (this.trig.tick(i[0])) {
        this.pos = p[1] * (n - 2);
        this.end = Math.min(n - 2, this.pos + p[2] * (n - 2));
        this.amp = 0;
      }
      if (this.pos < 0) { o[0] = 0; return; }
      const k = Math.floor(this.pos), f = this.pos - k;
      const fade = expmap(p[3], 0.0005, 0.2);
      const left = (this.end - this.pos) / (this.ratio * this.sr);
      const env = Math.min(1, left / fade);
      this.amp = Math.min(1, this.amp + this.dt / 0.0005);
      o[0] = (L[k] + (L[k + 1] - L[k]) * f) * 5 * this.amp * env;
      this.pos += this.ratio * 2 ** (i[1] + p[0] / 12);
      if (this.pos >= this.end) this.pos = -1;
      this.ui[0] = this.pos / n;
    }
  },
};

export const slicer = {
  type: 'slicer', title: 'SLICER', category: 'io', theme: 'black',
  description: 'Cuts a dropped track into slices on its beat and replays eight of them from a step pattern, in time with the clock',
  tags: ['sample', 'chop', 'loop', 'break', 'remix', 'stem'],
  inputs: [
    { name: 'clk', label: 'CLK', kind: 'gate' },
    { name: 'rst', label: 'RST', kind: 'gate' },
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
  ],
  outputs: [
    { name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' },
    { name: 'kick', label: 'KICK', kind: 'gate' },
  ],
  params: [
    { name: 'length', label: 'STEPS', min: 1, max: 64, default: 16, step: 1, size: 'S' },
    { name: 'gatelen', label: 'GATE', min: 0.05, max: 1, default: 1, format: fmtPct, size: 'S', cv: true },
    { name: 'tune', label: 'TUNE', min: -12, max: 12, default: 0, step: 1, format: fmtSt, size: 'S', cv: true },
    { name: 'chop', label: 'CHOP', min: 0, max: 1, default: 0, format: fmtPct, size: 'S', cv: true },
    { name: 'gain', label: 'GAIN', min: 0, max: 4, default: 1, format: fmtPct, size: 'S' },
  ],
  widgets: [{ ui: 'waveform', w: 470, h: 56, stems: true }, { ui: 'slicegrid', w: 470, h: 152 }],
  defaultData: () => ({ pool: [], pads: new Array(8).fill(0), steps: new Array(16).fill(-1) }),
  dsp: class Slicer extends Module {
    constructor(sr) {
      super(sr);
      this.clk = new Trigger(); this.rst = new Trigger();
      this.L = null; this.R = null; this.fileRate = sr;
      this.at = new Float64Array(8); this.end = new Float64Array(8); this.per = new Float64Array(8);   // seconds; seconds a 16th
      this.hits = new Float64Array(8 * 16); this.hitCount = new Uint8Array(8);   // each pad's kicks, seconds in
      this.steps = new Int8Array(64).fill(-1);
      this.pads = 0;
      this.k = -1;
      this.since = 0; this.last = 0; this.period = 0;   // samples a 16th, by the clock coming in
      this.fresh = true; this.ran = false;
      this.pad = 0; this.pos = -1; this.stop = 0; this.speed = 1; this.amp = 0; this.h = 0;
      this.old = -1; this.oldSpeed = 1; this.oldAmp = 0;   // the slice before, fading so a cut doesn't click
      this.fade = 1 / (0.003 * sr);
      this.rng = new Rng(4242);
      this.pKick = new Pulse(sr, 2);
    }
    onMessage(m) {
      if (m.kind === 'clear') { this.L = null; this.pos = -1; this.old = -1; return; }
      if (m.kind !== 'buffer') return;
      this.L = m.L; this.R = m.R ?? m.L;
      this.fileRate = m.sr;
      this.pos = -1; this.old = -1;
      this.k = -1;   // what lands on a step starts on its first one
    }
    rewind() { this.k = -1; }
    advance(n, p) { this.k = (this.k + n) % p[0]; }
    onData(d) {
      const pool = d?.pool ?? [];
      this.pads = 0;
      for (let n = 0; n < 8; n++) {
        const s = pool[d?.pads?.[n]];
        this.at[n] = s?.at ?? 0;
        this.end[n] = s?.end ?? 0;
        this.per[n] = s ? (s.end - s.at) / s.steps : 0;
        const kicks = s?.kicks ?? [];
        this.hitCount[n] = Math.min(16, kicks.length);
        for (let h = 0; h < this.hitCount[n]; h++) this.hits[n * 16 + h] = kicks[h];
        if (s) this.pads = n + 1;
      }
      for (let k = 0; k < 64; k++) this.steps[k] = d?.steps?.[k] ?? -1;
    }
    // how fast to read this pad: its own sixteenth against the wall's, so a bar lasts a bar
    pace(n, tune) {
      const own = this.per[n] * this.fileRate;
      const rate = this.period > 0 ? own / this.period : this.fileRate / this.sr;
      return clamp(rate, 0.25, 4) * 2 ** (tune / 12);
    }
    cut() {
      if (this.pos < 0) return;
      this.old = this.pos; this.oldSpeed = this.speed; this.oldAmp = this.amp;
      this.pos = -1;
    }
    play(n, p, tune) {
      this.cut();
      this.pad = n;
      this.pos = this.at[n] * this.fileRate;
      this.stop = this.pos + (this.end[n] - this.at[n]) * this.fileRate * p[1];
      this.speed = this.pace(n, tune);
      this.amp = 0;
      this.h = 0;
    }
    tick(i, o, p) {
      const running = this.rack.running;
      if (running !== this.ran) { this.ran = running; this.fresh = true; this.last = 0; if (!running) this.cut(); }
      if (this.rst.tick(i[1])) this.k = -1;
      this.since++;
      const tune = p[2] + i[2] * 12;
      if (this.clk.tick(i[0])) {
        if (!this.fresh) {
          // two pulses, because swing moves every other one
          this.period = this.last > 0 ? (this.since + this.last) / 2 : this.since;
          this.last = this.since;
        }
        this.fresh = false;
        this.since = 0;
        this.k = (this.k + 1) % p[0];
        let n = this.steps[this.k];
        if (this.pads > 0 && this.rng.next() < p[3]) n = Math.floor(this.rng.next() * this.pads);
        if (this.L !== null && running) {
          if (n >= 0 && this.end[n] > this.at[n]) this.play(n, p, tune);
          else if (this.pos >= 0) this.speed = this.pace(this.pad, tune);
        }
        this.ui[1] = this.k;
      }
      let l = 0, r = 0;
      const L = this.L, R = this.R;
      if (L !== null && this.pos >= 0) {
        const s = this.pos | 0, f = this.pos - s;
        if (s + 1 >= L.length) this.pos = -1;
        else {
          this.amp = Math.min(1, this.amp + this.fade * 2);
          const env = this.amp * Math.min(1, ((this.stop - this.pos) / this.speed) * this.fade);
          l = (L[s] + (L[s + 1] - L[s]) * f) * env;
          r = (R[s] + (R[s + 1] - R[s]) * f) * env;
          const base = this.at[this.pad] * this.fileRate, first = this.pad * 16;
          while (this.h < this.hitCount[this.pad] && this.pos - base >= this.hits[first + this.h] * this.fileRate) {
            this.pKick.fire();
            this.h++;
          }
          this.pos += this.speed;
          if (this.pos >= this.stop) this.pos = -1;
          this.ui[0] = s / L.length;
          this.ui[2] = this.pad + 1;
        }
      } else this.ui[2] = 0;
      if (L !== null && this.old >= 0) {
        const s = this.old | 0, f = this.old - s;
        if (s + 1 >= L.length) this.old = -1;
        else {
          l += (L[s] + (L[s + 1] - L[s]) * f) * this.oldAmp;
          r += (R[s] + (R[s + 1] - R[s]) * f) * this.oldAmp;
          this.old += this.oldSpeed;
          this.oldAmp -= this.fade;
          if (this.oldAmp <= 0) this.old = -1;
        }
      }
      o[0] = l * 5 * p[4];
      o[1] = r * 5 * p[4];
      o[2] = this.pKick.tick();
    }
  },
};

export const audioin = {
  type: 'audioin', title: 'AUDIO IN', category: 'io',
  description: 'Microphone or line input',
  tags: ['microphone', 'line', 'interface', 'external'],
  inputs: [],
  outputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  params: [{ name: 'gain', label: 'GAIN', min: 0, max: 8, default: 1, size: 'L', format: fmtPct }],
  lights: [{ name: 'signal', label: 'SIG', color: 'green' }],
  dsp: class AudioIn extends Module {
    constructor(sr) { super(sr); this.dcL = new DCBlock(sr); this.dcR = new DCBlock(sr); }
    tick(i, o, p) {
      const l = this.dcL.tick(this.rack.inL) * 5 * p[0], r = this.dcR.tick(this.rack.inR) * 5 * p[0];
      o[0] = l;
      o[1] = r;
      this.ui[0] = Math.max(this.ui[0] * 0.9995, Math.min(1, Math.abs(l) * 0.2));
    }
  },
};

const CHANNELS = Array.from({ length: 16 }, (_, k) => String(k + 1));
const ccKnob = (name, label, cc) => ({ name, label, min: 0, max: 127, default: cc, step: 1, format: (v) => `CC ${v}` });

export const midi = {
  type: 'midi', title: 'MIDI IN', category: 'io',
  description: 'MIDI notes, velocity, mod wheel, two CCs and clock as voltages. Your computer keyboard plays it too',
  tags: ['keyboard', 'controller', 'notes', 'cv'],
  inputs: [],
  outputs: [
    { name: 'pitch', label: 'PITCH', kind: 'pitch' }, { name: 'gate', label: 'GATE', kind: 'gate' },
    { name: 'vel', label: 'VEL', kind: 'cv' }, { name: 'mod', label: 'MOD', kind: 'cv' },
    { name: 'clk', label: 'CLK', kind: 'gate' }, { name: 'rst', label: 'RST', kind: 'gate' },
    { name: 'a', label: 'CC A', kind: 'cv' }, { name: 'b', label: 'CC B', kind: 'cv' },
  ],
  params: [
    { name: 'bend', label: 'BEND', min: 0, max: 12, default: 2, step: 1, format: (v) => `±${v} st` },
    { name: 'mono', label: 'PRIORITY', type: 'select', options: ['LAST', 'LOW', 'HIGH'], default: 0 },
    { name: 'chan', label: 'CHANNEL', type: 'select', options: ['ALL', ...CHANNELS], default: 0 },
    ccKnob('ccA', 'CC A', 74), ccKnob('ccB', 'CC B', 71),
  ],
  lights: [{ name: 'gate', label: '', color: 'red' }],
  widgets: [{ ui: 'midiport', w: 170, h: 22, dir: 'in' }, { ui: 'keys', w: 170, h: 50 }],
  dsp: class Midi extends Module {
    constructor(sr) {
      super(sr);
      this.inbox = [];
      this.notes = [];
      this.cc = new Float64Array(128);
      this.pitch = 0; this.vel = 0; this.mod = 0; this.bend = 0;
      this.gap = 0;
      this.ticks = 0;
      this.pClk = new Pulse(sr, 2); this.pRst = new Pulse(sr, 2);
    }
    onMessage(m) { if (m.kind === 'midi') this.inbox.push(m.data); }
    take([st, a, b], chan) {
      const type = st & 0xf0;
      if (st >= 0xf0) {   // the clock and its like belong to no channel
        if (st === 0xf8) { if (this.ticks++ % 6 === 0) this.pClk.fire(); }
        else if (st === 0xfa) { this.ticks = 0; this.pRst.fire(); }
      } else if (chan > 0 && (st & 15) !== chan - 1) return;
      if (type === 0x90 && b > 0) {
        this.notes = this.notes.filter((n) => n !== a);
        this.notes.push(a);
        this.vel = b / 12.7;
        this.gap = 24;
      } else if (type === 0x80 || (type === 0x90 && b === 0)) {
        this.notes = this.notes.filter((n) => n !== a);
      } else if (type === 0xb0) {
        this.cc[a] = b / 12.7;
        if (a === 1) this.mod = b / 12.7;
      } else if (type === 0xe0) this.bend = (b * 128 + a - 8192) / 8192;
    }
    tick(i, o, p) {
      if (this.inbox.length) {
        for (const m of this.inbox) this.take(m, p[2]);
        this.inbox = [];
      }
      const n = this.notes;
      let note = -1;
      if (n.length) {
        const mode = p[1];
        if (mode === 0) note = n[n.length - 1];
        else {
          note = n[0];
          for (let k = 1; k < n.length; k++) if (mode === 1 ? n[k] < note : n[k] > note) note = n[k];
        }
        this.pitch = (note - 60) / 12;
      }
      o[0] = this.pitch + (this.bend * p[0]) / 12;
      let g = note >= 0 ? 10 : 0;
      if (this.gap > 0) { this.gap--; g = 0; }
      o[1] = g;
      o[2] = this.vel;
      o[3] = this.mod;
      o[4] = this.pClk.tick();
      o[5] = this.pRst.tick();
      o[6] = this.cc[p[3]];
      o[7] = this.cc[p[4]];
      this.ui[0] = g ? 1 : 0;
    }
  },
};

// Voltages out as MIDI. The rack's clock ticks in 16ths and MIDI's 24 times a beat, so after each 16th
// the five ticks in between are spaced by how long the last 16th took. Silence on CLK for a second
// is a stop. The bytes go by way of the main thread, which sends them when the sound they belong to
// reaches the speakers.
export const midiout = {
  type: 'midiout', title: 'MIDI OUT', category: 'io',
  description: 'Voltages out as MIDI: notes, two CCs and the clock, for gear, a DAW or a plugin host',
  tags: ['keyboard', 'hardware', 'daw', 'clock', 'cc', 'sync', 'notes'],
  inputs: [
    { name: 'pitch', label: 'PITCH', kind: 'pitch' }, { name: 'gate', label: 'GATE', kind: 'gate' },
    { name: 'vel', label: 'VEL', kind: 'cv' }, { name: 'a', label: 'CC A', kind: 'cv' }, { name: 'b', label: 'CC B', kind: 'cv' },
    { name: 'clk', label: 'CLK', kind: 'gate' }, { name: 'rst', label: 'RST', kind: 'gate' },
  ],
  outputs: [],
  params: [
    { name: 'chan', label: 'CHANNEL', type: 'select', options: CHANNELS, default: 0 },
    ccKnob('ccA', 'CC A', 74), ccKnob('ccB', 'CC B', 71),
  ],
  lights: [{ name: 'sent', label: '', color: 'red' }],
  widgets: [{ ui: 'midiport', w: 170, h: 22, dir: 'out' }],
  dsp: class MidiOut extends Module {
    constructor(sr) {
      super(sr);
      this.outgoing = [];
      this.clk = new Trigger(); this.rst = new Trigger();
      this.note = -1;
      this.sent = [-1, -1];
      this.left = 256;       // samples to the next look at the CCs
      this.t = 0;
      this.edge = -1;        // when CLK last rose
      this.gapped = 0;       // samples between the last two rises
      this.ticks = 0;        // of the five in between, still to go
      this.next = 0;
    }
    say(...bytes) {
      this.outgoing.push([this.rack.samples, ...bytes]);
      this.ui[0] = 1;
      this.ui[1] = bytes[0];
    }
    notes(i, chan) {
      const down = i[1] > 1, note = clamp(Math.round(60 + i[0] * 12), 0, 127);
      if (down && note !== this.note) {
        const was = this.note;
        this.note = note;
        this.say(0x90 | chan, note, this.linked[2] ? clamp(Math.round(i[2] * 12.7), 1, 127) : 100);
        if (was >= 0) this.say(0x80 | chan, was, 0);
      } else if (!down && this.note >= 0) {
        this.say(0x80 | chan, this.note, 0);
        this.note = -1;
      }
    }
    controls(i, p, chan) {
      if (--this.left > 0) return;
      this.left = 256;
      for (let k = 0; k < 2; k++) {
        if (!this.linked[3 + k]) continue;
        const v = clamp(Math.round(i[3 + k] * 12.7), 0, 127);
        if (v === this.sent[k]) continue;
        this.sent[k] = v;
        this.say(0xb0 | chan, p[1 + k], v);
        this.ui[2 + k] = p[1 + k];
      }
    }
    clock(i) {
      const t = this.t++;
      if (this.rst.tick(i[6])) this.say(0xfa);
      if (this.clk.tick(i[5])) {
        if (this.edge >= 0) this.gapped = t - this.edge;
        this.edge = t;
        // what hasn't gone yet goes now: gear that loses count stays a little behind for good, and
        // the first 16th has nothing to be spaced by
        for (; this.ticks > 0; this.ticks--) this.say(0xf8);
        this.say(0xf8);
        this.ticks = 5;
        this.next = t + this.gapped / 6;
      } else if (this.gapped > 0 && this.ticks > 0 && t >= this.next) {
        this.say(0xf8);
        this.ticks--;
        this.next += this.gapped / 6;
      } else if (this.edge >= 0 && t - this.edge > this.sr) {
        this.say(0xfc);
        this.edge = -1;
        this.gapped = 0;
        this.ticks = 0;
      }
    }
    tick(i, o, p) {
      this.notes(i, p[0]);
      this.controls(i, p, p[0]);
      this.clock(i);
      this.ui[0] *= 0.9992;
    }
  },
};

// A VST3 or an Audio Unit on the wall. The plugin runs in a process of its own, so its sound goes there
// and back a block at a time and comes back late. This keeps it a steady LEAD blocks late: when
// a block doesn't make it the output dies away and the light goes, and it starts again LEAD blocks
// back. With no plugin, in a render for instance, what comes in goes straight out.
export const vst = {
  type: 'vst', title: 'PLUGIN', category: 'io', theme: 'black',
  description: 'A VST3 or Audio Unit from this computer, live on the wall. PRINT burns its sound into a file',
  tags: ['vst', 'vst3', 'au', 'audio unit', 'plugin', 'host', 'instrument', 'effect'],
  inputs: [
    { name: 'inL', label: 'L', kind: 'audio' }, { name: 'inR', label: 'R', kind: 'audio' },
    { name: 'pitch', label: 'PITCH', kind: 'pitch' }, { name: 'gate', label: 'GATE', kind: 'gate' }, { name: 'vel', label: 'VEL', kind: 'cv' },
  ],
  outputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  params: [
    { name: 'level', label: 'LEVEL', min: 0, max: 2, default: 1, format: fmtPct, cv: true },
    { name: 'bypass', label: 'BYPASS', type: 'toggle', default: 0 },
  ],
  lights: [{ name: 'on', label: 'ON', color: 'green' }, { name: 'late', label: 'LATE', color: 'red' }],
  widgets: [{ ui: 'plugin', w: 220, h: 62 }],
  dsp: class Plugin extends Module {
    constructor(sr) {
      super(sr);
      this.port = null;
      this.lead = 2;         // blocks of delay held in hand, against the odd late one
      this.back = [];        // blocks back from the plugin, oldest first
      this.reading = null;
      this.read = 0;
      this.spare = [];
      this.frame = this.newFrame();
      this.at = 0;
      this.count = 0;        // MIDI events in this block
      this.note = -1;
      this.wet = 0;
      this.heldL = 0; this.heldR = 0;
    }
    newFrame(buffer = new ArrayBuffer(PLUGIN_FRAME)) {
      const head = new DataView(buffer);
      head.setUint8(0, 1);
      head.setUint16(2, PLUGIN_BLOCK, true);
      return { buffer, head, samples: new Float32Array(buffer, PLUGIN_HEAD, PLUGIN_BLOCK * 2), notes: new DataView(buffer, PLUGIN_HEAD + PLUGIN_BLOCK * 8) };
    }
    onMessage(m) {
      if (m.kind === 'midi') this.midi(m.data[0], m.data[1] ?? 0, m.data[2] ?? 0);
      if (m.kind !== 'bridge') return;
      this.port = m.port;
      this.back = [];
      this.reading = null;
      if (m.port) m.port.onmessage = (e) => this.heard(e.data);
    }
    heard(buffer) { this.back.push(this.newFrame(buffer)); }
    midi(a, b, c) {
      if (this.count === PLUGIN_NOTES) return;
      const n = this.frame.notes, k = this.count++ * 5;
      n.setUint16(k, this.at, true);
      n.setUint8(k + 2, a);
      n.setUint8(k + 3, b);
      n.setUint8(k + 4, c);
    }
    notes(i) {
      const down = i[3] > 1, note = clamp(Math.round(60 + i[2] * 12), 0, 127);
      if (down && note !== this.note) {
        if (this.note >= 0) this.midi(0x80, this.note, 0);
        this.note = note;
        this.midi(0x90, note, this.linked[4] ? clamp(Math.round(i[4] * 12.7), 1, 127) : 100);
      } else if (!down && this.note >= 0) {
        this.midi(0x80, this.note, 0);
        this.note = -1;
      }
    }
    send() {
      this.frame.head.setUint16(4, this.count, true);
      this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
      this.frame = this.spare.pop() ?? this.newFrame();
      this.at = 0;
      this.count = 0;
    }
    tick(i, o, p) {
      const l = i[0], r = this.linked[1] ? i[1] : l, wanted = this.port !== null && p[1] === 0 ? 1 : 0;
      this.wet += (wanted - this.wet) * 0.002;
      let wetL = 0, wetR = 0;
      if (this.port !== null) {
        this.notes(i);
        const s = this.frame.samples;
        s[this.at] = l * 0.2;
        s[this.at + PLUGIN_BLOCK] = r * 0.2;
        if (++this.at === PLUGIN_BLOCK) this.send();
        if (this.reading === null && this.back.length >= this.lead) { this.reading = this.back.shift(); this.read = 0; }
        if (this.reading !== null) {
          const b = this.reading.samples;
          this.heldL = wetL = b[this.read] * 5;
          this.heldR = wetR = b[this.read + PLUGIN_BLOCK] * 5;
          if (++this.read === PLUGIN_BLOCK) {
            this.spare.push(this.reading);
            while (this.back.length > this.lead + 1) this.spare.push(this.back.shift());   // the burst after a hiccup
            this.reading = this.back.shift() ?? null;
            this.read = 0;
            if (this.reading === null) { this.ui[1] = 1; this.ui[2]++; }
          }
        } else {
          this.heldL *= 0.995;
          this.heldR *= 0.995;
          wetL = this.heldL;
          wetR = this.heldR;
        }
      }
      o[0] = (wetL * this.wet + l * (1 - this.wet)) * p[0];
      o[1] = (wetR * this.wet + r * (1 - this.wet)) * p[0];
      this.ui[0] = this.port !== null ? 1 : 0;
      this.ui[1] *= 0.9997;
    }
  },
};

// A playlist, one track at a time. Which track plays when is written in a plan (src/set/): this
// module only does what a turntable can. It reads a track along the track's own beat grid, so
// whatever the clock says, the track's beats land on the clock's, and a tempo move on the Clock
// moves it like a record. A cue lands on a clock pulse, so a track starts exactly on a bar. ROLL
// loops what's playing, down to an 8th, while the track goes on underneath: let go, and it is where
// it would have been. What becomes of the sound is up to the rack it's patched into.
export const set = {
  type: 'set', title: 'SET', category: 'io', theme: 'black',
  description: 'Plays a playlist one track at a time, locked to the clock, on the bars a plan says',
  tags: ['playlist', 'dj', 'transition', 'deck', 'track', 'mp3'],
  inputs: [{ name: 'clk', label: 'CLK', kind: 'gate' }],
  outputs: [{ name: 'l', label: 'L', kind: 'audio' }, { name: 'r', label: 'R', kind: 'audio' }],
  params: [
    { name: 'gain', label: 'GAIN', min: 0, max: 4, default: 1.5, format: fmtPct },
    { name: 'roll', label: 'ROLL', type: 'select', options: ['OFF', '4 BARS', '2 BARS', '1 BAR', '1/2', '1/4', '1/8'], default: 0 },
  ],
  lights: [{ name: 'on', label: '', color: 'green' }],
  widgets: [{ ui: 'setflow', w: 780, h: 228 }],
  defaultData: () => ({ tracks: [], plan: null }),
  dsp: class SetDeck extends Module {
    static ROLL = [0, 64, 32, 16, 8, 4, 2];   // 16ths
    constructor(sr) {
      super(sr);
      this.clk = new Trigger();
      this.L = null; this.R = null; this.rate = sr; this.grid = null; this.level = 1;
      this.on = false; this.armed = false; this.from = 0; this.halting = false; this.leaving = false;
      this.g = 0; this.odd = false; this.pos = 0; this.speed = 1; this.amp = 0;
      this.read = 0; this.top = 0; this.size = 0;   // where a roll reads, where it began, how long it is
      this.since = 0; this.last = 0; this.period = 0;   // samples a 16th, by the clock coming in
      this.fresh = true; this.ran = false;
      this.ramp = 1 / (0.004 * sr);
    }
    onMessage(m) {
      if (m.kind === 'clear') { this.L = null; this.on = false; this.armed = false; }
      else if (m.kind === 'buffer') {
        this.L = m.L; this.R = m.R ?? m.L; this.rate = m.sr; this.grid = m.grid ?? null; this.level = m.gain ?? 1;
        this.on = false; this.armed = m.from !== undefined; this.from = m.from ?? 0;
      } else if (m.kind === 'cue') { this.armed = true; this.from = m.from; }
      else if (m.kind === 'stop') this.halting = true;
    }
    // Reads along the grid: wherever this 8th ended, the next one must end two pulses on. Two,
    // because swing moves every other pulse and a track has none of it.
    pace() {
      const base = this.rate / this.sr, grid = this.grid;
      if (grid === null || this.period <= 0 || this.read + 2 >= grid.length) { this.speed = base; return; }
      this.speed = clamp((grid[this.read + 2] * this.rate - this.pos) / (2 * this.period), base * 0.25, base * 4);
    }
    // a jump in what's read, faded in as a track starts
    jump(to) {
      this.read = to;
      if (this.grid === null || to >= this.grid.length) return;
      this.pos = this.grid[to] * this.rate;
      this.amp = 0;
    }
    // every other pulse: the track moves on, whether it's being heard or not
    advance(size) {
      this.g += 2;
      if (size !== this.size) {
        if (size === 0) this.jump(this.g);
        else { this.top = this.g; this.read = this.g; }
        this.size = size;
      } else if (size === 0) this.read = this.g;
      else if (this.read + 2 >= this.top + size) this.jump(this.top);
      else this.read += 2;
      this.pace();
    }
    start() {
      this.armed = false; this.on = true; this.leaving = false; this.halting = false;
      this.g = this.from; this.odd = false;
      this.read = this.g; this.size = 0;
      this.pos = (this.grid?.[this.g] ?? 0) * this.rate;
      this.amp = 0;
      this.pace();
    }
    tick(i, o, p) {
      const running = this.rack.running;
      if (running !== this.ran) { this.ran = running; this.fresh = true; this.last = 0; }
      this.since++;
      if (this.clk.tick(i[0]) || this.linked[0] === 0) {
        if (this.linked[0] === 1) {
          if (!this.fresh) {
            this.period = this.last > 0 ? (this.since + this.last) / 2 : this.since;
            this.last = this.since;
          }
          this.fresh = false;
          this.since = 0;
        }
        if (this.halting) { this.halting = false; this.leaving = this.on; }
        if (this.armed && this.L !== null && running) this.start();
        else if (this.on && this.linked[0] === 1) {
          this.odd = !this.odd;
          if (!this.odd) this.advance(SetDeck.ROLL[p[1]]);
        }
      }
      let L = 0, R = 0;
      if (running && this.on) {
        const s = this.pos | 0, f = this.pos - s;
        if (s + 1 >= this.L.length) this.on = false;
        else {
          this.amp += this.leaving ? -this.ramp : this.ramp;
          if (this.amp > 1) this.amp = 1;
          if (this.amp <= 0) { this.on = false; this.leaving = false; this.amp = 0; }
          else {
            const amp = this.amp * this.level;
            L = (this.L[s] + (this.L[s + 1] - this.L[s]) * f) * amp;
            R = (this.R[s] + (this.R[s + 1] - this.R[s]) * f) * amp;
            this.pos += this.speed;
          }
        }
      }
      this.ui[0] = this.on ? 1 : 0;
      o[0] = L * 5 * p[0];
      o[1] = R * 5 * p[0];
    }
  },
};

export const io = [deck, sampler, slicer, set, audioin, midi, midiout, vst];
