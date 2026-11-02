// The Set on the wall, away from the audio thread: tracks in, and a plan heard before it's kept.
import { analyse, decode, hashOf } from './files.js';
import { loadFile, saveFile } from './storage.js';
import { wordsOf } from '../analysis/material.js';
import { checkPlan, editedPlan, setNode, settledPlan } from '../set/plan.js';
import { clipOf, jobsOf, reportLine } from '../set/audition.js';
import { STEMS, cutPiece, gridOf, pieceKey, planOf } from '../set/score.js';
import { stemLag } from '../set/track.js';

const bytesOf = async (t) => (await loadFile(t.hash).catch(() => null)) ?? (t.source ? fetch(t.source).then((r) => (r.ok ? r.arrayBuffer() : null), () => null) : null);

const fetched = (url) => fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))));

// A decoded stem takes a lot of room and a plan keeps asking for the same ones
const MOST_KEPT = 2;
const kept = new Map();
async function openStem(t, stem) {
  const key = `${t.hash}:${stem}`;
  if (!kept.has(key)) {
    kept.set(key, decode(await fetched(`/api/stems/${t.stems.id}/${stem}`)));
    if (kept.size > MOST_KEPT) kept.delete(kept.keys().next().value);
  }
  return kept.get(key);
}

// Audio for the conductor
export const setSource = {
  async track(t) {
    const data = await bytesOf(t);
    if (!data) throw new Error(`${t.file} is not in this browser any more: drop it on the Set again`);
    return decode(data);
  },
  stem: openStem,
};

// Demucs and Whisper, on this machine, once for each file: what there is to sample in a track. A
// machine without them still plays sets, with samples of the whole mix.
async function sampleable(data, buf, track, say) {
  const res = await fetch('/api/stems', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  if (!res.ok) return {};
  const { id } = await res.json();
  say('Reading the stems…');
  const audio = await Promise.all(STEMS.map(async (stem) => decode(await fetched(`/api/stems/${id}/${stem}`))));
  const lag = stemLag(buf.L, audio[0].L, buf.sr), grid = gridOf(track).map((x) => x + lag);
  const stems = Object.fromEntries(STEMS.map((stem, i) => [stem, Float32Array.from(audio[i].L, (v, k) => (v + audio[i].R[k]) / 2)]));
  const material = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../analysis/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { if (e.data.result) { worker.terminate(); resolve(e.data.result); } };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ stems, grid, bars: track.bars, phase: track.phase, sampleRate: buf.sr }, Object.values(stems).map((x) => x.buffer));
  });
  say('Listening for words…');
  const heard = await fetch(`/api/words/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => (r.ok ? r.json() : null), () => null);
  return { stems: { id, lag }, material, ...(heard?.segments.length ? { words: wordsOf(heard.segments, grid) } : {}) };
}

// A dropped playlist goes in file-name order: that's how a numbered playlist comes off a disk.
// files: [{ name, data, source? }]
export async function addTracks(graph, id, files, say = () => {}) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const [i, f] of sorted.entries()) {
    const node = graph.nodes.get(id);
    if (!node) return;
    say(`Measuring ${f.name} (${i + 1} of ${sorted.length})…`);
    const hash = await hashOf(f.data);
    if (node.data.tracks.some((t) => t.hash === hash)) continue;
    const buf = await decode(f.data);
    const { track } = await analyse(buf.L, buf.R, buf.sr, { track: true });
    await saveFile(hash, f.data).catch(() => {});
    say(`Separating ${f.name} (${i + 1} of ${sorted.length}), about a minute…`);
    const extra = await sampleable(f.data, buf, { ...track, hash }, say).catch(() => ({}));
    if (!graph.nodes.has(id)) return;
    graph.setData(id, { ...graph.nodes.get(id).data, tracks: [...graph.nodes.get(id).data.tracks, { file: f.name, hash, ...track, ...extra, ...(f.source ? { source: f.source } : {}) }], plan: null });
  }
  graph.commit();
}

async function hear(patch, tracks, only, clip) {
  const { plan } = patch.nodes.find((n) => n.type === 'set').data, jobs = jobsOf(plan, only), spans = clip ? [...jobs, clip] : jobs;
  if (!spans.length) return { ok: true, passages: [] };
  const heard = (from, to) => spans.some((j) => j.at < to * 16 && j.until > from * 16);
  const used = [...new Set(plan.tracks.filter((e) => heard(e.at, e.at + e.leave - e.enter)).map((e) => tracks[e.track]))];
  const decoded = await Promise.all(used.map((t) => setSource.track(t)));
  const audio = Object.fromEntries(used.map((t, i) => [t.hash, decoded[i]]));
  const pieces = {};
  for (const move of plan.moves) {
    for (const op of move.ops) {
      if (op.op !== 'sample' || !heard(move.at, move.until)) continue;
      const t = tracks[op.track], from = await (op.stem ? setSource.stem(t, op.stem) : setSource.track(t));
      pieces[pieceKey(t, op)] = cutPiece(t, op, from, plan.tracks.find((e) => e.track === op.track)?.nudge);
    }
  }
  const bytes = [...decoded, ...Object.values(pieces)].flatMap((a) => (a.R === a.L ? [a.L.buffer] : [a.L.buffer, a.R.buffer]));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../set/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { worker.terminate(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result); };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ patch, audio, pieces, only, clip }, bytes);
  });
}

// A plan from the assistant, checked and rendered, with what was measured for it to read. With an
// edit, only `only`, the bars it changed, get rendered, and what `before` knew stays.
async function audition(graph, raw, { before, only, clip } = {}) {
  const { plan, problems } = checkPlan(graph, raw);
  if (problems.length) return { saved: false, lines: problems.map((p) => `✗ ${p}`) };
  const id = setNode(graph).id;
  const patch = graph.toJSON(), tracks = patch.nodes.find((n) => n.id === id).data.tracks;
  patch.nodes.find((n) => n.id === id).data = { tracks, plan };
  const heard = await hear(patch, tracks, only, clip);
  if (!graph.nodes.has(id)) return { saved: false, lines: ['✗ the Set left the wall while the plan was being heard'] };
  const kept = settledPlan(plan, heard.passages, before, only);
  return { saved: true, ok: kept.plan.ok, plan: kept.plan, left: kept.left, only, wav: heard.wav, lines: heard.passages.map(reportLine), problems: heard.passages.flatMap((p) => p.problems) };
}

export function keepPlan(graph, plan) {
  const id = setNode(graph).id;
  graph.setData(id, { ...graph.nodes.get(id).data, plan });
  graph.commit();
}

export async function installPlan(graph, raw, options) {
  const r = await audition(graph, raw, options);
  if (r.saved) keepPlan(graph, r.plan);
  return r;
}

export async function installEdit(graph, edit) {
  const before = planOf(setNode(graph));
  if (!before) return { saved: false, lines: ['✗ there is no plan to change yet: use set_plan'] };
  const { raw, only, problems } = editedPlan(before, edit);
  if (problems.length) return { saved: false, lines: problems.map((p) => `✗ ${p}`) };
  return installPlan(graph, raw, { before, only });
}

// Versions of a stretch of the plan around `bar`, each checked and rendered and none of them kept.
// The same bars come back from each as sound in `wav`.
export async function tryVersions(graph, { remove, options }, bar) {
  const before = planOf(setNode(graph));
  const edits = options.map((o) => editedPlan(before, { remove, add: o.add, tracks: o.tracks }));
  const clip = clipOf(before, bar, edits.map((e) => e.only));
  return Promise.all(edits.map(({ raw, only, problems }) => (problems.length ? { saved: false, lines: problems.map((p) => `✗ ${p}`) } : audition(graph, raw, { before, only, clip }))));
}
