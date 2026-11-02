// Runs the offline analysis off the main thread.
import { analyze } from './analysis.js';
import { cutTrack } from './slices.js';
import { materialOf } from './material.js';
import { trackRecord } from '../set/track.js';

self.onmessage = (e) => {
  const { samples, sampleRate, slices, stem, mix, track, stems, grid, bars, phase } = e.data;
  if (stems) { self.postMessage({ result: materialOf(stems, grid, bars, sampleRate, phase) }); return; }
  const a = analyze(samples, sampleRate, (progress) => self.postMessage({ progress }));
  self.postMessage({
    result: {
      bpm: a.bpm, beats: a.beats, downbeat: a.downbeat, kicks: a.onsets.kick.times, duration: a.duration,
      cut: slices ? cutTrack(a, samples, { stem, mix }) : null,
      track: track ? trackRecord(a, samples, sampleRate) : null,
    },
  });
};
