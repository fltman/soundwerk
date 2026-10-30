// Plays a patch faster than real time, with no browser: for the tests, the bounce tool, and the
// assistant's `listen`. Exactly the same Rack the worklet runs.
import { Rack } from '../engine/rack.js';
import { getDef, outputPorts } from '../modules/index.js';

export function renderPatch(json, { seconds = 8, sampleRate = 48000, buffers = {} } = {}) {
  const rack = new Rack({ sampleRate });
  for (const n of json.nodes) {
    rack.apply({ t: 'add', id: n.id, type: n.type, params: n.params, depth: n.depth, data: n.data, code: n.code });
    if (buffers[n.id]) rack.apply({ t: 'msg', id: n.id, msg: { kind: 'buffer', ...buffers[n.id] } });
  }
  rack.apply({ t: 'links', links: json.links });
  rack.running = true;
  const N = Math.round(seconds * sampleRate);
  const L = new Float32Array(N), R = new Float32Array(N);
  const blockL = new Float32Array(128), blockR = new Float32Array(128);
  const peaks = new Map();   // "n3.out" → loudest the cable ever got
  for (let n = 0; n < N; n += 128) {
    rack.process(blockL, blockR, 128);
    const len = Math.min(128, N - n);
    L.set(blockL.subarray(0, len), n);
    R.set(blockR.subarray(0, len), n);
    for (const m of rack.modules.values()) {
      for (let k = 0; k < m.outs.length; k++) {
        const key = `${m.id}.${m.outs[k].name}`;
        const v = m.ui[104 + k];
        if (v > (peaks.get(key) ?? 0)) peaks.set(key, v);
      }
    }
  }
  return { L, R, sampleRate, peaks };
}

// Which cables went nowhere: a patched output that never moved, a master that heard nothing.
export function deadCables(json, peaks) {
  const dead = [];
  for (const l of json.links) {
    const node = json.nodes.find((n) => n.id === l.from);
    const def = node && getDef(node.type);
    if (!def || node.type === 'code') continue;
    const port = outputPorts(def).find((p) => p.name === l.fromPort);
    if (port && (peaks.get(`${l.from}.${l.fromPort}`) ?? 0) < 1e-3) dead.push(`${l.from}.${l.fromPort} (${node.type})`);
  }
  return [...new Set(dead)];
}
