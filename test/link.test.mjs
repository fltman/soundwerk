// What the wall tells Patchwerk: the Clock, and how many drums fired. The other end is tested there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/rack/graph.js';
import { Rack } from '../src/engine/rack.js';
import { HITS } from '../src/modules/lib/core.js';
import { PRESETS } from '../src/presets.js';
import { HEAD, SAMPLES, countHits, encodeFrame } from '../src/link/patchwerk.js';

function play(json, seconds) {
  const rack = new Rack({ sampleRate: 48000 });
  for (const n of json.nodes) rack.apply({ t: 'add', id: n.id, type: n.type, params: n.params, depth: n.depth, data: n.data });
  rack.apply({ t: 'links', links: json.links });
  rack.running = true;
  const a = new Float32Array(128), b = new Float32Array(128);
  for (let n = 0; n < seconds * 48000; n += 128) rack.process(a, b, 128);
  return rack;
}

test('every drum voice counts its hits, exactly', () => {
  const json = PRESETS[0].patch();   // four to the floor at 136 BPM
  const g = new Graph();
  g.load(json);
  const rack = play(json, (8 * 240) / 136 + 0.01);   // 8 bars and the first beat of the ninth
  const host = { ui: (id) => rack.modules.get(id).ui };
  const { hits, kinds } = countHits(g, host);
  assert.equal(hits[0], 8 * 4 + 1);
  assert.ok(hits[1] > 8 * 2);
  assert.ok(hits[2] > 8 * 8);
  assert.equal(kinds, 0b111);
});

test('a patch with no drums says so, so the other end knows to listen instead', () => {
  const g = new Graph();
  g.addNode('vco');
  assert.deepEqual(countHits(g, { ui: () => new Float32Array(128) }), { hits: [0, 0, 0], kinds: 0 });
});

test('a clap counts as a snare and a ride as a hat', () => {
  const g = new Graph();
  const clap = g.addNode('clap').id, ride = g.addNode('ride').id;
  const ui = new Float32Array(128);
  ui[HITS] = 3;
  const host = { ui: () => ui };
  const { hits, kinds } = countHits(g, host);
  assert.deepEqual(hits, [0, 3, 3]);
  assert.equal(kinds, 0b110);
  void clap; void ride;
});

test('a frame lays out as Patchwerk reads it', () => {
  const f = new Float32Array(HEAD + SAMPLES);
  encodeFrame(f, { sampleRate: 48000, position: 16.5, bpm: 136, running: true, hits: [1, 2, 3], kinds: 5 });
  assert.deepEqual([...f.subarray(0, HEAD)], [48000, 16.5, 136, 1, 1, 2, 3, 5]);
});
