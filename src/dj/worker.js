// The audition, off the main thread: the wall keeps playing while it runs.
import { auditionRig } from './audition.js';

self.onmessage = (e) => {
  const { patch, rig, buffers } = e.data;
  try {
    const result = auditionRig(patch, rig, { buffers, onProgress: (done, total) => self.postMessage({ done, total }) });
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
