// What one person has taught the assistant about transitions. It offers three versions of one, says
// which they'll pick and seals that, and they pick. Nothing here judges a transition: it keeps the
// picks and the score, and the assistant reads them back before its next offer.
//
// The score asks whether what it recommended would have done, not whether it was the very one they
// picked. The two part ways just as it starts to work: once it knows someone, all three versions
// suit them and the pick between them is close to a coin toss (measured, with `npm run taste`).
import { legsOf } from './score.js';

// Ten picks would be too few: nine of ten comes up by luck for an assistant that's right six times
// in ten, in almost half of all runs of 48 picks. Eighteen of twenty does in 3 %, and one that's
// right nine times in ten still gets there in 98 %.
export const WINDOW = 20;   // picks the score looks back over
export const NEEDED = 18;   // of those, for it to have earned the rest
const MOST_TOLD = 30;       // picks it reads again, the latest ones
const MOST_KEPT = 200;

export const newTaste = () => ({ notes: [], rounds: [] });

export const addRound = (taste, round) => ({ ...taste, rounds: [...taste.rounds, round].slice(-MOST_KEPT) });

// A prediction looked at before the pick says nothing about the prediction
const counted = (taste) => taste.rounds.filter((r) => !r.peeked).slice(-WINDOW);

const agreed = (r) => r.pick === r.best || !!r.fine;

export function scoreOf(taste) {
  const rounds = counted(taste);
  return { hits: rounds.filter(agreed).length, count: rounds.length };
}

export function trusted(taste) {
  const { hits, count } = scoreOf(taste);
  return count === WINDOW && hits >= NEEDED;
}

// Turned down, it isn't offered again until a whole window of picks has gone by
export const offerDue = (taste) => trusted(taste) && taste.rounds.length >= (taste.declined ?? -WINDOW) + WINDOW;

// Each way in and each way out of a track, in the order of the set
export const transitionsOf = (plan) => legsOf(plan).flatMap((leg) => [
  { key: `${leg.index}:in`, leg: leg.index, side: 'in', track: leg.track, bar: leg.start / 16 },
  { key: `${leg.index}:out`, leg: leg.index, side: 'out', track: leg.track, bar: leg.end / 16 },
]);

export const untaught = (plan) => transitionsOf(plan).filter((t) => !plan.taught?.includes(t.key));

export const transitionName = (t, tracks) => `the way ${t.side === 'in' ? 'into' : 'out of'} "${tracks[t.track].file.replace(/\.\w+$/, '')}"`;

const version = (o, i) => `${i}. ${o.title}: ${o.idea}`;

function pickLine(r) {
  const said = r.why ? ` They said: ${r.why}` : '';
  const verdict = r.pick === null ? 'They turned all three down.' : `They picked ${r.pick}${r.fine ? `, and ${r.best} would have been fine too` : ''}.`;
  return `- ${r.transition}. ${r.options.map(version).join(' ')} You predicted ${r.best}. ${verdict}${said}`;
}

// What the assistant reads before it offers anything
export function describeTaste(taste) {
  if (!taste.rounds.length && !taste.notes.length) return '';
  const { hits, count } = scoreOf(taste);
  const head = `What this user has taught you, from ${taste.rounds.length} picks. You predicted ${hits} of the last ${count}, and luck gets about a third.`;
  const notes = taste.notes.length ? `\nYour notes on them:\n${taste.notes.map((n) => `- ${n}`).join('\n')}` : '';
  const told = taste.rounds.slice(-MOST_TOLD);
  return `${head}${notes}${told.length ? `\nTheir latest picks, oldest first:\n${told.map(pickLine).join('\n')}` : ''}`;
}
