// Every example patch, rendered offline and measured. The bars for the club patches come from
// three finished tracks (Acidic, Dreamstate Acid Gospel, Born), measured with the same tool:
//   LUFS −13.9 / −11.8 / −13.7, crest 14.2 / 11.2 / 13.6, correlation .95 / .90 / .90
//   sub −3.1 / −8.3 / −6.1, bass −4.3 / −3.1 / −3.0, lowmid −11.8 / −6.5 / −8.8,
//   mid −14.0 / −10.6 / −12.7, high −17.1 / −14.1 / −13.8, air −20.9 / −19.3 / −16.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../src/presets.js';
import { renderPatch, deadCables } from '../src/listen/render.js';
import { analyzeRender } from '../src/listen/analyze.js';
import { Graph } from '../src/rack/graph.js';

const REFERENCE = { sub: -5.8, bass: -3.4, lowmid: -9.0, mid: -12.4, high: -15.0, air: -18.7 };
const CLUB = new Set(['Acid wall', 'Dub techno', 'Warehouse', 'Talking acid']);
const bpmOf = (patch) => patch.nodes.find((n) => n.type === 'clock')?.params?.bpm;

for (const preset of PRESETS) {
  test(`${preset.name}: loads, plays and measures like a finished thing`, () => {
    const patch = preset.patch();
    const g = new Graph();
    g.load(JSON.parse(JSON.stringify(patch)));
    assert.equal(g.nodes.size, patch.nodes.length, 'every module survives a load');
    assert.equal(g.links.size, patch.links.length, 'every cable survives a load');
    assert.ok(g.masterNode(), 'a master');

    const bpm = bpmOf(patch) ?? 120;
    const r = renderPatch(patch, { seconds: (8 * 240) / bpm });
    const a = analyzeRender(r);
    assert.deepEqual(deadCables(patch, r.peaks), [], 'every cable carries something');
    assert.ok(a.peakDb <= 0 && a.peakDb > -14, `peak ${a.peakDb}`);
    assert.ok(a.lufs > -22 && a.lufs < -9, `LUFS ${a.lufs}`);
    assert.ok(Math.abs(a.dc) < 0.005, `DC ${a.dc}`);

    if (CLUB.has(preset.name)) {
      assert.ok(a.lufs > -17 && a.lufs < -9.5, `LUFS ${a.lufs}`);
      assert.ok(a.crestDb > 8, `crest ${a.crestDb}: squashed flat`);
      for (const [band, want] of Object.entries(REFERENCE)) {
        assert.ok(Math.abs(a.balance[band] - want) < 8, `${band} ${a.balance[band]} dB, references average ${want}`);
      }
      // the kick is on the beat: Patchwerk's analyser, calibrated on known tracks, hears the tempo
      assert.ok(Math.abs(a.bpm - bpm) < 1 || Math.abs(a.bpm * 2 - bpm) < 1, `heard ${a.bpm} BPM, patch says ${bpm}`);
      const beats = 8 * 4;
      assert.ok(a.kicks >= beats * 0.8, `only ${a.kicks} kicks over ${beats} beats`);
      assert.ok(a.stereoCorrelation < 0.99 || preset.name === 'Talking acid', 'something should be wide');
    }
  });
}

test('the bars fail what they should: a patch of nothing but sub-bass', () => {
  const g = new Graph();
  const v = g.addNode('vco', 0, 0, { params: { tune: -24 } }), m = g.addNode('master', 0, 12);
  g.connect(v.id, 'sine', m.id, 'l');
  const a = analyzeRender(renderPatch(g.toJSON(), { seconds: 6 }));
  const off = Object.entries(REFERENCE).filter(([b, want]) => Math.abs(a.balance[b] - want) >= 8);
  assert.ok(off.length >= 3, JSON.stringify(a.balance));
});
