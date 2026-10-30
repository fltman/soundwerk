// Listens to what leaves the wall: loudness and tonal balance, for the DJ to read once a bar.
import { BANDS } from '../listen/analyze.js';

export class Ear {
  constructor(ctx, source) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    const hz = ctx.sampleRate / this.analyser.fftSize;
    this.band = Int8Array.from(this.bins, (_, k) => BANDS.findIndex(([, lo, hi]) => k * hz >= lo && k * hz < hi));
    this.power = new Float64Array(BANDS.length);
    this.frames = 0;
  }

  sample() {
    const { bins, band, power } = this;
    this.analyser.getFloatFrequencyData(bins);
    for (let k = 0; k < bins.length; k++) if (band[k] >= 0 && bins[k] > -140) power[band[k]] += 10 ** (bins[k] / 10);
    this.frames++;
  }

  // Everything heard since the last take: total level, and each band in dB of the total
  take() {
    const total = this.power.reduce((s, p) => s + p, 0);
    if (!this.frames || !total) { this.power.fill(0); this.frames = 0; return null; }
    const out = { db: 10 * Math.log10(total / this.frames), balance: {} };
    BANDS.forEach(([name], b) => { out.balance[name] = 10 * Math.log10(this.power[b] / total + 1e-12); });
    this.power.fill(0);
    this.frames = 0;
    return out;
  }
}
