// Teaching the assistant: the score, what counts towards it, and what it reads back. A prediction
// that was looked at or a transition nobody can name would make the 90 % mean nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEEDED, WINDOW, addRound, describeTaste, newTaste, offerDue, scoreOf, transitionName, transitionsOf, trusted, untaught } from '../src/set/taste.js';
import { clipOf } from '../src/set/audition.js';
import { settledPlan } from '../src/set/plan.js';
import { describeTransition } from '../src/ai/ops.js';

const options = [{ title: 'a', idea: 'one' }, { title: 'b', idea: 'two' }, { title: 'c', idea: 'three' }];
const round = (hit, more = {}) => ({ transition: 'the way into "x"', options, best: 1, pick: hit ? 1 : 2, why: '', ...more });
const taught = (...hits) => hits.reduce((t, h) => addRound(t, round(h)), newTaste());
const plan = { arc: [{ name: 'x', bars: 100 }], moves: [{ at: 20, glide: 0, until: 30, why: 'in', ops: [] }], tracks: [{ track: 0, at: 16, enter: 0, leave: 32 }, { track: 1, at: 60, enter: 8, leave: 28 }] };
const tracks = [{ file: 'one.mp3' }, { file: 'two.mp3' }];

const times = (n, hit = true) => Array(n).fill(hit);

test('the score looks back over twenty picks, and it takes eighteen of them', () => {
  assert.deepEqual([WINDOW, NEEDED], [20, 18]);
  const enough = taught(...times(18), false, false);
  assert.deepEqual(scoreOf(enough), { hits: 18, count: 20 });
  assert.equal(trusted(enough), true);
  assert.equal(trusted(taught(...times(17), false, false, false)), false);
  assert.equal(trusted(taught(...times(19))), false, 'nineteen right of nineteen is still only nineteen picks');
  const old = taught(...times(5, false), ...times(20));
  assert.deepEqual(scoreOf(old), { hits: 20, count: 20 }, 'what it got wrong long ago has left the window');
});

test('another pick counts as agreement if what it recommended would have been fine, and only then', () => {
  assert.deepEqual(scoreOf(addRound(newTaste(), round(false))), { hits: 0, count: 1 });
  assert.deepEqual(scoreOf(addRound(newTaste(), round(false, { fine: true }))), { hits: 1, count: 1 });
  assert.match(describeTaste(addRound(newTaste(), round(false, { fine: true }))), /They picked 2, and 1 would have been fine too\./);
});

test('turning all three down is a miss, and a prediction looked at first does not count at all', () => {
  assert.deepEqual(scoreOf(addRound(newTaste(), round(true, { pick: null }))), { hits: 0, count: 1 });
  const looked = addRound(taught(true), round(true, { peeked: true }));
  assert.deepEqual(scoreOf(looked), { hits: 1, count: 1 });
  assert.equal(trusted(times(WINDOW).reduce((t) => addRound(t, round(true, { peeked: true })), newTaste())), false, 'following it every time proves nothing');
});

test('an offer turned down waits for a whole new window', () => {
  const enough = taught(...times(WINDOW));
  assert.equal(offerDue(enough), true);
  const no = { ...enough, declined: enough.rounds.length };
  assert.equal(offerDue(no), false);
  const more = times(WINDOW - 1).reduce((t) => addRound(t, round(true)), no);
  assert.equal(offerDue(more), false);
  assert.equal(offerDue(addRound(more, round(true))), true);
});

test('every way in and out of a track is a transition, and the ones picked are done', () => {
  const all = transitionsOf(plan);
  assert.deepEqual(all.map((t) => [t.key, t.bar]), [['0:in', 16], ['0:out', 48], ['1:in', 60], ['1:out', 80]]);
  assert.deepEqual(untaught({ ...plan, taught: ['0:in', '0:out'] }).map((t) => t.key), ['1:in', '1:out']);
  assert.equal(transitionName(all[2], tracks), 'the way into "two"');
  assert.equal(transitionName(all[1], tracks), 'the way out of "one"');
  const said = describeTransition(plan, tracks, all[0]);
  assert.match(said, /Transition 1 of 4: the way into "one", leg 0, side in\. The track starts on set bar 16/);
  assert.match(said, /moves\[0\], bar 20 until 30: in/);
});

test('what it reads back: its notes, the picks with what was offered, and the score', () => {
  assert.equal(describeTaste(newTaste()), '');
  const said = describeTaste({ ...taught(true, false), notes: ['likes words'], rounds: [round(true), round(false, { why: 'too long' }), round(true, { pick: null })] });
  assert.match(said, /from 3 picks\. You predicted 1 of the last 3/);
  assert.match(said, /- likes words/);
  assert.match(said, /0\. a: one 1\. b: two 2\. c: three You predicted 1\. They picked 2\. They said: too long/);
  assert.match(said, /They turned all three down/);
});

test('an edit keeps the transitions already picked, and a new plan starts over', () => {
  const next = { ...plan, home: [] }, before = { ...plan, home: [], ok: true, failed: [], taught: ['0:in'] };
  assert.deepEqual(settledPlan(next, [], before, { from: 0, to: 4 }).plan.taught, ['0:in']);
  assert.equal(settledPlan(next, [], null).plan.taught, undefined);
});

test('all versions get the same bars: what any of them changes, within reach of the transition', () => {
  assert.deepEqual(clipOf(plan, 60, [{ from: 56, to: 62 }, { from: 52, to: 70 }]), { at: 48 * 16, until: 74 * 16 });
  assert.deepEqual(clipOf(plan, 60, [{ from: 0, to: 100 }]), { at: 24 * 16, until: 96 * 16 }, 'a long move does not make a long clip');
  assert.deepEqual(clipOf(plan, 60, [{ from: 0, to: 0 }]), { at: 56 * 16, until: 65 * 16 }, 'a version that changes nothing');
  assert.deepEqual(clipOf(plan, 98, [{ from: 96, to: 100 }]), { at: 92 * 16, until: 100 * 16 }, 'not past the end of the set');
});
