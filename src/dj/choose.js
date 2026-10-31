// Turns a rig into questions for a decision model, and its answer into a move.
// The model says how well each move suits the moment; the choice is then drawn
// from those odds, so the same moment doesn't always get the same answer, and a
// move that has been on for a long time slowly loses out.

// The daring knob. 0 plays it safe, 1 goes looking for trouble, and 0.5 is the DJ as it always was.
// It only changes how the DJ chooses among moves that passed their test; what it may do never changes.
export function style(daring = 0.5) {
  const k = 1 - 2 * daring;              // 1 safe, 0 the middle, −1 daring
  return {
    sharpen: 1.5 * 3 ** k,               // favours the moves the model likes most
    patience: 2 * 3 ** k,                // phrases before a held move has lost half its pull
    recent: Math.min(1, 0.4 * 2.5 ** k), // how much a move just played counts against itself
    stay: 0.75 * 1.7 ** k,               // an ordered group moves only when the music is this far away
    jitter: Math.max(0, -k),             // rungs an ordered group may overshoot
    pace: daring >= 0.75 ? 0.5 : daring <= 0.25 ? 2 : 1,   // phrases between decisions, as a share
  };
}

export function questionsFor(groups) {
  const out = {};
  for (const g of groups) {
    const told = (m) => (m.test?.measured ? `${m.description} (Measured against home: ${m.test.measured}.)` : m.description);
    out[g.name] = g.ordered
      ? { type: 'score', instructions: g.question, criteria: g.moves.map((m) => `${m.name}: ${told(m)}`) }
      : { type: 'choice', instructions: g.question, criteria: Object.fromEntries(g.moves.map((m) => [m.name, told(m)])) };
  }
  return out;
}

// Where a bar falls in the arc of the set, which goes round and round
export function sectionAt(arc, bar) {
  const total = arc.reduce((s, x) => s + x.bars, 0);
  let at = ((bar % total) + total) % total;
  for (const [i, s] of arc.entries()) {
    if (at < s.bars) return { name: s.name, into: at, left: s.bars - at, next: arc[(i + 1) % arc.length].name };
    at -= s.bars;
  }
  return null;
}

// Does this group decide before `section.into`? Phrases count from the start of the section.
export const isDue = (group, section, pace = 1) => (group.on_section && section.into === 0) || section.into % Math.max(1, group.every * pace) === 0;

// → { move, odds: { name: 0..1 } }. move is null when the group should stay as it is.
export function pickMove(group, answer, { current, heldBars = 0, recent = [], random = Math.random, daring = 0.5 }) {
  const { sharpen, patience, recent: again, stay, jitter } = style(daring);
  if (group.ordered) {
    const heard = Number(answer?.score);
    if (!Number.isFinite(heard)) return { move: null, odds: {} };
    const score = jitter ? heard + (random() - 0.5) * 2 * jitter : heard;
    const level = Math.max(0, Math.min(group.moves.length - 1, Math.round(score)));
    const at = group.moves.findIndex((m) => m.name === current);
    const odds = Object.fromEntries(group.moves.map((m, i) => [m.name, answer.probabilities?.[i] ?? 0]));
    if (at >= 0 && Math.abs(score - at) < stay) return { move: null, odds };
    return { move: level === at ? null : group.moves[level], odds };
  }
  const given = answer?.probabilities;
  if (!given) return { move: null, odds: {} };
  const weights = group.moves.map((m) => {
    let w = Math.max(Number(given[m.name]) || 0, 0.01) ** sharpen;
    if (m.name === current) w *= 0.5 ** (heldBars / (group.every * patience));
    else if (recent.includes(m.name)) w *= again;
    return w;
  });
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = random() * total;
  let move = group.moves[group.moves.length - 1];
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) { move = group.moves[i]; break; }
  }
  return { move: move.name === current ? null : move, odds: { ...given } };
}
