// The audio thread: the Rack, a message port, and the recorder's tap.
import { Rack } from './rack.js';

const REC_CHUNK = 16384;
const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

class SoundwerkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rack = new Rack({ sampleRate, telemetry: new Float32Array(options.processorOptions.sab) });
    this.rack.onError = (id, text) => this.port.postMessage({ t: 'error', id, text });
    // in the seconds of the audio clock, which the main thread can turn into the MIDI port's
    this.rack.onMidi = (id, events) => {
      const zero = currentTime - (this.rack.samples - this.frames) / sampleRate;
      this.port.postMessage({ t: 'midi', id, events: events.map(([at, ...data]) => ({ at: zero + at / sampleRate, data })) });
    };
    this.frames = 128;
    this.broken = false;
    this.recording = false;
    this.recL = null;
    this.recR = null;
    this.recN = 0;
    this.spent = 0;
    this.blocks = 0;
    this.worst = 0;
    this.total = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'rec') {
        this.recording = m.on;
        if (m.on) { this.freshChunk(); } else this.flush();
      } else this.rack.apply(m);
    };
  }

  freshChunk() {
    this.recL = new Float32Array(REC_CHUNK);
    this.recR = new Float32Array(REC_CHUNK);
    this.recN = 0;
  }

  flush() {
    if (this.recN) {
      const L = this.recL.slice(0, this.recN), R = this.recR.slice(0, this.recN);
      this.port.postMessage({ t: 'rec', L, R }, [L.buffer, R.buffer]);
    }
    this.recN = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0];
    const input = inputs[0];
    const t0 = now();
    this.frames = L.length;
    // an exception here would end the processor for good; a module bug shouldn't take the wall down
    try {
      this.rack.process(L, R, L.length, input?.[0], input?.[1] ?? input?.[0]);
    } catch (e) {
      if (!this.broken) this.port.postMessage({ t: 'error', id: null, text: e.message });
      this.broken = true;
    }
    if (this.recording) {
      for (let i = 0; i < L.length; i++) {
        this.recL[this.recN] = L[i];
        this.recR[this.recN] = R[i];
        if (++this.recN === REC_CHUNK) { this.flush(); this.freshChunk(); }
      }
    }
    const took = now() - t0;
    this.spent += took;
    if (took > this.worst) this.worst = took;
    this.total++;
    if (++this.blocks === 188) {
      // the share of the audio deadline spent, averaged over half a second or so
      const T = this.rack.telemetry;
      T[0] = this.spent / ((this.blocks * L.length * 1000) / sampleRate);
      T[5] = this.worst;
      T[6] = globalThis.performance ? 1 : 0;
      this.spent = 0;
      this.blocks = 0;
      this.worst = 0;
    }
    this.rack.telemetry[7] = this.total % 1e6;
    return true;
  }
}

registerProcessor('soundwerk', SoundwerkProcessor);
