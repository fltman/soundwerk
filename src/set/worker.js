// Hears a plan off the main thread. The audio comes with the job.
import { hearPlan } from './audition.js';
import { renderStretch } from './render.js';
import { pieceKey } from './score.js';
import { encodeWav } from '../engine/host.js';

self.onmessage = async (e) => {
  const { patch, audio, pieces, only, clip } = e.data;
  const source = { track: async (t) => audio[t.hash] ?? null, piece: async (t, op) => pieces[pieceKey(t, op)] ?? null };
  try {
    const result = await hearPlan(patch, source, only);
    if (clip) { const { L, R, sampleRate } = await renderStretch(patch, { ...clip, source }); result.wav = encodeWav([{ L, R }], sampleRate); }
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
