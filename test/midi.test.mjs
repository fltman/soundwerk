// MIDI in and out, and the Plugin module's end of a plugin, on the real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rack } from '../src/engine/rack.js';
import { PLUGIN_BLOCK, PLUGIN_FRAME, PLUGIN_HEAD } from '../src/modules/lib/index.js';

const SR = 48000, BLOCK = 128;

function wall(modules, links = []) {
  const rack = new Rack({ sampleRate: SR });
  for (const [id, type, params] of modules) rack.apply({ t: 'add', id, type, params });
  rack.apply({ t: 'links', links });
  const said = [];
  rack.onMidi = (id, events) => said.push(...events.map(([at, ...bytes]) => ({ id, at, bytes })));
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  return { rack, said, run: (blocks, each) => { for (let k = 0; k < blocks; k++) { each?.(k); rack.process(L, R, BLOCK); } return { L, R }; } };
}

const cable = (from, fromPort, to, toPort) => ({ id: `${from}.${fromPort}`, from, fromPort, to, toPort });

test('MIDI Out plays notes on its channel, and lets go of the old note after the new one', () => {
  const { rack, said, run } = wall([['g', 'constant'], ['o', 'midiout', { chan: 2 }]]);
  const m = rack.modules.get('o');
  m.linked[1] = 1; m.linked[0] = 1;
  const hold = (pitch, gate) => { m.wires = []; m.i[0] = pitch; m.i[1] = gate; };
  hold(0, 10);
  run(2, () => hold(0, 10));
  run(2, () => hold(1, 10));
  run(2, () => hold(1, 0));
  assert.deepEqual(said.map((e) => e.bytes), [[0x92, 60, 100], [0x92, 72, 100], [0x82, 60, 0], [0x82, 72, 0]]);
});

test('MIDI Out sends a voltage as a CC, and only when it changes', () => {
  const { rack, said, run } = wall([['o', 'midiout', { ccA: 21 }]]);
  const m = rack.modules.get('o');
  m.linked[3] = 1;
  m.i[3] = 5;
  run(40);
  m.i[3] = 10;
  run(40);
  assert.deepEqual(said.map((e) => e.bytes), [[0xb0, 21, 64], [0xb0, 21, 127]]);
});

test('MIDI Out gets 24 ticks a beat out of the Clock, with a start before the first and a stop after the last', () => {
  const { rack, said, run } = wall([['c', 'clock', { bpm: 120 }], ['o', 'midiout']], [cable('c', 's16', 'o', 'clk'), cable('c', 'rst', 'o', 'rst')]);
  rack.apply({ t: 'run', on: true });
  run(Math.ceil((2 * SR) / BLOCK));
  const bytes = said.map((e) => e.bytes[0]);
  assert.equal(bytes[0], 0xfa, 'a start comes first');
  const ticks = said.filter((e) => e.bytes[0] === 0xf8);
  assert.ok(Math.abs(ticks.length - 96) <= 1, `${ticks.length} ticks in two seconds at 120 BPM`);
  const gaps = ticks.slice(8, -1).map((e, k) => e.at - ticks[k + 7].at);
  const beat = SR / 2 / 24;
  for (const g of gaps) assert.ok(Math.abs(g - beat) < 3, `${g} samples between two ticks, not ${beat}`);
  rack.apply({ t: 'run', on: false });
  run(Math.ceil((1.1 * SR) / BLOCK));
  assert.equal(said.at(-1).bytes[0], 0xfc, 'silence on CLK is a stop');
  assert.equal(said.filter((e) => e.bytes[0] === 0xfc).length, 1);
});

test('MIDI In listens to its channel and hands out the CCs it was told to', () => {
  const { rack, run } = wall([['i', 'midi', { chan: 2, ccA: 21 }]]);
  const m = rack.modules.get('i');
  m.dsp.onMessage({ kind: 'midi', data: [0x90, 72, 100] });   // channel 1: not for it
  run(1);
  assert.equal(m.o[1], 0);
  m.dsp.onMessage({ kind: 'midi', data: [0x91, 72, 100] });
  m.dsp.onMessage({ kind: 'midi', data: [0xb1, 21, 127] });
  run(2);
  assert.equal(m.o[0], 1);
  assert.equal(m.o[1], 10);
  assert.equal(m.o[6], 10);
  m.dsp.onMessage({ kind: 'midi', data: [0xf8, 0, 0] });      // a clock has no channel
  run(1);
  assert.equal(m.dsp.ticks, 1);
});

// A plugin at the other end of a port: it answers a number of audio blocks later, and adds a tone
function fakePlugin(late = 0) {
  const port = { sent: 0, waiting: [], notes: [], postMessage(buffer) {
    this.sent++;
    const head = new DataView(buffer), count = head.getUint16(4, true), events = new DataView(buffer, PLUGIN_HEAD + PLUGIN_BLOCK * 8);
    for (let k = 0; k < count; k++) this.notes.push([events.getUint16(k * 5, true), events.getUint8(k * 5 + 2), events.getUint8(k * 5 + 3), events.getUint8(k * 5 + 4)]);
    new Float32Array(buffer, PLUGIN_HEAD, PLUGIN_BLOCK * 2).fill(0.5);
    this.waiting.push({ buffer, at: this.sent + late });
    this.deliver();
  }, deliver() {
    while (this.waiting.length && this.waiting[0].at <= this.sent) this.onmessage({ data: this.waiting.shift().buffer });
  } };
  return port;
}

function pluginOn(port, params) {
  const made = wall([['v', 'vst', params]]);
  const m = made.rack.modules.get('v');
  made.rack.apply({ t: 'msg', id: 'v', msg: { kind: 'bridge', port } });
  return { ...made, m };
}

test('a frame is as long as the host reads it', () => {
  assert.equal(PLUGIN_FRAME, 12 + 256 * 8 + 32 * 5);
});

test('with no plugin on it, a Plugin module passes sound straight through', () => {
  const { rack, run } = wall([['v', 'vst']]);
  const m = rack.modules.get('v');
  m.i[0] = 3;
  run(1);
  assert.equal(m.o[0], 3);
  assert.equal(m.o[1], 3, 'R follows L while it has no cable');
});

test('a Plugin module fades over to the plugin, steady, with nothing late', () => {
  const port = fakePlugin(), { m, run } = pluginOn(port);
  run(200);
  assert.ok(Math.abs(m.o[0] - 2.5) < 1e-3, `${m.o[0]} V: 0.5 from the plugin is 2.5 V on the wall`);
  assert.equal(m.ui[2], 0, 'no block came late');
  assert.ok(port.sent > 30);
});

test('a block that comes late dies away and shows, and the plugin comes back', () => {
  const port = fakePlugin(), { m, run } = pluginOn(port);
  run(200);
  const held = port.deliver;
  port.deliver = () => {};
  run(12);
  assert.equal(m.ui[2], 1, 'it counted one');
  assert.ok(m.ui[1] > 0.5, 'the light is on');
  assert.ok(Math.abs(m.o[0]) < 2.5, 'the sound is dying away, not stuck');
  port.deliver = held;
  port.deliver();
  run(50);
  assert.ok(Math.abs(m.o[0] - 2.5) < 1e-3, 'and it is back');
});

test('after a hiccup the delay does not stay long', () => {
  const port = fakePlugin(), { m, run } = pluginOn(port);
  run(50);
  port.deliver = () => {};
  run(30);
  const { waiting } = port;
  delete port.deliver;
  for (const w of waiting.splice(0)) port.onmessage({ data: w.buffer });
  port.deliver = () => { while (port.waiting.length) port.onmessage({ data: port.waiting.shift().buffer }); };
  run(40);
  assert.ok(m.dsp.back.length <= m.dsp.lead + 1, `${m.dsp.back.length} blocks in hand`);
});

test('BYPASS takes the plugin out of the sound without a jump', () => {
  const port = fakePlugin(), { rack, m, run } = pluginOn(port);
  m.i[0] = 1;
  run(200);
  rack.apply({ t: 'param', id: 'v', k: 'bypass', v: 1 });
  run(1);
  assert.ok(m.o[0] > 1.5, 'still mostly the plugin after a block');
  run(200);
  assert.ok(Math.abs(m.o[0] - 1) < 1e-3, 'only the dry sound left');
});

test('gate and pitch reach an instrument as notes, on the frame they happened', () => {
  const port = fakePlugin(), { m, run } = pluginOn(port);
  run(4);
  m.linked[3] = 1;
  m.i[2] = 1; m.i[3] = 10;
  run(4);
  m.i[3] = 0;
  run(4);
  assert.deepEqual(port.notes.map((n) => n.slice(1)), [[0x90, 72, 100], [0x80, 72, 0]]);
  assert.ok(port.notes[0][0] < 256 && port.notes[1][0] < 256);
});

test('notes from a MIDI port go straight into the block', () => {
  const port = fakePlugin(), { m, run } = pluginOn(port);
  m.dsp.onMessage({ kind: 'midi', data: [0x93, 64, 90] });
  run(4);
  assert.deepEqual(port.notes[0].slice(1), [0x93, 64, 90]);
});
