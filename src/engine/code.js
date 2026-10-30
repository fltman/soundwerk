// Compiles a Code module: a page of JavaScript with its panel declared in comments.
//   // in fm "FM"            → a jack
//   // out out "OUT"         → a jack
//   // param freq -3 3 0 "FREQ" cv → a knob; `cv` gives it a jack
//   function tick(i, o, p) { o[0] = … }   → runs every sample; sr and every helper are in scope
import * as lib from '../modules/lib/index.js';

export const DEFAULT_CODE = `// in fm "FM"
// out out "OUT"
// param freq -3 3 0 "FREQ" cv
// param fold 0 1 0.2 "FOLD" cv
let phase = 0;

function tick(i, o, p) {
  phase += C4 * 2 ** (p[0] + i[0]) / sr;
  phase -= Math.floor(phase);
  o[0] = 5 * Math.sin(TAU * phase + p[1] * 6 * Math.sin(TAU * phase));
}`;

export function parseHeader(code) {
  const inputs = [], outputs = [], params = [];
  let wave = false;
  for (const line of code.split('\n')) {
    if (!/^\s*(\/\/.*)?$/.test(line)) break;
    if (/^\s*\/\/\s*wave\s*$/.test(line)) wave = true;
    const m = line.match(/^\s*\/\/\s*(in|out|param|select|toggle|button)\s+([a-zA-Z_]\w*)\s*(.*)$/);
    if (!m) continue;
    const [, what, name, rest] = m;
    const label = rest.match(/"([^"]*)"/)?.[1] ?? name.toUpperCase();
    const words = rest.replace(/"[^"]*"/, '').trim().split(/\s+/).filter(Boolean);
    if (what === 'in') inputs.push({ name, label, kind: 'audio' });
    else if (what === 'out') outputs.push({ name, label, kind: 'audio' });
    else if (what === 'select') params.push({ name, label, type: 'select', options: (words[0] ?? 'A|B').split('|').map((o) => o.replace(/_/g, ' ')), default: Number(words[1] ?? 0), cv: words.includes('cv') });
    else if (what === 'toggle') params.push({ name, label, type: 'toggle', default: Number(words[0] ?? 0) });
    else if (what === 'button') params.push({ name, label, type: 'button', default: 0 });
    else {
      const [min = 0, max = 1, def = min] = words.slice(0, 3).map(Number);
      const step = words.find((w) => w.startsWith('step='));
      const extra = (key) => { const w = words.find((x) => x.startsWith(`${key}=`)); return w ? Number(w.slice(key.length + 1)) : undefined; };
      params.push({ name, label, min, max, default: def, cv: words.includes('cv'), ...(step ? { step: Number(step.slice(5)) } : {}), cvSpan: extra('span'), cvMin: extra('lo'), cvMax: extra('hi') });
    }
  }
  return { inputs, outputs, params, wave };
}

// The panel of a built-in module as header lines, followed by its class: a working Code module.
export function forkSource(def) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '')}"`;
  const head = [];
  if (def.wave) head.push('// wave');
  for (const p of def.inputs ?? []) head.push(`// in ${p.name} ${q(p.label)}`);
  for (const p of def.outputs ?? []) head.push(`// out ${p.name} ${q(p.label)}`);
  for (const p of def.params ?? []) {
    const cv = p.cv ? ' cv' : '';
    if (p.type === 'select') head.push(`// select ${p.name} ${p.options.map((o) => o.replace(/ /g, '_')).join('|')} ${p.default ?? 0} ${q(p.label)}${cv}`);
    else if (p.type === 'toggle') head.push(`// toggle ${p.name} ${p.default ?? 0} ${q(p.label)}`);
    else if (p.type === 'button') head.push(`// button ${p.name} ${q(p.label)}`);
    else head.push(`// param ${p.name} ${p.min} ${p.max} ${p.default} ${q(p.label)}${p.step ? ` step=${p.step}` : ''}${p.cvSpan ? ` span=${p.cvSpan} lo=${p.cvMin} hi=${p.cvMax}` : ''}${cv}`);
  }
  const name = def.dsp.name || 'Forked';
  return `${head.join('\n')}

${def.dsp.toString()}

const self = host.adopt(new ${name}(sr));

function tick(i, o, p) {
  self.tick(i, o, p);
}`;
}

export function checkCode(code) {
  const names = ['sr', 'host', ...Object.keys(lib)];
  try {
    new Function(...names, `${code}\nreturn tick;`); // eslint-disable-line no-new-func
    return null;
  } catch (e) { return e.message; }
}

export function compileCode(code) {
  const header = parseHeader(code);
  const names = Object.keys(lib);
  const dsp = class Code extends lib.Module {
    constructor(sr) {
      super(sr);
      this.step = null;
      this.child = null;
      this.pending = null;
      this.tried = false;
      this.errorText = null;
    }
    // a forked class needs the jacks and screens the engine gives this instance
    adopt(m) {
      m.linked = this.linked;
      m.ui = this.ui;
      m.wave = this.wave;
      m.rack = this.rack;
      if (this.pending != null) m.onData(this.pending);
      this.child = m;
      this.adoptLater?.(m);
      return m;
    }
    onData(d) {
      this.pending = d;
      this.child?.onData(d);
    }
    onMessage(m) { this.child?.onMessage(m); }
    // compiled on the first sample: by then the engine has filled in linked, ui and rack
    tick(i, o, p) {
      if (this.step === null) {
        if (this.tried) return;
        this.tried = true;
        try {
          // eslint-disable-next-line no-new-func
          this.step = new Function('sr', 'host', ...names, `${code}\nreturn tick;`)(this.sr, this, ...names.map((k) => lib[k]));
        } catch (e) { this.errorText = e.message; return; }
      }
      // live code will throw sooner or later: that stops this module, never the whole wall
      try {
        this.step(i, o, p);
      } catch (e) {
        this.errorText = e.message;
        this.step = null;
        o.fill(0);
      }
    }
  };
  return { def: { type: 'code', title: 'CODE', category: 'code', ...header, widgets: [], dsp } };
}
