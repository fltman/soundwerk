// Bounce a patch to a WAV and a spectrogram PNG, faster than real time, and print how it measures.
//   node tools/render.mjs "Acid line"            an example, by name
//   node tools/render.mjs patch.json --bars 16   a saved patch
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { renderPatch, deadCables } from '../src/listen/render.js';
import { analyzeRender, spectrogramRGBA } from '../src/listen/analyze.js';
import { PRESETS } from '../src/presets.js';

export function wavBytes(L, R, sr) {
  const n = L.length, buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], 44 + i * 8); buf.writeFloatLE(R[i], 48 + i * 8); }
  return buf;
}

export function pngBytes(px, W, H) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(px.buffer, px.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function bpmOf(patch) {
  return patch.nodes.find((n) => n.type === 'clock')?.params?.bpm ?? 130;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, ...rest] = process.argv.slice(2);
  const bars = Number(rest[rest.indexOf('--bars') + 1]) || 16;
  const preset = PRESETS.find((p) => p.name === name);
  const patch = preset ? preset.patch() : JSON.parse(readFileSync(name, 'utf8'));
  const seconds = (bars * 4 * 60) / bpmOf(patch);
  const t0 = performance.now();
  const r = renderPatch(patch, { seconds });
  const took = (performance.now() - t0) / 1000;
  const stats = analyzeRender(r);
  stats.deadCables = deadCables(patch, r.peaks);
  mkdirSync('test/out', { recursive: true });
  const base = `test/out/${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/-json$/, '')}`;
  writeFileSync(`${base}.wav`, wavBytes(r.L, r.R, r.sampleRate));
  const { px, W, H } = spectrogramRGBA(r.L, r.sampleRate);
  writeFileSync(`${base}.png`, pngBytes(px, W, H));
  console.log(JSON.stringify({ seconds: +seconds.toFixed(1), realtime: +(seconds / took).toFixed(1), ...stats }, null, 1));
  console.log(`→ ${base}.wav, ${base}.png`);
}
