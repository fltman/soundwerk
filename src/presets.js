// The example patches, each built with a small wiring language so that they read as patches.
import { Graph } from './rack/graph.js';
import { getDef } from './modules/index.js';
import { findGap, widthOf } from './rack/place.js';
import { parseNotes, parseRows } from './rack/patterns.js';
import { checkRig } from './dj/rig.js';

class Wiring {
  constructor() {
    this.g = new Graph();
    this.row = 0;
  }
  add(type, params = {}, more = {}) {
    const g = this.g;
    for (const name of Object.keys(params)) {
      if (!getDef(type).params?.some((p) => p.name === name)) throw new Error(`${type} has no param ${name}`);
    }
    const node = g.addNode(type, 0, 0, { params, ...more });
    const at = findGap(g, widthOf(g, node), { startRow: this.row, skip: new Set([node.id]) });
    g.moveNode(node.id, at.row, at.hp);
    return node.id;
  }
  nextRow() { this.row++; }
  notes(text, params = {}) { return this.add('bassline', params, { data: parseNotes(text) }); }
  beats(rows, params = {}) { return this.add('drumseq', params, { data: parseRows(rows) }); }
  // wire(a, 'out', b, 'in', depth): a depth is for jacks that drive a knob
  wire(from, fromPort, to, toPort, depth) {
    const r = this.g.connect(from, fromPort, to, toPort);
    if (!r.ok) throw new Error(`can't wire ${from}.${fromPort} → ${to}.${toPort}: ${r.reason}`);
    if (depth !== undefined) this.g.setDepth(to, toPort, depth);
  }
  // one wire() per cable, several at once: wires(a, 'out', [b, 'in'], [c, 'in'])
  wires(from, fromPort, ...targets) {
    for (const [to, toPort, depth] of targets) this.wire(from, fromPort, to, toPort, depth);
  }
  done() { return this.g.toJSON(); }
  // the same check the assistant's rigs go through
  rigged(raw) {
    const { rig, problems } = checkRig(this.g, raw);
    if (problems.length) throw new Error(problems.join('; '));
    return { ...this.done(), rig };
  }
}

// The clock wired to every sequencer: 1/16 into clk, reset into rst
const clocked = (w, clk, ...seqs) => {
  for (const s of seqs) {
    w.wire(clk, 's16', s, 'clk');
    w.wire(clk, 'rst', s, 'rst');
  }
};

function drumKit(w, seq, { kick = {}, snare = {}, hats = {}, clap = {}, perc = {} } = {}) {
  const bd = w.add('kick', kick), sd = w.add('snare', snare), hh = w.add('hats', hats), cp = w.add('clap', clap), rs = w.add('perc', { mode: 0, ...perc });
  w.wire(seq, 't1', bd, 'trig');
  w.wire(seq, 't2', sd, 'trig');
  w.wire(seq, 't3', hh, 'closed');
  w.wire(seq, 't4', hh, 'open');
  w.wire(seq, 't5', cp, 'trig');
  w.wire(seq, 't6', rs, 'trig');
  w.wires(seq, 'acc', [bd, 'accent'], [hh, 'accent']);
  return { bd, sd, hh, cp, rs };
}

const desk = (w, levels) => {
  const d = w.add('desk', levels);
  return d;
};

// the flagship: a whole acid rig, three full rows of it
function acidWall() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 136, swing: 0.54 });
  const seq = w.notes('C2 C2! C3 - D#2~ F2 C2 G#2! - C2 C3~ A#2 C2! - F2~ G2');
  const box = w.add('acid', { cutoff: 1, reso: 0.8, envMod: 0.72, decay: 0.3, accentAmt: 0.75, volume: 0.9 });
  const dirt = w.add('drive', { mode: 0, drive: 0.5, tone: 0.92 });
  const sweep = w.add('lfo', { shape: 1, div: 12 });
  const echo = w.add('delay', { feedback: 0.48, tone: 0.6, wow: 0.1, mix: 1, div: 2 });
  const hall = w.add('reverb', { decay: 0.32, damp: 0.35, mix: 1 });
  const scope1 = w.add('scope', { time: 0.58, gainA: 2, gainB: 2.5, posA: 1.2, posB: -1.6 });
  const xy = w.add('xyscope', { zoom: 0.35, rotate: 1 });
  clocked(w, clk, seq);
  w.wire(clk, 's16', sweep, 'clk');
  w.wire(clk, 'rst', sweep, 'rst');
  w.wires(seq, 'pitch', [box, 'pitch']);
  w.wire(seq, 'gate', box, 'gate');
  w.wire(seq, 'accent', box, 'accent');
  w.wire(seq, 'slide', box, 'slide');
  w.wire(sweep, 'bi', box, 'cutoff', 0.12);
  w.wire(box, 'out', dirt, 'in');
  w.wire(dirt, 'out', scope1, 'a');
  w.wire(box, 'env', scope1, 'b');

  w.nextRow();
  const drums = w.beats({
    BD: 'x...x...x...x...', SD: '.......x.......x', CP: '....x.......x...', CH: 'xxx.xxx.xxx.xxx.', OH: '..x...x...x...x.',
    RS: '...x..x....x..x.', LT: '..........x..x..', HT: '..x...x...x...x.', AC: 'x...x...x...x...',
  });
  clocked(w, clk, drums);
  const { bd, sd, hh, cp, rs } = drumKit(w, drums, {
    kick: { tune: 52, decay: 0.42, drive: 0.42, attack: 0.65 },
    hats: { decayC: 0.32, decayO: 0.42 }, clap: { decay: 0.45 }, perc: { decay: 0.3 },
  });
  const low = w.add('tom', { tune: 0.3, decay: 0.3 });
  const ride = w.add('ride', { decay: 0.2, tone: 0.6 });
  w.wire(drums, 't7', low, 'trig');
  w.wire(drums, 't8', ride, 'trig');
  const bell = w.add('euclid', { hits: 5, steps: 16, rot: 2 });
  const cow = w.add('perc', { mode: 1, decay: 0.3 });
  clocked(w, clk, bell);
  w.wire(bell, 'trig', cow, 'trig');
  const duck = w.add('comp', { thresh: -26, ratio: 6, attack: 0.35, release: 0.42, makeup: 4 });
  w.wire(dirt, 'out', duck, 'inL');
  w.wire(bd, 'out', duck, 'side');
  const bus = w.add('mixer', { l1: 0.9, l2: 0.5, l3: 0.34 });
  w.wire(cow, 'out', bus, 'in1');
  w.wire(ride, 'out', bus, 'in2');
  w.wire(low, 'out', bus, 'in3');

  w.nextRow();
  const mix = desk(w, { lvl1: 0.82, lvl2: 0.8, lvl3: 0.34, lvl4: 1.25, lvl5: 0.75, lvl6: 0.5, lvl7: 0.5, a2: 0.5, a6: 0.5, a7: 0.4, b2: 0.12, b3: 0.1, b5: 0.35, b4: 0.08, pan4: 0.15, pan6: -0.4, pan7: 0.45, ret: 1, ret2: 1.1 });
  const vu = w.add('vu');
  const spec = w.add('analyzer');
  const fall = w.add('waterfall');
  const scope2 = w.add('scope', { time: 0.8, gainA: 3, gainB: 3, posA: 1.4, posB: -1.4, source: 2, mode: 1, phosphor: 1 });
  const out = w.add('master', { volume: 0.72 });
  w.wire(bd, 'out', mix, 'ch1');
  w.wire(duck, 'outL', mix, 'ch2');
  w.wire(sd, 'out', mix, 'ch3');
  w.wire(hh, 'out', mix, 'ch4');
  w.wire(cp, 'out', mix, 'ch5');
  w.wire(rs, 'out', mix, 'ch6');
  w.wire(bus, 'out', mix, 'ch7');
  w.wire(mix, 'sendA', echo, 'inL');
  w.wire(clk, 's16', echo, 'clk');
  w.wire(mix, 'sendB', hall, 'inL');
  w.wire(echo, 'outL', mix, 'retL');
  w.wire(echo, 'outR', mix, 'retR');
  w.wire(hall, 'outL', mix, 'ret2L');
  w.wire(hall, 'outR', mix, 'ret2R');
  w.wires(mix, 'l', [out, 'l'], [vu, 'l'], [spec, 'in'], [fall, 'in'], [xy, 'x']);
  w.wires(mix, 'r', [out, 'r'], [vu, 'r'], [xy, 'y']);
  w.wire(bd, 'out', scope2, 'a');
  w.wire(duck, 'outL', scope2, 'b');
  w.wire(clk, 's4', scope2, 'ext');
  return w.rigged(acidRig({ seq, box, dirt, duck, drums, mix, echo }));
}

// How the live DJ plays the Acid wall: knobs, patterns, sends, and effects that come and go
function acidRig({ seq, box, dirt, duck, drums, mix, echo }) {
  const acid = (name, description, cutoff, reso, envMod, decay) => ({ name, description, glide: 2, ops: [{ op: 'set', id: box, params: { cutoff, reso, envMod, decay } }] });
  const line = (name, description, notes) => ({ name, description, ops: [{ op: 'pattern', id: seq, notes }] });
  const kit = (name, description, rows) => ({
    name, description,
    ops: [{ op: 'pattern', id: drums, rows: { BD: 'x...x...x...x...', SD: '................', CP: '................', CH: 'xxx.xxx.xxx.xxx.', OH: '..x...x...x...x.', RS: '................', LT: '................', HT: '................', AC: 'x...x...x...x...', ...rows } }],
  });
  const space = (name, description, a2, b2, feedback) => ({ name, description, glide: 4, ops: [{ op: 'set', id: mix, params: { a2, b2 } }, { op: 'set', id: echo, params: { feedback } }] });
  // an effect in the acid's path, between the sidechain and the desk
  const insert = (name, description, type, params) => ({
    name, description,
    ops: [
      { op: 'add', type, ref: 'fx', params },
      { op: 'connect', from: duck, from_port: 'outL', to: 'fx', to_port: 'inL' },
      { op: 'connect', from: 'fx', from_port: 'outL', to: mix, to_port: 'ch2' },
    ],
  });
  return {
    brief: 'A long acid set. The filter opens slowly over the build and only screams at the peak; breaks are for the delay.',
    arc: [{ name: 'groove', bars: 16 }, { name: 'build', bars: 8 }, { name: 'peak', bars: 24 }, { name: 'break', bars: 8 }],
    groups: [
      {
        name: 'acid', question: 'How open should the acid filter be for the next four bars?', every: 4, ordered: true,
        moves: [
          acid('closed', 'Filter nearly shut: a dark rubbery pulse. For grooves and breaks.', 1, 0.8, 0.72, 0.3),
          acid('opening', 'Filter part open, more bite on the accents. For the start of a build.', 2, 0.84, 0.7, 0.36),
          acid('open', 'Filter open and squelching, long decay. For the end of a build.', 3, 0.88, 0.66, 0.42),
          acid('screaming', 'Filter wide open, resonance close to self-oscillation. For the peak, never for long.', 4, 0.93, 0.8, 0.5),
        ],
      },
      {
        name: 'line', question: 'Which bassline fits the next eight bars?', every: 8, on_section: true,
        moves: [
          line('main', 'The main riff: busy, with slides and an octave jump. Works anywhere.', 'C2 C2! C3 - D#2~ F2 C2 G#2! - C2 C3~ A#2 C2! - F2~ G2'),
          line('sparse', 'Few notes and a lot of air. For breaks and the start of a groove.', 'C2 - - C2! - - C3 - - C2 - - G#2! - - -'),
          line('climb', 'A rising run that pulls forward. For builds.', 'C2 C2! D#2 F2 G2~ G#2 A#2! C3 C2 C3! D#2 F2 G2~ A#2 C3! -'),
          line('pedal', 'One note hammered, with octave stabs. Hypnotic, for the peak.', 'C2! C2 C2 C2! C2 C2 C3 C2 C2! C2 C2 C2! C2 C2 C3 C3!'),
        ],
      },
      {
        name: 'drums', question: 'Which drum pattern fits the next eight bars?', every: 8, on_section: true,
        moves: [
          kit('full', 'The whole kit with clap, snare and percussion. For grooves and peaks.', { SD: '.......x.......x', CP: '....x.......x...', RS: '...x..x....x..x.', LT: '..........x..x..', HT: '..x...x...x...x.' }),
          kit('stripped', 'Kick and hats only: tense and bare. For the start of a build.', {}),
          kit('no_kick', 'No kick, claps and steady eighths over the echoes. Only for breaks.', { BD: '................', CP: '....x.......x...', CH: 'x.x.x.x.x.x.x.x.', OH: '................', RS: '...x..x....x..x.' }),
          kit('rolling', 'Everything, with a skipping kick and running sixteenths. For the top of a peak.', { BD: 'x...x...x...x.x.', SD: '.......x..x....x', CP: '....x.......x...', CH: 'xxxxxxxxxxxxxxxx', RS: '...x..x....x..x.', LT: '..........x..x..', HT: '..x...x...x...x.' }),
        ],
      },
      {
        name: 'space', question: 'How much space should the acid have?', every: 8,
        moves: [
          space('as_patched', 'Some delay, a little reverb. Neutral.', 0.5, 0.12, 0.48),
          space('dry', 'Almost no delay or reverb: close and hard. For peaks.', 0.1, 0.02, 0.3),
          space('dub', 'Loud delay with long feedback: the line repeats and piles up. For breaks.', 0.85, 0.15, 0.72),
          space('wash', 'Delay and a lot of reverb, the acid moves into the distance. For breaks and the end of a groove.', 0.6, 0.6, 0.55),
        ],
      },
      {
        name: 'insert', question: 'Which effect should sit on the acid for the next sixteen bars?', every: 16, on_section: true,
        moves: [
          { name: 'clean', description: 'No effect on the acid. Direct, and always safe.', ops: [] },
          insert('phaser', 'A slow phaser sweeps through the acid. Hypnotic, for long grooves.', 'phaser', { stages: 1, rate: 0.3, depth: 0.8, feedback: 0.5, mix: 0.7 }),
          insert('flanger', 'A metallic jet flanger on the acid. For builds.', 'flanger', { rate: 0.25, depth: 0.7, feedback: 0.6, mix: 0.6 }),
          {
            name: 'crushed', description: 'The acid is bitcrushed before the sidechain: grainy and broken. For the peak, in small doses.',
            ops: [
              { op: 'add', type: 'crush', ref: 'fx', params: { bits: 6, rate: 0.55 } },
              { op: 'connect', from: dirt, from_port: 'out', to: 'fx', to_port: 'in' },
              { op: 'connect', from: 'fx', from_port: 'out', to: duck, to_port: 'inL' },
            ],
          },
          {
            name: 'wobble', description: 'A fast extra LFO takes over the filter sweep: the acid wobbles and talks. For builds.',
            ops: [
              { op: 'add', type: 'lfo', ref: 'fx', params: { shape: 1, rate: 0.62 } },
              { op: 'connect', from: 'fx', from_port: 'bi', to: box, to_port: 'cutoff', mod_depth: 0.3 },
            ],
          },
        ],
      },
    ],
  };
}

// a chord stab drowned in tape echo and a dark plate, over a soft kick
function dubTechno() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 122, swing: 0.52 });
  const stab = w.beats({ BD: 'x...x...x...x...', CH: '..x...x...x...x.', OH: '..x...x...x...x.', HT: 'x.....x...x.....' });
  const hits = w.add('euclid', { hits: 3, steps: 16, rot: 1 });
  const root = w.add('offset', { o1: -1.25 });
  const pad = w.add('chord', { kind: 7, detune: 14 });
  const shut = w.add('decay', { a: 0.12, d: 0.42 });
  const filt = w.add('ladder', { cutoff: 0.9, res: 0.4 });
  const amp = w.add('vca', { curve: 0, level: 2 });
  const slow = w.add('wander', { rate: 0.2 });
  const echo = w.add('delay', { feedback: 0.72, tone: 0.42, wow: 0.25, mix: 0.55, div: 2 });
  const room = w.add('reverb', { decay: 0.6, damp: 0.5, size: 0.85, mix: 0.42 });
  clocked(w, clk, hits, stab);
  w.wire(hits, 'trig', shut, 'trig');
  w.wire(root, 'out1', pad, 'pitch');
  w.wire(pad, 'out', filt, 'in');
  w.wire(shut, 'env', filt, 'cutoff', 0.22);
  w.wire(slow, 'uni', filt, 'res', 0.15);
  w.wire(filt, 'lp', amp, 'in');
  w.wire(shut, 'env', amp, 'cv');
  w.wire(amp, 'out', echo, 'inL');
  w.wire(clk, 's16', echo, 'clk');
  w.wire(echo, 'outL', room, 'inL');
  w.wire(echo, 'outR', room, 'inR');

  w.nextRow();
  const bd = w.add('kick', { tune: 46, decay: 0.3, drive: 0.15, attack: 0.3 });
  const hh = w.add('hats', { decayC: 0.3, decayO: 0.5, tone: 0.45 });
  const tick = w.add('ride', { decay: 0.1, tone: 0.35 });
  const crack = w.add('noise', { density: 0.3 });
  const sub = w.add('vco', { tune: -31 });
  const subEnv = w.add('decay', { a: 0.1, d: 0.3 });
  const subAmp = w.add('vca');
  w.wire(stab, 't1', bd, 'trig');
  w.wire(stab, 't3', hh, 'closed');
  w.wire(stab, 't4', hh, 'open');
  w.wire(clk, 's4', tick, 'trig');
  w.wire(stab, 't8', subEnv, 'trig');
  w.wire(sub, 'sine', subAmp, 'in');
  w.wire(subEnv, 'env', subAmp, 'cv');
  const mix = desk(w, { lvl1: 0.9, lvl2: 0.7, lvl3: 0.6, lvl4: 0.36, lvl5: 0.6, a3: 0.25, ret: 1.25, ret2: 0 });
  const sc = w.add('scope', { time: 0.76, gainA: 3, gainB: 3, posA: 1.3, posB: -1.3 });
  const spec = w.add('analyzer');
  const out = w.add('master', { volume: 1.2 });
  w.wire(bd, 'out', mix, 'ch1');
  w.wire(subAmp, 'out', mix, 'ch2');
  w.wire(hh, 'out', mix, 'ch3');
  w.wire(tick, 'out', mix, 'ch4');
  w.wire(crack, 'crackle', mix, 'ch5');
  w.wire(room, 'outL', mix, 'retL');
  w.wire(room, 'outR', mix, 'retR');
  w.wires(mix, 'l', [out, 'l'], [sc, 'a'], [spec, 'in']);
  w.wires(mix, 'r', [out, 'r']);
  w.wire(amp, 'out', sc, 'b');
  return w.done();
}

// eight knobs, one oscillator, the filter breathing: seventies electronics
function berlinSchool() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 118 });
  const seq = w.add('step8', { a1: -1, a2: -0.42, a3: -0.75, a4: 0, a5: -1, a6: -0.25, a7: -0.58, a8: 0.17, scale: 2, gatelen: 0.45 });
  const osc = w.add('vco');
  const sub = w.add('vco', { tune: -12 });
  const mixv = w.add('mixer', { l1: 0.7, l2: 0.5 });
  const filt = w.add('ladder', { cutoff: 0.8, res: 0.55, drive: 0.35 });
  const env = w.add('adsr', { a: 0.02, d: 0.42, s: 0.15, r: 0.4 });
  const amp = w.add('vca', { level: 2 });
  const tide = w.add('lfo', { rate: 0.28 });
  w.wire(clk, 's8', seq, 'clk');
  w.wire(clk, 'rst', seq, 'rst');
  w.wires(seq, 'a', [osc, 'pitch'], [sub, 'pitch']);
  w.wire(seq, 'gate', env, 'gate');
  w.wire(osc, 'saw', mixv, 'in1');
  w.wire(sub, 'pulse', mixv, 'in2');
  w.wire(mixv, 'out', filt, 'in');
  w.wire(env, 'env', filt, 'cutoff', 0.4);
  w.wire(tide, 'bi', filt, 'cutoff', 0.2);
  w.wire(filt, 'lp', amp, 'in');
  w.wire(env, 'env', amp, 'cv');

  w.nextRow();
  const echo = w.add('delay', { feedback: 0.55, tone: 0.5, wow: 0.18, mix: 0.4, div: 2 });
  const hall = w.add('reverb', { decay: 0.55, mix: 0.3, damp: 0.55 });
  const sc = w.add('scope', { time: 0.56 });
  const xy = w.add('xyscope', { zoom: 0.3, rotate: 1, phosphor: 1 });
  const spec = w.add('analyzer');
  const out = w.add('master', { volume: 1.4 });
  w.wire(amp, 'out', echo, 'inL');
  w.wire(clk, 's16', echo, 'clk');
  w.wire(echo, 'outL', hall, 'inL');
  w.wire(echo, 'outR', hall, 'inR');
  w.wires(hall, 'outL', [out, 'l'], [sc, 'a'], [xy, 'x'], [spec, 'in']);
  w.wires(hall, 'outR', [out, 'r'], [xy, 'y']);
  w.wire(env, 'env', sc, 'b');
  return w.done();
}

// a kick, its own rumble, and hats that never quite repeat
function warehouse() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 140 });
  const drums = w.beats({
    BD: 'x...x...x...x...', SD: '.......x.....x..', CH: 'x.x.x.x.x.x.x.x.', OH: '..x...x...x.x.x.', CP: '....x.......x..x',
    RS: '.x..x..x.x..x...', AC: 'x...x...x...x...',
  });
  clocked(w, clk, drums);
  const { bd, sd, hh, cp, rs } = drumKit(w, drums, {
    kick: { tune: 49, decay: 0.4, drive: 0.6, attack: 0.8, sweep: 6 },
    hats: { decayC: 0.3, decayO: 0.35, tone: 0.65 }, clap: { decay: 0.3 }, perc: { mode: 0, decay: 0.25, tune: -3 },
  });
  const rumble = w.add('reverb', { decay: 0.4, damp: 0.75, mix: 1, size: 0.9, predelay: 0.2 });
  const dark = w.add('ladder', { cutoff: -2, res: 0.2 });
  const duckR = w.add('comp', { thresh: -32, ratio: 12, attack: 0.3, release: 0.4, makeup: 0 });
  w.wire(bd, 'out', rumble, 'inL');
  w.wire(rumble, 'outL', dark, 'in');
  w.wire(dark, 'lp', duckR, 'inL');
  w.wire(bd, 'out', duckR, 'side');

  w.nextRow();
  const eu = w.add('euclid', { hits: 7, steps: 16, rot: 3 });
  const roll = w.add('tom', { tune: 0.55, decay: 0.25, mode: 1 });
  const fx = w.add('delay', { feedback: 0.35, mix: 1, tone: 0.65, div: 1 });
  const stab = w.add('fm', { ratio: 3.5, index: 5, feedback: 0.3, decay: 0.3 });
  const gateS = w.add('euclid', { hits: 3, steps: 16, rot: 6 });
  const mix = desk(w, { lvl1: 0.8, lvl2: 0.3, lvl3: 0.34, lvl4: 0.95, lvl5: 0.62, lvl6: 0.34, lvl7: 0.3, lvl8: 0.3, a5: 0.25, a7: 0.35, a8: 0.5, ret: 0.7, ret2: 0, pan6: 0.3, pan7: -0.35, pan8: 0.2 });
  const sc = w.add('scope', { time: 0.8, gainA: 4, gainB: 3, source: 0, posA: 1.2, posB: -1.6, phosphor: 2 });
  const spec = w.add('analyzer');
  const vu = w.add('vu');
  const out = w.add('master', { volume: 1 });
  clocked(w, clk, eu, gateS);
  w.wire(eu, 'trig', roll, 'trig');
  w.wire(gateS, 'gate', stab, 'gate');
  w.wire(bd, 'out', mix, 'ch1');
  w.wire(duckR, 'outL', mix, 'ch2');
  w.wire(sd, 'out', mix, 'ch3');
  w.wire(hh, 'out', mix, 'ch4');
  w.wire(cp, 'out', mix, 'ch5');
  w.wire(rs, 'out', mix, 'ch6');
  w.wire(roll, 'out', mix, 'ch7');
  w.wire(stab, 'out', mix, 'ch8');
  w.wire(mix, 'sendA', fx, 'inL');
  w.wire(clk, 's16', fx, 'clk');
  w.wire(fx, 'outL', mix, 'retL');
  w.wire(fx, 'outR', mix, 'retR');
  w.wires(mix, 'l', [out, 'l'], [spec, 'in'], [vu, 'l'], [sc, 'a']);
  w.wires(mix, 'r', [out, 'r'], [vu, 'r']);
  w.wire(bd, 'out', sc, 'b');
  return w.done();
}

// an acid line that talks: the same box through a vowel filter stepped by a random voltage
function talkingAcid() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 128 });
  const seq = w.notes('A2 A2 C3! A2 - G2~ A2 E3! - A2 A2 C3 D3~ E3 - A2!');
  const box = w.add('acid', { cutoff: 1, reso: 0.74, envMod: 0.6, decay: 0.32, accentAmt: 0.65, volume: 1 });
  const voice = w.add('formant', { vowel: 1, res: 0.7 });
  const pick = w.add('sh', { glide: 0.3 });
  const quart = w.add('divider');
  const bd = w.add('kick', { tune: 50, decay: 0.4 });
  const hat = w.add('hats', { decayC: 0.5, tone: 0.7 });
  const space = w.add('delay', { feedback: 0.4, mix: 0.28, div: 2 });
  const sc = w.add('scope', { time: 0.58 });
  const out = w.add('master', { volume: 1 });
  clocked(w, clk, seq);
  w.wire(clk, 's16', quart, 'clk');
  w.wire(clk, 'rst', quart, 'rst');
  w.wire(seq, 'pitch', box, 'pitch');
  w.wire(seq, 'gate', box, 'gate');
  w.wire(seq, 'accent', box, 'accent');
  w.wire(seq, 'slide', box, 'slide');
  w.wire(box, 'out', voice, 'in');
  w.wire(quart, 'd3', pick, 'trig');
  w.wire(pick, 'out', voice, 'vowel', 0.8);
  w.wire(clk, 's4', bd, 'trig');
  w.wire(clk, 's16', hat, 'closed');
  const sum = w.add('mixer', { l1: 0.9, l2: 0.95, l3: 1, main: 1.5 });
  w.wire(voice, 'out', sum, 'in1');
  w.wire(bd, 'out', sum, 'in2');
  w.wire(hat, 'out', sum, 'in3');
  w.wire(sum, 'out', space, 'inL');
  w.wire(clk, 's16', space, 'clk');
  w.wire(space, 'outL', out, 'l');
  w.wire(space, 'outR', out, 'r');
  w.wire(voice, 'out', sc, 'a');
  w.wire(pick, 'out', sc, 'b');
  return w.done();
}

// a melody nobody wrote: a shift register, a scale, plucked strings and a spring
function generativePlucks() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 104 });
  const reg = w.add('turing', { lock: 0.88, length: 8, range: 2 });
  const scale = w.add('quant', { scale: 6, root: 9, shift: -1 });
  const when = w.add('chance', { prob: 0.72 });
  const str = w.add('pluck', { decay: 0.62, damp: 0.5 });
  const str2 = w.add('pluck', { tune: 12, decay: 0.5, damp: 0.65 });
  const tank = w.add('spring', { decay: 0.55, boing: 0.45, mix: 0.4 });
  const echo = w.add('delay', { feedback: 0.42, mix: 0.3, tone: 0.45, div: 2 });
  const sc = w.add('scope', { time: 0.5 });
  const spec = w.add('analyzer');
  const out = w.add('master', { volume: 1.4 });
  const sum = w.add('mixer', { l1: 0.8, l2: 0.45 });
  w.wire(clk, 's8', reg, 'clk');
  w.wire(reg, 'cv', scale, 'in');
  w.wires(scale, 'out', [str, 'pitch'], [str2, 'pitch']);
  w.wire(clk, 's8', when, 'in');
  w.wire(when, 'a', str, 'trig');
  w.wire(when, 'b', str2, 'trig');
  w.wire(str, 'out', sum, 'in1');
  w.wire(str2, 'out', sum, 'in2');
  w.wire(sum, 'out', tank, 'inL');
  w.wire(tank, 'outL', echo, 'inL');
  w.wire(tank, 'outR', echo, 'inR');
  w.wire(clk, 's16', echo, 'clk');
  w.wires(echo, 'outL', [out, 'l'], [sc, 'a'], [spec, 'in']);
  w.wires(echo, 'outR', [out, 'r'], [sc, 'b']);
  return w.done();
}

// no clock at all: slow beating oscillators feeding a comb and a very long plate
function droneWall() {
  const w = new Wiring();
  const a = w.add('vco', { tune: -24 });
  const b = w.add('vco', { tune: -24, fine: 0.09 });
  const c = w.add('vco', { tune: -17, fine: -0.06 });
  const sum = w.add('mixer', { l1: 0.6, l2: 0.6, l3: 0.35 });
  const fold = w.add('folder', { fold: 0.25 });
  const res = w.add('comb', { freq: -1.5, fb: 0.86, damp: 0.5 });
  const dark = w.add('ladder', { cutoff: 0.2, res: 0.3 });
  const d1 = w.add('wander', { rate: 0.12 });
  const d2 = w.add('wander', { rate: 0.18 });
  const d3 = w.add('lfo', { rate: 0.12, shape: 1 });
  const hall = w.add('reverb', { decay: 0.85, mix: 0.6, damp: 0.55, size: 0.95 });

  w.nextRow();
  const sc = w.add('scope', { time: 0.6, phosphor: 2 });
  const xy = w.add('xyscope', { zoom: 0.5, phosphor: 2 });
  const fall = w.add('waterfall');
  const out = w.add('master', { volume: 0.5 });
  w.wire(a, 'saw', sum, 'in1');
  w.wire(b, 'saw', sum, 'in2');
  w.wire(c, 'pulse', sum, 'in3');
  w.wire(sum, 'out', fold, 'in');
  w.wire(d1, 'bi', fold, 'fold', 0.35);
  w.wire(fold, 'out', res, 'in');
  w.wire(d2, 'bi', res, 'freq', 0.1);
  w.wire(res, 'out', dark, 'in');
  w.wire(d3, 'bi', dark, 'cutoff', 0.25);
  w.wire(dark, 'lp', hall, 'inL');
  w.wires(hall, 'outL', [out, 'l'], [sc, 'a'], [xy, 'x'], [fall, 'in']);
  w.wires(hall, 'outR', [out, 'r'], [xy, 'y'], [sc, 'b']);
  return w.done();
}

// oscilloscope art: two sines in a slowly shifting ratio draw on the vector scope
function lissajous() {
  const w = new Wiring();
  const x = w.add('vco', { tune: -12 });
  const y = w.add('vco', { tune: -5, fine: 0.02 });
  const lf = w.add('wander', { rate: 0.15, amt: 0.6 });
  const xy = w.add('xyscope', { zoom: 0.42 });
  const sc = w.add('scope', { time: 0.62 });
  const amp = w.add('vca', { level: 0.7 });
  const amp2 = w.add('vca', { level: 0.7 });
  const out = w.add('master', { volume: 0.9 });
  w.wire(lf, 'bi', y, 'pw');
  w.wire(x, 'sine', amp, 'in');
  w.wire(y, 'sine', amp2, 'in');
  w.wires(amp, 'out', [xy, 'x'], [sc, 'a'], [out, 'l']);
  w.wires(amp2, 'out', [xy, 'y'], [sc, 'b'], [out, 'r']);
  return w.done();
}

// cables in a loop: the ring modulator hears its own delayed output
function feedbackPatch() {
  const w = new Wiring();
  const clk = w.add('clock', { bpm: 124 });
  const pulse = w.add('euclid', { hits: 5, steps: 12 });
  const env = w.add('decay', { d: 0.35, a: 0.02 });
  const osc = w.add('fm', { ratio: 1.41, index: 4, decay: 0.42 });
  const sum = w.add('mixer', { l1: 0.9, l2: 0.72 });
  const ring = w.add('ringmod', { mix: 0.45 });
  const lf = w.add('lfo', { rate: 0.36 });
  const filt = w.add('svf', { cutoff: 1.4, res: 0.55 });
  const crush = w.add('crush', { bits: 10, rate: 0.8 });
  const echo = w.add('delay', { feedback: 0.3, time: 0.62, mix: 1, wow: 0.2 });
  const sc = w.add('scope', { time: 0.6, phosphor: 2 });
  const out = w.add('master', { volume: 0.85 });
  clocked(w, clk, pulse);
  w.wire(pulse, 'gate', osc, 'gate');
  w.wire(pulse, 'trig', env, 'trig');
  w.wire(osc, 'out', sum, 'in1');
  w.wire(sum, 'out', ring, 'in');
  w.wire(lf, 'bi', ring, 'mod');
  w.wire(ring, 'out', filt, 'in');
  w.wire(env, 'env', filt, 'cutoff', 0.3);
  w.wire(filt, 'bp', crush, 'in');
  w.wire(crush, 'out', echo, 'inL');
  w.wire(echo, 'outL', sum, 'in2');      // the loop closes here
  w.wires(echo, 'outL', [out, 'l'], [sc, 'a']);
  w.wires(echo, 'outR', [out, 'r'], [sc, 'b']);
  return w.done();
}

// A bare wall to patch from scratch. Apart from the musical examples, so it never becomes the default.
export const EMPTY = { name: 'Empty wall', patch() { const w = new Wiring(); w.add('master'); return w.done(); } };

export const PRESETS = [
  { name: 'Acid wall', patch: acidWall },
  { name: 'Dub techno', patch: dubTechno },
  { name: 'Warehouse', patch: warehouse },
  { name: 'Talking acid', patch: talkingAcid },
  { name: 'Berlin school', patch: berlinSchool },
  { name: 'Generative plucks', patch: generativePlucks },
  { name: 'Drone wall', patch: droneWall },
  { name: 'Lissajous', patch: lissajous },
  { name: 'Feedback', patch: feedbackPatch },
];
