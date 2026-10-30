// The assistant's ears, off the main thread: render the patch, measure it, draw it.
import { renderPatch, deadCables } from './render.js';
import { analyzeRender, spectrogramRGBA } from './analyze.js';

self.onmessage = async (e) => {
  const { patch, seconds, buffers } = e.data;
  try {
    const r = renderPatch(patch, { seconds, buffers });
    const stats = analyzeRender(r);
    stats.deadCables = deadCables(patch, r.peaks);
    const { px, W, H } = spectrogramRGBA(r.L, r.sampleRate, 640, 240);
    const canvas = new OffscreenCanvas(W, H);
    canvas.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    self.postMessage({ stats, url: `data:image/jpeg;base64,${btoa(s)}` });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
