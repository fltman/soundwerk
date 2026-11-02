// Sound files onto the wall: decode, find the beat grid, hand them to a Track Deck or a Sampler.
import { sixteenthGrid } from '../analysis/analysis.js';
import { findGap, widthOf } from '../rack/place.js';
import { saveFile, loadFile } from './storage.js';
import { stemLag } from '../set/track.js';

export const HOLDS_FILE = new Set(['deck', 'sampler', 'slicer']);

export async function decode(data) {
  const ctx = new OfflineAudioContext(2, 1, 48000);
  const b = await ctx.decodeAudioData(data.slice(0));
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  return { L: L.slice(), R: R.slice(), sr: b.sampleRate };
}

export function analyse(L, R, sr, cut = {}) {
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../analysis/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.result) { resolve(e.data.result); worker.terminate(); }
    };
    worker.onerror = (e) => { reject(new Error(e.message)); worker.terminate(); };
    worker.postMessage({ samples: mono, sampleRate: sr, ...cut }, [mono.buffer]);
  });
}

export const hashOf = async (data) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function loadInto(host, graph, id, name, data, { hash, remember = true, stem, mix, source } = {}) {
  hash ??= await hashOf(data);
  const buf = await decode(data);
  buf.name = name;
  buf.hash = hash;
  const node = graph.nodes.get(id);
  if (node?.type === 'deck') {
    const a = await analyse(buf.L, buf.R, buf.sr);
    buf.grid = sixteenthGrid(a.beats, a.downbeat);
    buf.kicks = Float64Array.from(a.kicks);
    buf.bpm = a.bpm;
  }
  let cut = null;
  if (node?.type === 'slicer' && remember) {   // coming back from storage, the patch still has its slices
    ({ cut } = await analyse(buf.L, buf.R, buf.sr, { slices: true, stem, mix }));
    buf.bpm = cut.bpm;
    buf.slices = cut.pool.length;
  }
  if (!graph.nodes.has(id)) return buf;   // deleted while it was decoding
  if (!remember && graph.nodes.get(id).data?.hash !== hash) return buf;   // undone while it was decoding
  host.setBuffer(id, buf);
  if (remember) {
    graph.setData(id, { file: name, hash, bpm: buf.bpm, ...cut, ...(source ? { source } : {}) });
    await saveFile(hash, data).catch(() => {});
  }
  return buf;
}

// After any load, undo or redo: every deck and sampler plays exactly the file the patch names.
// Files are stored by content, so two files called kick.wav stay two files.
export async function restoreFiles(host, graph) {
  for (const [id, buf] of [...host.buffers]) {
    if (graph.nodes.get(id)?.data?.hash !== buf.hash) host.clearBuffer(id);
  }
  for (const n of graph.nodes.values()) {
    if (!HOLDS_FILE.has(n.type) || !n.data?.hash || host.buffers.has(n.id)) continue;
    let data = await loadFile(n.data.hash).catch(() => null);
    // what the server keeps: this browser may never have seen it
    if (!data && /^\/(api\/stems|demo)\//.test(n.data.source)) data = await fetch(n.data.source).then((r) => (r.ok ? r.arrayBuffer() : null), () => null);
    if (data) await loadInto(host, graph, n.id, n.data.file, data, { hash: n.data.hash, remember: false });
  }
}

const QUIET_STEM = -50;   // dB under full scale: below this Demucs found nothing there
const rmsDb = (x) => {
  let sum = 0;
  for (let i = 0; i < x.length; i += 8) sum += x[i] * x[i];
  return 10 * Math.log10((sum / (x.length / 8)) + 1e-12);
};

// Splits a Slicer's track with Demucs, on this machine, and hangs a Slicer for every stem that has
// something in it next to the first, on the same clock. Their slices are cut on the whole track's
// beat, so what comes from one bar of the track is still one bar across all of them.
export async function splitStems(host, graph, id, say = () => {}) {
  const node = graph.nodes.get(id);
  if (node?.type !== 'slicer') throw new Error(`${id} is not a Slicer`);
  if (!node.data?.hash) throw new Error('drop a track on the Slicer first');
  if (node.data.stem) throw new Error('that Slicer already holds a stem');
  const data = await loadFile(node.data.hash);
  if (!data) throw new Error('the track is not in this browser any more: drop it on the Slicer again');
  say('Separating the stems…');
  const res = await fetch('/api/stems', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error);
  say('Cutting the stems…');
  const buf = host.buffers.get(id) ?? await decode(data);
  const { bpm, beats, downbeat } = await analyse(buf.L, buf.R, buf.sr);
  const mix = { bpm, beats, downbeat, key: node.data.key };
  const made = [], skipped = [];
  let lag = null;
  for (const stem of json.stems) {
    const source = `/api/stems/${json.id}/${stem}`;
    const bytes = await (await fetch(source)).arrayBuffer();
    const heard = await decode(bytes);
    if (rmsDb(heard.L) < QUIET_STEM) { skipped.push(stem); continue; }
    // decoded apart, a stem doesn't have to start where its mix does; they all start alike
    lag ??= stemLag(buf.L, heard.L, buf.sr);
    mix.beats = Float64Array.from(beats, (t) => t + lag);
    const fresh = graph.addNode('slicer', 0, 0);
    const at = findGap(graph, widthOf(graph, fresh), { startRow: node.row, skip: new Set([fresh.id]) });
    graph.moveNode(fresh.id, at.row, at.hp);
    for (const port of ['clk', 'rst']) {
      const l = graph.linkInto(id, port);
      if (l) graph.connect(l.from, l.fromPort, fresh.id, port);
    }
    await loadInto(host, graph, fresh.id, `${node.data.file} · ${stem}`, bytes, { stem, mix, source });
    made.push({ id: fresh.id, stem });
  }
  graph.commit();
  return { made, skipped, seconds: json.seconds };
}
