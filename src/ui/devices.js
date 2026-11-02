// The world outside the browser tab: the microphone, MIDI gear and the computer keyboard.
// Asked for only once a module on the wall actually needs them.
import { paramRange } from '../modules/index.js';

const KEYS = 'awsedftgyhujkolp;'; // a white-and-black layout from C

export class Devices {
  constructor(graph, host, wall, toast) {
    Object.assign(this, { graph, host, wall, toast });
    this.midi = null;
    this.octave = 4;
    this.held = new Map();
    this.learning = null;
    host.devices = this;
    graph.addEventListener('change', (e) => {
      if (e.detail.kind === 'structure' || e.detail.kind === 'load') this.check();
    });
    host.addEventListener('transport', () => this.check());
    host.addEventListener('midi-out', (e) => this.playOut(e.detail));
    wall.addEventListener('midi-learn', (e) => this.learn(e.detail));
    addEventListener('keydown', (e) => this.key(e, true), true);
    addEventListener('keyup', (e) => this.key(e, false), true);
    addEventListener('blur', () => this.allOff());
  }

  allOff() {
    for (const note of this.held.values()) this.send([0x80, note, 0]);
    this.held.clear();
  }

  has(type) { return [...this.graph.nodes.values()].some((n) => n.type === type); }

  check() {
    if (this.has('audioin') && this.host.started && !this.host.micStream) {
      this.host.enableMic().catch((e) => this.toast(`No audio input: ${e.message}`));
    }
    if (this.has('midi') || this.has('midiout') || Object.keys(this.graph.midiMap).length) this.access().catch(() => this.toast('MIDI is not available; the keyboard still plays the MIDI module'));
  }

  access() {
    if (!navigator.requestMIDIAccess) return Promise.reject(new Error('this browser has no MIDI'));
    this.asked ??= navigator.requestMIDIAccess().then((access) => {
      this.midi = access;
      const hook = () => { for (const input of access.inputs.values()) input.onmidimessage = (m) => this.heard(input.name, [...m.data]); };
      hook();
      access.onstatechange = hook;
    });
    return this.asked;
  }

  // The names of the ports there are, for the panels
  ports(dir) { return this.midi ? [...this.midi[dir === 'in' ? 'inputs' : 'outputs'].values()].map((p) => p.name) : []; }

  heard(device, data) {
    if (this.control(data)) return;
    this.send(data, device);
  }

  send(data, device) {
    for (const n of this.graph.nodes.values()) {
      if (n.type !== 'midi' && n.type !== 'vst') continue;
      if (!device || !n.data?.device || n.data.device === device) this.host.send(n.id, { kind: 'midi', data });
    }
  }

  // Sent ahead, to arrive with the sound it belongs to. A port's clock is the page's, so what the
  // audio clock said gets moved over by what's reaching the speakers right now.
  playOut({ id, events }) {
    if (!this.midi) return;
    const outputs = [...this.midi.outputs.values()], chosen = this.graph.nodes.get(id)?.data?.device;
    const port = outputs.find((p) => p.name === chosen) ?? outputs[0];
    if (!port) return;
    const { contextTime, performanceTime } = this.host.ctx.getOutputTimestamp();
    for (const { at, data } of events) port.send(data, performanceTime + (at - contextTime) * 1000);
  }

  async learn({ id, name, label }) {
    try {
      await this.access();
      this.learning = { id, name, label };
      this.toast(`Move a control on your MIDI gear for ${label}`);
    } catch { this.toast('MIDI is not available in this browser'); }
  }

  // A control that's been learned turns its knob; while learning, the next one to move is it
  control([status, cc, value]) {
    if ((status & 0xf0) !== 0xb0) return false;
    const key = `${status & 15}:${cc}`, g = this.graph;
    if (this.learning) {
      const { id, name, label } = this.learning;
      this.learning = null;
      g.midiMap[key] = { id, name };
      g.commit();
      this.toast(`CC ${cc} turns ${label}`);
      return true;
    }
    const bound = g.midiMap[key], node = bound && g.nodes.get(bound.id);
    const p = node && g.def(node).params?.find((q) => q.name === bound.name);
    if (!p) return false;
    const r = paramRange(p), v = r.min + (value / 127) * (r.max - r.min);
    g.setParam(bound.id, bound.name, r.step ? Math.round(v / r.step) * r.step : v);
    clearTimeout(this.settling);
    this.settling = setTimeout(() => g.commit(), 300);
    return true;
  }

  // with a MIDI module selected, the keyboard is a keyboard; z and x change octave
  key(e, down) {
    // a note that is down always comes up, whatever happened to the selection meanwhile
    if (!down && this.held.has(e.key.toLowerCase())) {
      const k = e.key.toLowerCase();
      this.send([0x80, this.held.get(k), 0]);
      this.held.delete(k);
      e.stopPropagation();
      return;
    }
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const selected = [...this.wall.selected].some((id) => this.graph.nodes.get(id)?.type === 'midi');
    if (!selected) return;
    const k = e.key.toLowerCase();
    if (down && !e.repeat && (k === 'z' || k === 'x')) {
      this.octave = Math.max(1, Math.min(7, this.octave + (k === 'x' ? 1 : -1)));
      e.stopPropagation();
      return;
    }
    const i = KEYS.indexOf(k);
    if (i < 0) return;
    e.stopPropagation();
    if (e.repeat) return;
    if (down) {
      const note = (this.octave + 1) * 12 + i;
      this.held.set(k, note);
      this.send([0x90, note, 100]);
    }
  }
}
