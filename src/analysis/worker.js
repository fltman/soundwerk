// Runs the offline analysis off the main thread.
import { analyze } from './analysis.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  const a = analyze(samples, sampleRate, (progress) => self.postMessage({ progress }));
  self.postMessage({ result: { bpm: a.bpm, beats: a.beats, downbeat: a.downbeat, kicks: a.onsets.kick.times, duration: a.duration } });
};
