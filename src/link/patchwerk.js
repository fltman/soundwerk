// Sends Patchwerk what the wall is playing. It could work most of this out from the sound, but this
// side knows: where the Clock is, which drums fired, and the shape of the DJ's set. The sound goes
// along for the bands and the scopes. Patchwerk's server passes it on to its pages.
import { HITS } from '../modules/lib/core.js';

export const SAMPLES = 2048;
export const HEAD = 8;          // sampleRate, position, bpm, running, kicks, snares, hats, kinds
const EVERY = 20;               // ms; a timer, not a frame: Patchwerk may well be the window in front
const RETRY = 2000;
const BACKLOG = 1 << 17;        // bytes queued on the socket: past this, skip a frame
const DRUMS = { kick: 0, snare: 1, clap: 1, hats: 2, ride: 2 };   // what counts as which

// Hit counts per kind of drum, and a bit for each kind this patch has at all
export function countHits(graph, host) {
  const hits = [0, 0, 0];
  let kinds = 0;
  for (const n of graph.nodes.values()) {
    const kind = DRUMS[n.type];
    if (kind === undefined) continue;
    kinds |= 1 << kind;
    hits[kind] += host.ui(n.id)?.[HITS] ?? 0;
  }
  return { hits, kinds };
}

export function encodeFrame(out, { sampleRate, position, bpm, running, hits, kinds }) {
  out.set([sampleRate, position, bpm, running ? 1 : 0, hits[0], hits[1], hits[2], kinds]);
}

export class PatchwerkLink extends EventTarget {
  constructor({ graph, host, dj, url = 'ws://localhost:8270/api/live?role=source' }) {
    super();
    Object.assign(this, { graph, host, dj, url });
    this.wanted = false;
    this.connected = false;
    this.ws = null;
    this.frame = new Float32Array(HEAD + SAMPLES);
    this.said = '';
  }

  state() { this.dispatchEvent(new Event('state')); }

  toggle(on = !this.wanted) {
    this.wanted = on;
    if (on) {
      this.connect();
      this.timer = setInterval(() => this.send(), EVERY);
    } else {
      clearInterval(this.timer);
      clearTimeout(this.retry);
      this.ws?.close();
      this.ws = null;
      this.analyser?.disconnect();
      this.analyser = null;
    }
    this.state();
  }

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.said = ''; this.state(); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.state();
      if (this.wanted) this.retry = setTimeout(() => this.connect(), RETRY);
    };
  }

  send() {
    const { ws, host, graph, frame } = this;
    if (ws?.readyState !== WebSocket.OPEN || !host.started || ws.bufferedAmount > BACKLOG) return;
    if (!this.analyser) {
      this.analyser = host.ctx.createAnalyser();
      this.analyser.fftSize = SAMPLES;
      host.node.connect(this.analyser);
    }
    const clock = [...graph.nodes.values()].find((n) => n.type === 'clock');
    const now = performance.now() / 1000;
    encodeFrame(frame, {
      sampleRate: host.sampleRate,
      position: clock ? host.ui(clock.id)?.[3] ?? 0 : now * 8,   // no Clock: a steady 120
      bpm: clock?.params.bpm ?? 120,
      running: host.running,
      ...countHits(graph, host),
    });
    this.analyser.getFloatTimeDomainData(frame.subarray(HEAD));
    ws.send(frame);
    this.sendArc();
  }

  // The shape of the DJ's set, when one is on: only when it changes, and as text
  sendArc() {
    const { dj } = this;
    const text = JSON.stringify(dj.running && dj.bar !== null ? { arc: dj.rig.arc, origin: dj.bar - dj.played } : { arc: null });
    if (text === this.said) return;
    this.said = text;
    this.ws.send(text);
  }
}
