// The world outside the browser tab: the microphone, MIDI gear and the computer keyboard.
// Asked for only once a module on the wall actually needs them.
const KEYS = 'awsedftgyhujkolp;'; // a white-and-black layout from C

export class Devices {
  constructor(graph, host, wall, toast) {
    Object.assign(this, { graph, host, wall, toast });
    this.midi = null;
    this.octave = 4;
    this.held = new Map();
    graph.addEventListener('change', (e) => {
      if (e.detail.kind === 'structure' || e.detail.kind === 'load') this.check();
    });
    host.addEventListener('transport', () => this.check());
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
    if (this.has('midi') && !this.midi && navigator.requestMIDIAccess) {
      this.midi = 'asked';
      navigator.requestMIDIAccess().then((access) => {
        this.midi = access;
        const hook = () => { for (const input of access.inputs.values()) input.onmidimessage = (m) => this.send([...m.data]); };
        hook();
        access.onstatechange = hook;
      }).catch(() => this.toast('MIDI is not available; the keyboard still plays the MIDI module'));
    }
  }

  send(data) {
    for (const n of this.graph.nodes.values()) if (n.type === 'midi') this.host.send(n.id, { kind: 'midi', data });
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
