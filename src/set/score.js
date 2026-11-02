// A plan as a score: which track plays when, and what happens to the rack on which bar. The
// assistant writes it, and nothing in here has an opinion on how a transition should go. Pure, so
// the same score is played live and rendered ahead of the set to hear it.
//
//   plan: { brief, arc: [{ name, bars }],
//           tracks: [{ track, at, enter, leave, nudge }],
//           moves: [{ at, glide, until, why, ops }],
//           home: [[id, field, name, value]] }
//
// Everything counts bars of the set. arc names its parts and adds up to its length. An entry of
// tracks plays one track from its own bar `enter` to its bar `leave`, starting on bar `at` of the
// set, one at a time. nudge is seconds added to the track's grid. A move runs edit_patch operations
// on bar `at`: the knobs it sets take `glide` bars, and on bar `until` whatever it added or
// replugged goes again, the way a move of a rig does. home is what the moves turn, as it stood when
// the plan was made: every run starts from there, whatever the last one left behind. A move has one
// op of its own, sample:
//   { op: 'sample', id, track, stem, bar, bars, pieces, steps, gain, tune, reverse }
// which fills the Slicer `id` with bars of a track, or of one stem of it, cut into 1, 2, 4 or 8
// pieces on the pads a to h, until the move leaves. bar can sit on any 16th of the track.
import { sixteenthGrid } from '../analysis/analysis.js';

import { parseSteps } from '../rack/patterns.js';

export const LOAD_BARS = 1;     // after one track stops, before the next can reach the deck
export const PIECES = [1, 2, 4, 8];
export const STEMS = ['drums', 'bass', 'vocals', 'other'];
const TAIL = 0.12;              // seconds kept after a sample, for a slice to ring out

export const gridOf = (t) => sixteenthGrid(Float64Array.from(t.beats), t.downbeat);

// The tempo around a bar, which is what the Clock must run at for a track to sound like itself there
export function bpmAt(t, bar) {
  const n = t.beats.length, at = Math.min(n - 2, t.downbeat + 4 * bar), to = Math.min(n - 1, at + 32);
  return to > at ? (60 * (to - at)) / (t.beats[to] - t.beats[at]) : t.bpm;
}

export const lengthOf = (plan) => plan.arc.reduce((n, s) => n + s.bars, 0);

// A plan saved in the shape from before the rack carried the set has no arc, and is as good as none
export const planOf = (node) => (node?.data.plan?.arc ? node.data.plan : null);

const stepsOf = (op) => parseSteps(op.steps ?? Array.from({ length: op.pieces }, (_, k) => 'abcdefgh'[k] + '.'.repeat(Math.max(0, Math.round((op.bars * 16) / op.pieces) - 1))).join(''));

const hashOf = (t, op) => `sample-${t.hash}-${op.stem ?? 'mix'}-${op.bar}-${op.bars}${op.reverse ? '-reverse' : ''}`;

// What a Slicer holds for a sample op, apart from the sound
export function sampleData(t, op) {
  const grid = gridOf(t), each = (grid[(op.bar + op.bars) * 16] - grid[op.bar * 16]) / op.pieces;
  const pool = Array.from({ length: op.pieces }, (_, k) => ({ kind: 'bar', at: k * each, end: (k + 1) * each, steps: Math.round((op.bars * 16) / op.pieces) }));
  return { file: t.file, hash: hashOf(t, op), pool, pads: Array.from({ length: 8 }, (_, k) => k % op.pieces), steps: stepsOf(op) };
}

// The stretch of a track or stem a sample op asks for, at the level that track plays at. A stem was
// decoded apart from its mix, and lags it by what was measured. Played backwards it has no tail, or
// the pieces would slide.
export function cutPiece(t, op, audio, nudge = 0) {
  const grid = gridOf(t), sr = audio.sr, lag = nudge + (op.stem ? t.stems?.lag ?? 0 : 0);
  const at = grid[op.bar * 16] + lag, end = grid[(op.bar + op.bars) * 16] + lag;
  const from = Math.max(0, Math.round(at * sr)), to = Math.round((end + (op.reverse ? 0 : TAIL)) * sr);
  const L = audio.L.slice(from, to).map((v) => v * (t.gain ?? 1)), R = audio.R === audio.L ? L : audio.R.slice(from, to).map((v) => v * (t.gain ?? 1));
  if (op.reverse) { L.reverse(); if (R !== L) R.reverse(); }
  return { L, R, sr };
}

export const pieceKey = hashOf;

// source.piece, if it has one, brings the stretch itself; if not it's cut from what source brings
export const pieceOf = async (source, t, op, nudge) => {
  if (source.piece) return source.piece(t, op, nudge);
  const audio = await (op.stem ? source.stem(t, op.stem) : source.track(t));
  return audio && cutPiece(t, op, audio, nudge);
};

export function legsOf(plan) {
  return plan.tracks.map((e, i) => ({ ...e, index: i, start: e.at * 16, end: (e.at + e.leave - e.enter) * 16 }));
}

export function eventsOf(plan) {
  const legs = legsOf(plan), events = [];
  const at = (step, type, more) => events.push({ step, type, ...more });
  legs.forEach((leg, i) => {
    if (i) at(legs[i - 1].end + LOAD_BARS * 16, 'load', { leg: i });
    at(leg.start, 'cue', { leg: i });
    at(leg.end, 'stop', { leg: i });
  });
  plan.moves.forEach((move, i) => {
    at(move.at * 16, 'move', { move: i });
    if (move.until !== undefined) at(move.until * 16, 'leave', { move: i });
  });
  at(lengthOf(plan) * 16, 'end');
  // on one step: what goes leaves first, and a move finds the track it's for already on its way
  const order = { stop: 0, leave: 1, cue: 2, move: 3, load: 4, end: 5 };
  return { legs, events: events.sort((a, b) => a.step - b.step || order[a.type] - order[b.type]) };
}
