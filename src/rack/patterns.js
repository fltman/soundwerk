// Sequencer patterns as text, the same notation for the example patches and the assistant.
//   notes: "C3 C3! - D#3~ G2 ..."   C3 note, ! accent, ~ slide into the next step, - rest
//   rows:  { BD: 'x...x...x...x...', CH: '..x...x...x...x.' }
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
export const DRUM_ROWS = ['BD', 'SD', 'CH', 'OH', 'CP', 'RS', 'LT', 'HT', 'AC'];

// n = 0 is C2, so n/12 − 2 is the voltage; n runs 0..24 on the grid
export function noteToN(text) {
  const m = /^([A-Ga-g][#b]?)(-?\d)$/.exec(text);
  if (!m) throw new Error(`"${text}" is not a note (try C3, D#2, Bb3)`);
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  const k = NOTES.indexOf(FLAT[name] ?? name);
  if (k < 0) throw new Error(`"${text}" is not a note`);
  const n = (Number(m[2]) - 2) * 12 + k;
  if (n < 0 || n > 24) throw new Error(`${text} is outside C2..C4`);
  return n;
}

export function parseNotes(text) {
  const items = (Array.isArray(text) ? text : String(text).trim().split(/\s+/)).slice(0, 16);
  const steps = items.map((raw) => {
    const item = String(raw);
    if (item === '-' || item === '.') return { n: 12, g: 0, a: 0, s: 0 };
    return { n: noteToN(item.replace(/[!~]/g, '')), g: 1, a: item.includes('!') ? 1 : 0, s: item.includes('~') ? 1 : 0 };
  });
  while (steps.length < 16) steps.push({ n: 12, g: 0, a: 0, s: 0 });
  return { steps };
}

export function formatNotes(data) {
  return (data?.steps ?? []).map((s) => (s.g ? `${NOTES[s.n % 12]}${2 + Math.floor(s.n / 12)}${s.a ? '!' : ''}${s.s ? '~' : ''}` : '-')).join(' ');
}

export function parseRows(rows, base) {
  const out = base ? structuredClone(base.rows) : Array.from({ length: 9 }, () => new Array(16).fill(0));
  for (const [name, text] of Object.entries(rows)) {
    const r = DRUM_ROWS.indexOf(name.toUpperCase());
    if (r < 0) throw new Error(`no drum row "${name}" (rows: ${DRUM_ROWS.join(' ')})`);
    const t = String(text).replace(/\s+/g, '');
    out[r] = Array.from({ length: 16 }, (_, k) => (/[xX1]/.test(t[k] ?? '') ? 1 : 0));
  }
  return { rows: out };
}

export function formatRows(data) {
  return (data?.rows ?? []).map((r, i) => (r.some(Boolean) ? `${DRUM_ROWS[i]} ${r.map((v) => (v ? 'x' : '.')).join('')}` : null)).filter(Boolean).join(' | ');
}
