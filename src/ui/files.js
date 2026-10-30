// Sound files onto the wall: decode, find the beat grid, hand them to a Track Deck or a Sampler.
import { saveFile, loadFile } from './storage.js';

export async function decode(data) {
  const ctx = new OfflineAudioContext(2, 1, 48000);
  const b = await ctx.decodeAudioData(data.slice(0));
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  return { L: L.slice(), R: R.slice(), sr: b.sampleRate };
}

function analyse(L, R, sr) {
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../analysis/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.result) { resolve(e.data.result); worker.terminate(); }
    };
    worker.onerror = (e) => { reject(new Error(e.message)); worker.terminate(); };
    worker.postMessage({ samples: mono, sampleRate: sr }, [mono.buffer]);
  });
}

// Sixteenths from the first downbeat on, interpolated between tracked beats, so the wall
// follows the track's real timing instead of a fixed tempo.
export function sixteenthGrid(beats, downbeat) {
  const grid = [];
  for (let i = downbeat; i + 1 < beats.length; i++) {
    for (let k = 0; k < 4; k++) grid.push(beats[i] + ((beats[i + 1] - beats[i]) * k) / 4);
  }
  return Float64Array.from(grid);
}

const hashOf = async (data) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function loadInto(host, graph, id, name, data, { hash, remember = true } = {}) {
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
  if (!graph.nodes.has(id)) return buf;   // deleted while it was decoding
  if (!remember && graph.nodes.get(id).data?.hash !== hash) return buf;   // undone while it was decoding
  host.setBuffer(id, buf);
  if (remember) {
    graph.setData(id, { file: name, hash, bpm: buf.bpm });
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
    if ((n.type !== 'deck' && n.type !== 'sampler') || !n.data?.hash || host.buffers.has(n.id)) continue;
    const data = await loadFile(n.data.hash).catch(() => null);
    if (data) await loadInto(host, graph, n.id, n.data.file, data, { hash: n.data.hash, remember: false });
  }
}
