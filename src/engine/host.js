// The main thread's end of the engine: keeps the worklet's rack in step with the graph,
// and reads back what the wall shows from shared memory.
import { TEL, telemetrySize } from './rack.js';
import { Ear } from '../dj/ear.js';

const stable = (v) => JSON.stringify(v ?? null);

export class Host extends EventTarget {
  constructor(graph) {
    super();
    this.graph = graph;
    this.telemetry = new Float32Array(new SharedArrayBuffer(telemetrySize() * 4));
    this.live = new Map();      // what the worklet has: id → { slot, wave, type, code, params, depth, data }
    this.freeSlots = [];
    this.nextSlot = 0;
    this.freeWaves = [];
    this.nextWave = 0;
    this.ctx = null;
    this.node = null;
    this.running = false;
    this.recording = null;
    this.buffers = new Map();   // id → decoded audio file, resent when a module comes back after an undo
    this.micStream = null;

    graph.addEventListener('rebuild', () => this.forget());
    graph.addEventListener('change', (e) => {
      const { kind, id, name, value, data } = e.detail;
      if (kind === 'structure' || kind === 'load') {
        // anything held for a downbeat goes in first, or it would land on top of this
        if (!this.held) this.post({ t: 'flush' });
        this.sync();
      } else if (kind === 'param') {
        const l = this.live.get(id);
        if (l) l.params[name] = value;
        this.post({ t: 'param', id, k: name, v: value });
      } else if (kind === 'depth') {
        const l = this.live.get(id);
        if (l) l.depth[name] = value;
        this.post({ t: 'depth', id, k: name, v: value });
      } else if (kind === 'data') {
        const l = this.live.get(id);
        if (l) l.data = stable(data);
        this.post({ t: 'data', id, data });
      }
    });
  }

  post(msg, transfer) {
    if (this.held) { this.held.push(msg); if (transfer) this.heldBytes.push(...transfer); }
    else this.node?.port.postMessage(msg, transfer ?? []);
  }

  // Whatever fn does to the patch reaches the engine on that step of that Clock, not before.
  at(clock, step, fn) {
    this.held = [];
    this.heldBytes = [];
    try { fn(); } finally {
      const msgs = this.held;
      this.held = null;
      this.post({ t: 'at', clock, step, msgs }, this.heldBytes);   // files move, a copy would land on the audio thread
    }
  }

  get started() { return !!this.node; }
  get sampleRate() { return this.ctx?.sampleRate ?? 48000; }

  // browsers only make sound after a gesture, so this happens on the first ▶
  async start() {
    this.booting ??= this.boot();
    await this.booting;
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async boot() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('src/engine/worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'soundwerk', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { sab: this.telemetry.buffer },
    });
    this.node.port.onmessage = (e) => {
      if (e.data.t === 'rec' && this.recording) this.recording.push(e.data);
      if (e.data.t === 'error') this.dispatchEvent(new CustomEvent('module-error', { detail: e.data }));
      if (e.data.t === 'midi') this.dispatchEvent(new CustomEvent('midi-out', { detail: e.data }));
    };
    this.node.onprocessorerror = (e) => console.error('the audio engine stopped', e.message ?? e);
    this.node.connect(this.ctx.destination);
    this.ear = new Ear(this.ctx, this.node);
    this.live.clear();
    this.freeSlots = [];
    this.nextSlot = 0;
    this.freeWaves = [];
    this.nextWave = 0;
    this.sync();
    for (const [id, buf] of this.buffers) this.sendBuffer(id, buf);
    this.post({ t: 'run', on: this.running });
  }

  // A whole new patch starts clean: fresh clocks fire their reset, so every sequencer on the new
  // wall lines up. Undo goes through sync() instead, and keeps everything that stays.
  forget() {
    this.post({ t: 'flush' });
    for (const [id, l] of this.live) {
      this.post({ t: 'remove', id });
      this.freeSlots.push(l.slot);
      if (l.wave >= 0) this.freeWaves.push(l.wave);
    }
    this.live.clear();
  }

  setRunning(on) {
    this.running = on;
    this.post({ t: 'run', on });
    this.dispatchEvent(new CustomEvent('transport'));
  }

  // bring the worklet to what the graph says, touching only what differs
  sync() {
    const g = this.graph;
    for (const [id, l] of this.live) {
      if (g.nodes.has(id) && g.nodes.get(id).type === l.type) continue;
      this.post({ t: 'remove', id });
      this.freeSlots.push(l.slot);
      if (l.wave >= 0) this.freeWaves.push(l.wave);
      this.live.delete(id);
      this.buffers.delete(id);
    }
    for (const node of g.nodes.values()) {
      const def = g.def(node);
      const l = this.live.get(node.id);
      if (!l) {
        const slot = this.freeSlots.pop() ?? this.nextSlot++;
        const wave = def.wave ? (this.freeWaves.pop() ?? (this.nextWave < TEL.WAVES ? this.nextWave++ : -1)) : -1;
        this.live.set(node.id, { slot, wave, type: node.type, code: node.code, params: { ...node.params }, depth: { ...node.depth }, data: stable(node.data) });
        this.post({ t: 'add', id: node.id, type: node.type, slot, waveSlot: wave, params: node.params, depth: node.depth, data: node.data, code: node.code });
        if (this.buffers.get(node.id)?.hash === node.data?.hash && this.buffers.has(node.id)) this.sendBuffer(node.id, this.buffers.get(node.id));
        continue;
      }
      if (l.code !== node.code) { l.code = node.code; this.post({ t: 'code', id: node.id, code: node.code }); }
      for (const [k, v] of Object.entries(node.params)) {
        if (l.params[k] !== v) { l.params[k] = v; this.post({ t: 'param', id: node.id, k, v }); }
      }
      for (const [k, v] of Object.entries(node.depth)) {
        if (l.depth[k] !== v) { l.depth[k] = v; this.post({ t: 'depth', id: node.id, k, v }); }
      }
      for (const k of Object.keys(l.depth)) {
        if (!(k in node.depth)) { delete l.depth[k]; this.post({ t: 'depth', id: node.id, k, v: 0.5 }); }
      }
      const data = stable(node.data);
      if (data !== l.data) { l.data = data; this.post({ t: 'data', id: node.id, data: node.data }); }
    }
    this.post({ t: 'links', links: [...g.links.values()] });
  }

  ui(id) {
    const l = this.live.get(id);
    if (!l) return null;
    const a = TEL.GLOBAL + TEL.UI * l.slot;
    return this.telemetry.subarray(a, a + TEL.UI);
  }

  wave(id) {
    const l = this.live.get(id);
    if (!l || l.wave < 0) return null;
    const a = TEL.GLOBAL + TEL.UI * TEL.SLOTS + TEL.WAVE * l.wave;
    return this.telemetry.subarray(a, a + TEL.WAVE);
  }

  get cpu() { return this.telemetry[0]; }
  get peaks() { return [this.telemetry[1], this.telemetry[2]]; }

  // ── sound from outside ──────────────────────────────────
  setBuffer(id, buf) {
    this.buffers.set(id, buf);
    this.sendBuffer(id, buf);
  }

  clearBuffer(id) {
    this.buffers.delete(id);
    this.post({ t: 'msg', id, msg: { kind: 'clear' } });
  }

  sendBuffer(id, buf) {
    // the wall keeps its copy for the waveform display, so the worklet gets its own
    const copy = { kind: 'buffer', L: buf.L.slice(), R: buf.R?.slice(), sr: buf.sr, grid: buf.grid?.slice(), kicks: buf.kicks?.slice() };
    this.post({ t: 'msg', id, msg: copy }, [copy.L.buffer, ...(copy.R ? [copy.R.buffer] : [])]);
  }

  send(id, msg) { this.post({ t: 'msg', id, msg }); }

  enableMic() {
    if (!this.ctx) return Promise.resolve();
    this.micAsked ??= navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then((stream) => {
      this.micStream = stream;
      this.ctx.createMediaStreamSource(stream).connect(this.node);
    }).catch((e) => {
      this.micAsked = null;
      throw e;
    });
    return this.micAsked;
  }

  // ── recording: what reaches the speakers, as a 32-bit float WAV ──
  startRecording() {
    this.recording = [];
    this.post({ t: 'rec', on: true });
  }

  async stopRecording() {
    this.post({ t: 'rec', on: false });
    await new Promise((r) => setTimeout(r, 120));
    const chunks = this.recording ?? [];
    this.recording = null;
    return encodeWav(chunks, this.sampleRate);
  }
}

export function encodeWav(chunks, sr) {
  const frames = chunks.reduce((n, c) => n + c.L.length, 0);
  const bytes = 44 + frames * 8;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 8, true); v.setUint16(32, 8, true); v.setUint16(34, 32, true);
  str(36, 'data'); v.setUint32(40, frames * 8, true);
  const out = new Float32Array(buf, 44);
  let k = 0;
  for (const c of chunks) for (let i = 0; i < c.L.length; i++) { out[k++] = c.L[i]; out[k++] = c.R[i]; }
  return new Blob([buf], { type: 'audio/wav' });
}
