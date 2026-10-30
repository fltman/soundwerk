// Prints the README's table of modules from the registry.
import { MODULES, CATEGORIES } from '../src/modules/index.js';

const KEEP = new Set(['VCO', 'FM', 'SVF', 'DJ', 'LFO', 'ADSR', 'ENV', 'S&H', 'VCA', 'EQ3', 'VU', 'MIDI']);
const title = (s) => s.split(' ').map((w) => (KEEP.has(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
const lines = ['| | |', '|---|---|'];
for (const [key, cat] of Object.entries(CATEGORIES)) {
  const mods = MODULES.filter((d) => d.category === key).map((d) => title(d.title));
  if (key === 'code') mods.push('Code (your own, in JavaScript)');
  if (mods.length) lines.push(`| **${cat.label}** | ${mods.join(' · ')} |`);
}
console.log(lines.join('\n'));
console.log(`\n${MODULES.length} modules plus Code.`);
