// The VST3s and Audio Units on the wall. A plugin runs in tools/vst/host.py, reached through a worker
// (src/plugin/line.js), and a module on the audio thread trades blocks with it. A plugin's settings
// can be megabytes, so they're stored by content like a track, and the patch only names them.
import { encodeWav } from '../engine/host.js';
import { HOLDS_FILE, hashOf, loadInto } from './files.js';
import { loadFile, saveFile } from './storage.js';

const JSON_FRAME = 0, FILE_FRAME = 2;
const words = new TextEncoder(), reader = new TextDecoder();

function jsonFrame(job) {
  const text = words.encode(JSON.stringify(job)), frame = new Uint8Array(text.length + 1);
  frame[0] = JSON_FRAME;
  frame.set(text, 1);
  return frame.buffer;
}

function fileFrame(job, samples) {
  const text = words.encode(JSON.stringify(job)), frame = new Uint8Array(5 + text.length + samples.byteLength);
  frame[0] = FILE_FRAME;
  new DataView(frame.buffer).setUint32(1, text.length, true);
  frame.set(text, 5);
  frame.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 5 + text.length);
  return frame.buffer;
}

export class Plugins {
  constructor(graph, host, menu, toast) {
    Object.assign(this, { graph, host, menu, toast });
    this.open = new Map();      // module id → what runs for it
    this.count = 0;
    this.worker = null;
    this.asked = new Map();     // ref → what's waiting for the answer
    this.refs = 0;
    host.plugins = this;
    graph.addEventListener('change', (e) => { if (['structure', 'load', 'data'].includes(e.detail.kind)) this.sync(); });
    graph.addEventListener('rebuild', () => { for (const id of [...this.open.keys()]) this.close(id); });
    host.addEventListener('transport', () => this.sync());
  }

  line() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('../plugin/line.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.gone) this.lost(data.gone);
      else this.heard(data.frame);
    };
    return this.worker;
  }

  ask(job, samples) {
    const ref = ++this.refs;
    return new Promise((resolve, reject) => {
      this.asked.set(ref, { resolve, reject });
      const frame = samples ? fileFrame({ ...job, ref }, samples) : jsonFrame({ ...job, ref });
      this.line().postMessage({ frame }, [frame]);
    });
  }

  heard(frame) {
    const bytes = new Uint8Array(frame);
    let answer, samples = null;
    if (bytes[0] === JSON_FRAME) answer = JSON.parse(reader.decode(bytes.subarray(1)));
    else {
      const size = new DataView(frame).getUint32(1, true);
      answer = JSON.parse(reader.decode(bytes.subarray(5, 5 + size)));
      samples = new Float32Array(frame.slice(5 + size));
    }
    if (answer.problem) this.toast(`A plugin stumbled: ${answer.problem}`);
    const waiting = this.asked.get(answer.ref);
    if (!waiting) return;
    this.asked.delete(answer.ref);
    if (answer.error) waiting.reject(new Error(answer.error));
    else waiting.resolve({ ...answer, samples });
  }

  // It crashed, or was never there. The rack goes on with the plugins bypassed, and until someone
  // picks a plugin again nothing starts over, or a plugin that crashes on load would do so forever.
  lost(why) {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject } of this.asked.values()) reject(new Error(why));
    this.asked.clear();
    for (const [id, live] of this.open) {
      if (live.error) continue;
      live.error = why;
      this.host.post({ t: 'msg', id, msg: { kind: 'bridge', port: null } });
    }
    this.toast(why);
  }

  // Waits for the audio engine: a plugin has to know its sample rate
  sync() {
    if (!this.host.started) return;
    for (const [id, live] of this.open) {
      const node = this.graph.nodes.get(id);
      if (node?.type !== 'vst' || node.data?.plugin !== live.path) this.close(id);
    }
    for (const node of this.graph.nodes.values()) {
      if (node.type === 'vst' && node.data?.plugin && !this.open.has(node.id)) this.start(node);
    }
  }

  async settingsOf(data) {
    const stored = data.state ? await loadFile(data.state).catch(() => null) : null;
    return stored ? reader.decode(stored) : undefined;
  }

  async start(node) {
    const live = { path: node.data.plugin, name: node.data.name, number: ++this.count };
    this.open.set(node.id, live);
    try {
      const state = await this.settingsOf(node.data);
      Object.assign(live, await this.ask({ op: 'open', id: live.number, path: live.path, state, sr: this.host.sampleRate }));
      if (this.open.get(node.id) !== live) return;
      const { port1, port2 } = new MessageChannel();
      this.line().postMessage({ number: live.number, port: port1 }, [port1]);
      this.host.post({ t: 'msg', id: node.id, msg: { kind: 'bridge', port: port2 } }, [port2]);
    } catch (e) {
      live.error = e.message;
      this.toast(`${live.name}: ${e.message}`);
    }
  }

  close(id) {
    const live = this.open.get(id);
    this.open.delete(id);
    if (!live.error) this.ask({ op: 'close', id: live.number }).catch(() => {});
    this.worker?.postMessage({ number: live.number, closed: true });
    if (this.graph.nodes.has(id)) this.host.post({ t: 'msg', id, msg: { kind: 'bridge', port: null } });
  }

  async installed() {
    const res = await fetch('/api/vst/plugins', { headers: { 'Content-Type': 'application/json' } });
    return res.json();
  }

  // What the panel shows
  statusOf(id) {
    const node = this.graph.nodes.get(id), live = this.open.get(id);
    if (!node?.data?.plugin) return { text: 'CHOOSE A PLUGIN' };
    if (live?.error) return { text: node.data.name, error: live.error };
    if (!this.host.started) return { text: `${node.data.name} · PRESS ▶` };
    return { text: node.data.name, ready: !!live?.number && live.window !== undefined, window: live?.window, instrument: live?.instrument };
  }

  // Every plugin found in the folders of this computer, to pick from
  async choose(id, x, y) {
    const { installed, plugins, folders } = await this.installed();
    if (!installed) return this.toast('Plugins need a small helper: run npm run vst:setup');
    if (!plugins.length) return this.toast(`No plugins found in ${folders.join(', ')}`);
    const items = plugins.map((p) => ({ title: p.name, description: p.path, category: p.format, path: p.path }));
    return this.menu.open({ x, y, items, placeholder: 'Search plugins…', onPick: (p) => this.load(id, p.path, p.title) });
  }

  load(id, plugin, name) {
    const node = this.graph.nodes.get(id);
    if (node?.type !== 'vst') throw new Error(`${id} is not a PLUGIN module`);
    if (this.open.has(id)) this.close(id);
    this.graph.setData(id, { plugin, name });
    this.graph.commit();
  }

  async keep(id, state) {
    const node = this.graph.nodes.get(id);
    if (!state || !node) return;
    const bytes = words.encode(state).buffer, hash = await hashOf(bytes);
    if (hash === node.data.state) return;
    await saveFile(hash, bytes);
    this.graph.setData(id, { ...node.data, state: hash });
    this.graph.commit();
  }

  // Its own window, which goes on the screen of this computer. What's set in it is kept when it closes.
  async showWindow(id) {
    const live = this.open.get(id);
    if (!live || live.error) return;
    const { state } = await this.ask({ op: 'window', id: live.number });
    await this.keep(id, state);
  }

  // Burns the plugin's sound into the file of what's patched into it, with the settings it has
  // now. The file is new, so undo gets the old one back. The plugin is bypassed afterwards, or the
  // sound would go through it a second time.
  async print(id, say = () => {}) {
    const live = this.open.get(id), link = this.graph.linkInto(id, 'inL'), source = link && this.graph.nodes.get(link.from);
    if (!live || live.error) throw new Error(live?.error ?? 'nothing runs on that module yet: a plugin starts with the audio, on ▶');
    if (live.instrument) throw new Error('that plugin is an instrument: only an effect can print a file');
    if (!HOLDS_FILE.has(source?.type)) throw new Error('patch a Track Deck, Sampler or Slicer straight into its L input first');
    const buf = this.host.buffers.get(source.id);
    if (!buf) throw new Error('what is patched into it has no file');
    say(`Printing through ${live.name}…`);
    const frames = buf.L.length, whole = new Float32Array(frames * 2);
    whole.set(buf.L);
    whole.set(buf.R ?? buf.L, frames);
    const { state } = await this.ask({ op: 'state', id: live.number });
    await this.keep(id, state);
    const { samples } = await this.ask({ op: 'print', path: live.path, state, sr: buf.sr }, whole);
    const wav = encodeWav([{ L: samples.subarray(0, frames), R: samples.subarray(frames) }], buf.sr);
    const name = `${source.data.file} · ${live.name}`;
    await loadInto(this.host, this.graph, source.id, name, await wav.arrayBuffer(), { stem: source.data.stem });
    this.graph.setParam(id, 'bypass', 1);
    this.graph.commit();
    return { id: source.id, file: name };
  }
}
