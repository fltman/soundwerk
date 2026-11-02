// A stretch of a set, faster than real time and with no browser: the real Conductor, Host and Rack,
// so what's heard here is what the set will do.
import { Graph } from '../rack/graph.js';
import { Host } from '../engine/host.js';
import { Rack } from '../engine/rack.js';
import { Conductor } from './conductor.js';

const BLOCK = 128;
const TICK_EVERY = 8;   // blocks: a little faster than the live timer

export async function renderStretch(patch, { at = 0, until, source, sampleRate = 48000, onBlock }) {
  const graph = new Graph();
  const host = new Host(graph);
  const rack = new Rack({ sampleRate, telemetry: host.telemetry });
  host.node = { port: { postMessage: (m) => rack.apply(m) } };
  host.start = async () => {};
  graph.load(patch);
  const conductor = new Conductor({ graph, host, source });
  const started = await conductor.start({ at, manual: true });
  if (!started) throw new Error(conductor.message);
  const bpm = graph.nodes.get(conductor.clock.id).params.bpm;
  const room = Math.ceil((((until - at) * 15) / Math.min(bpm, 60)) * sampleRate);
  const L = new Float32Array(room), R = new Float32Array(room), blockL = new Float32Array(BLOCK), blockR = new Float32Array(BLOCK);
  let n = 0, block = 0;
  const steps = [];   // { sample, step }: where each 16th of the set fell, read off the Clock
  let last = -1;
  while (n + BLOCK <= room) {
    if (block++ % TICK_EVERY === 0) await conductor.tick();
    rack.process(blockL, blockR, BLOCK);
    L.set(blockL, n);
    R.set(blockR, n);
    n += BLOCK;
    const pos = conductor.position(), now = pos === null ? -1 : Math.floor(pos - conductor.base);
    if (now !== last) { steps.push({ sample: n, step: now }); last = now; }
    onBlock?.(conductor, graph, n);
    if (!conductor.running || now >= until) break;
  }
  return { L: L.subarray(0, n), R: R.subarray(0, n), sampleRate, steps, conductor, graph, rack };
}
