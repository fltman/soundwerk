// The registry: every module on the wall, the categories, and how a definition maps to ports.
import { source } from './source.js';
import { voice } from './voice.js';
import { drums } from './drums.js';
import { filters } from './filters.js';
import { shapers } from './shapers.js';
import { fx } from './fx.js';
import { modulation } from './modulation.js';
import { sequencers } from './sequencers.js';
import { utility } from './utility.js';
import { mix } from './mix.js';
import { scopes } from './scopes.js';
import { io } from './io.js';
import { compileCode, DEFAULT_CODE } from '../engine/code.js';

export const MODULES = [...source, ...voice, ...drums, ...filters, ...shapers, ...fx, ...modulation, ...sequencers, ...utility, ...mix, ...scopes, ...io];

export const CATEGORIES = {
  source: { label: 'Oscillators', theme: 'black', badge: 'OSC' },
  voice: { label: 'Synth voices', theme: 'silver', badge: 'SYN' },
  drum: { label: 'Drums', theme: 'grey', badge: 'DRM' },
  filter: { label: 'Filters', theme: 'cream', badge: 'VCF' },
  shape: { label: 'Waveshapers', theme: 'red', badge: 'SHP' },
  mod: { label: 'Modulation', theme: 'blue', badge: 'MOD' },
  seq: { label: 'Sequencers & clocks', theme: 'orange', badge: 'SEQ' },
  util: { label: 'Utilities', theme: 'black', badge: 'UTL' },
  fx: { label: 'Effects', theme: 'olive', badge: 'FX' },
  mix: { label: 'Mix & output', theme: 'black', badge: 'MIX' },
  scope: { label: 'Scopes & meters', theme: 'black', badge: 'SCP' },
  io: { label: 'Audio in & MIDI', theme: 'silver', badge: 'I/O' },
  code: { label: 'Code', theme: 'black', badge: 'DSP' },
};

// The Code module's panel comes from its source, so it isn't a fixed definition.
export const codeDef = { type: 'code', title: 'CODE', category: 'code', description: 'Write your own module in JavaScript, sample by sample', tags: ['javascript', 'dsp', 'custom', 'script'] };

const byType = new Map(MODULES.map((d) => [d.type, d]));
export const getDef = (type) => (type === 'code' ? codeDef : byType.get(type));
const compiled = new Map();
export function defFor(node) {
  if (node.type !== 'code') return getDef(node.type);
  const code = node.code ?? DEFAULT_CODE;
  if (!compiled.has(code)) {
    if (compiled.size > 64) compiled.clear();
    compiled.set(code, { ...codeDef, ...compileCode(code).def });
  }
  return compiled.get(code);
}
export { DEFAULT_CODE };

// CV jacks come after the real inputs, in param order, and take the param's name.
export const cvParams = (def) => (def.params ?? []).filter((p) => p.cv);
export const inputPorts = (def) => [...(def.inputs ?? []), ...cvParams(def).map((p) => ({ name: p.name, label: p.label, kind: 'cv', param: true }))];
export const outputPorts = (def) => def.outputs ?? [];

export const paramRange = (p) => {
  if (p.type === 'select') return { min: 0, max: p.options.length - 1, step: 1, def: p.default ?? 0 };
  if (p.type === 'toggle' || p.type === 'button') return { min: 0, max: 1, step: 1, def: p.default ?? 0 };
  return { min: p.min, max: p.max, step: p.step ?? 0, def: p.default, span: p.cvSpan, lo: p.cvMin, hi: p.cvMax };
};
