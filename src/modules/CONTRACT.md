# Module contract

Soundwerk is a wall of synthesizers. Every unit on the wall is a **module
definition**: a plain object in one of the files in `src/modules/`. This file is
the contract between the module library, the engine and the wall. Change it
before you change the code.

## One signal: volts

There is one kind of signal, as in Eurorack: a voltage per sample, in a `Float64`.
Anything can be patched into anything, and cables may form loops. Every cable is
clamped to the rails (±12 V) by the engine.

| Signal | Range | Notes |
|---|---|---|
| audio | ±5 V nominal | Master maps ±10 V to full scale |
| pitch | 1 V/oct | 0 V = C4 = 261.63 Hz (`C4`, `vToHz`, `hzToV`) |
| gate | 0 or 10 V | high while held |
| trigger | 10 V for 1 ms | use `Pulse` |
| cv, unipolar | 0..10 V | envelopes |
| cv, bipolar | ±5 V | LFOs |

Inputs read a gate as high at ≥ 2 V and low at ≤ 0.5 V (`Trigger` does this). A jack's
`kind` (`audio` / `pitch` / `gate` / `cv`) only decides the default cable colour
and helps the patch assistant. It never forbids a connection.

## Module definition

```js
export const vco = {
  type: 'vco',                 // unique id, lowercase-kebab
  title: 'VCO',                // silkscreened on the panel, short
  category: 'source',          // see CATEGORIES in index.js
  description: 'Analog oscillator: saw, pulse, triangle, sine', // one line, shown in the add menu
  tags: ['oscillator'],        // optional extra search words
  inputs: [
    { name: 'pitch', label: 'V/OCT', kind: 'pitch' },
    { name: 'fm', label: 'FM', kind: 'audio' },
    { name: 'sync', label: 'SYNC', kind: 'gate' },
  ],
  outputs: [
    { name: 'saw', label: 'SAW', kind: 'audio' },
    { name: 'pulse', label: 'PULSE', kind: 'audio' },
  ],
  params: [
    { name: 'tune', label: 'TUNE', min: -3, max: 3, default: 0, size: 'L', format: fmtOct },
    { name: 'pw', label: 'PW', min: 0.05, max: 0.95, default: 0.5, cv: true },
    { name: 'wave', label: 'WAVE', type: 'select', options: ['SAW', 'SQR'], default: 0 },
    { name: 'on', label: 'ON', type: 'toggle', default: 1 },
    { name: 'hit', label: 'HIT', type: 'button' },
  ],
  lights: [{ name: 'gate', label: 'GATE', color: 'red' }],
  dsp: class VCO extends Module {
    constructor(sr) { super(sr); this.phase = 0; }
    tick(i, o, p) { /* one sample */ }
  },
};
```

Add new modules to the `MODULES` list in `src/modules/index.js`.

### Params

| Param | Shows as | Value in `p[k]` |
|---|---|---|
| float (`min`, `max`, `default`, optional `step`) | knob, `size: 'L' / 'M' / 'S' / 'T'`, or `'F'` / `'f'` for a tall or short vertical fader | number |
| `type: 'select'`, `options` | switch (≤ 5 options) or stepped dropdown | option index |
| `type: 'toggle'` | latching button with LED | 0 or 1 |
| `type: 'button'` | momentary button | 1 while held |

* `display: true` means only the wall reads the param (a scope's time/div, say); it is excused from the dead-knob test.
  `needs: { other: value }` tells that test how to reach a knob that only acts when another is turned.
* `cv: true` adds a CV jack and a small trim knob to the panel. The engine computes
  `knob + cable/10 × depth × (max − min)`, clamped to `[min, max]`, and rounds it
  to `step` if there is one. So `tick` only ever sees the final value in `p[k]`.
  A select with `cv: true` is the same thing with `step: 1`.
* A ±5 V LFO at the default depth (0.5) sweeps ±25 % of the knob's range.
* A cable can reach further than the knob: `cvSpan` replaces `max − min` in that formula, and
  `cvMin` / `cvMax` replace the clamp. The Acid Box's cutoff knob covers the hardware's 314 to
  2394 Hz, while its jack still tracks 1 V/oct at depth 1.0 and sweeps far past both ends.
* Knobs are linear in `p`. For anything exponential give the param a musical
  unit and map it in `tick`. **Filter cutoffs are volts:** `cutoff` in −4..+6 (16 Hz to 16.7 kHz)
  means `vToHz(p[k])`, so at depth 1.0 the CV tracks 1 V/oct exactly. **Times and rates are 0..1**
  and go through `expmap(p[k], lo, hi)`; give those params a `format` so the
  value reads in ms or Hz.
* Pick ranges where the whole knob sounds usable. Defaults must already sound good.
* Param `format(value)` returns the text shown while you turn it.
* `br: true` on a param starts a new row of knobs on the panel.

### The DSP class

* `constructor(sr)`: call `super(sr)`, allocate everything here. `this.sr`,
  `this.dt = 1/sr` are set. Delay lines and tables are sized from `sr`.
* `tick(i, o, p)`: one sample. `i` = input jacks in `inputs` order, `o` = output jacks
  in `outputs` order, `p` = params in `params` order, all `Float64Array`.
  Read them once at the top, positionally, with a comment if it helps:

  ```js
  tick(i, o, p) {
    const pitch = i[0], fm = i[1], tune = p[0], pw = p[1];
  ```
* **No allocation in `tick`**: no arrays, closures, destructuring of arrays, or
  string work. This is the audio thread, at 48 kHz, next to 50 other modules.
  Aim for under 200 ns a tick for an oscillator or filter, 1 µs for a reverb.
  Do expensive maths (`tan`, `exp`, `pow`) only when the input actually changed if that's cheap
  to check; a cached coefficient is worth it. Do not use `for…of` in `tick`.
* `this.linked[k]` is 1 if input `k` has a cable. Use it for normalling: an
  unpatched right input follows the left, an unpatched filter input hears nothing.
* `this.ui[k]`, `k` in 0..63: anything the panel should show. `lights` are `ui[0]`, `ui[1]`… in
  order, 0..1 brightness. It is a `Float32Array` shared with the wall; write freely.
* `this.rack.running`: the transport, true while the wall is playing. Only clocks should care.
* `onData(data)`: optional. Sequencer patterns and other non-knob state live in
  `node.data` (plain JSON); `defaultData()` on the definition makes a new module's. Called from
  the message handler, not during `tick`.
* `wave: true` on the definition gives the instance `this.wave`, a 16384-long `Float32Array` shared
  with the wall, for screens. There are 16 of these.
* `onMessage(msg)`: optional. One-off messages (a decoded audio file, say). Not during `tick`.

### Rules that keep it from blowing up

* Everything is deterministic: use `new Rng(seed)`, never `Math.random`. A patch
  renders the same every time; the tests rely on it. Seed from a constant.
* Tolerate every input from −12 V to +12 V at any sample rate from 22 kHz to 96 kHz
  and every param at both ends. No NaN, no runaway state. `test/modules.test.mjs` fuzzes this for every module.
* Feedback paths must be bounded (a saturator or clamp inside the loop).
* Add `DENORMAL` (1e-20) to recursive state that decays to silence, so it never goes denormal.
* If a module's output is NaN or infinite the engine replaces the instance with a fresh one.
  Treat that as a bug, not a safety net.
* Audio outputs are about ±5 V at normal settings. Keep DC out of audio outputs.
* **Self-contained classes.** The `dsp` class may reference only its own members and
  names exported from `src/modules/lib/`. No file-level helpers or constants next to the class;
  put shared helpers in a lib file with a unique name, and `export *` it from `lib/index.js`.
  This is what lets a user fork any module's source into a Code module and edit it live.
  Static class fields are fine for tables.
* Each module is in the list once; `inputs`, `outputs` and `params` share one namespace, so a
  param and a jack can't have the same name.

### Helpers (`src/modules/lib/`)

`C4`, `TAU`, `DENORMAL`, `vToHz`, `hzToV`, `clamp`, `lerp`, `expmap`, `softclip`, `tanh`
(fast approximation), `polyblep`, `Trigger`, `Pulse`, `Rng`, `DCBlock`, `OnePole`, `DelayLine`, `Module`, and the
formatters `fmtHz`, `fmtVHz`, `fmtMs`, `fmtExp`, `fmtExpHz`, `fmtDb`, `fmtPct`, `fmtSt`, `fmtRatio`. Each family of
modules adds its own in `lib/osc.js`, `lib/drum.js`, `lib/filter.js` and `lib/fx.js`, with prefixed names.

## Panels

The wall lays out every panel from the definition (`src/wall/layout.js`). Nobody draws
a panel by hand, and width is computed: 1 HP = 15 px, panels are 380 px tall and every
module gets the narrowest even width that fits. `hp` forces a wider one; `theme`
(`black`, `silver`, `cream`, `grey`, `blue`, `red`, `orange`, `olive`) overrides the
colour of the category; `cols` sets the number of knob columns; `br: true` on a param wraps the row. `widgets` adds a
screen or a step grid, built in `src/wall/widgets.js`:
`widgets: [{ ui: 'scope', w: 300, h: 190 }]`.

## Checking your work

`npm test` runs `test/modules.test.mjs` over every module:

* renders it with default params and checks the output is finite and on the rails,
* fuzzes params and inputs at three sample rates, including sudden jumps between the rails,
* turns every knob end to end and fails on **dead knobs** (no effect on any output),
* measures the time per tick,
* forks the class source and checks the fork sounds exactly like the original,
* checks the panel fits.

Calibrate against something outside the module: an oscillator is tested against the
pitch it should have, a filter against the cutoff and slope it should have, a reverb against
the RT60 it claims. `test/lib/dsp.mjs` has `renderModule`, `spectrum`, `peakHz`, `rms`, `db`.
