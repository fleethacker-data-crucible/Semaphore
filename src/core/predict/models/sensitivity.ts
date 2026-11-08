// One-at-a-time sensitivity (a tornado chart): every input sits at its most likely value, then each
// in turn is moved to its low and its high while the others stay put. The swing of the answer per
// input ranks which assumption matters most. Same inputs as Monte Carlo.

import { fmt } from '../format.ts';
import type { ModelOutput, ModelRunner } from '../types.ts';
import { combineOf, resolveInputs } from './montecarlo.ts';

/** Bars drawn on the tornado; the table keeps every input. */
const MAX_BARS = 30;

export const runSensitivity: ModelRunner = (data, spec): ModelOutput => {
  const notes: string[] = [];
  const inputs = resolveInputs(data, spec, notes);
  const combine = combineOf(spec);
  const mf = data.metrics[0]?.format;
  const f = (v: number) => fmt(v, 'metric', mf);
  const n = inputs.length;
  const op = combine === 'product' ? (a: number, b: number) => a * b : (a: number, b: number) => a + b;
  const unit = combine === 'product' ? 1 : 0;

  // Prefix and suffix combinations of the likely values, so swapping one input costs O(1) and a zero
  // in a product needs no division.
  const pre = new Float64Array(n + 1);
  const suf = new Float64Array(n + 1);
  pre[0] = unit;
  suf[n] = unit;
  for (let i = 0; i < n; i++) pre[i + 1] = op(pre[i]!, inputs[i]!.likely);
  for (let i = n - 1; i >= 0; i--) suf[i] = op(suf[i + 1]!, inputs[i]!.likely);
  const base = pre[n]!;
  const rest = (i: number) => op(pre[i]!, suf[i + 1]!);

  const bars = inputs.map((x, i) => {
    const atLow = op(rest(i), x.low);
    const atHigh = op(rest(i), x.high);
    return { name: x.name, atLow, atHigh, swing: Math.abs(atHigh - atLow), x };
  });
  bars.sort((a, b) => b.swing - a.swing);
  const top = bars[0]!;
  const lo = Math.min(...bars.map((b) => Math.min(b.atLow, b.atHigh)));
  const hi = Math.max(...bars.map((b) => Math.max(b.atLow, b.atHigh)));
  const totalSwing = bars.reduce((a, b) => a + b.swing, 0);

  const what = combine === 'product' ? 'result' : 'total';
  const headline =
    top.swing > 0
      ? `"${top.name}" moves the ${what} most: from ${f(Math.min(top.atLow, top.atHigh))} to ${f(Math.max(top.atLow, top.atHigh))}, a swing of ${f(top.swing)} around the base of ${f(base)}.`
      : `No input moves the ${what}: every low and high equals its most likely value, so it stays at ${f(base)}.`;
  const sentences: string[] = [];
  sentences.push(`The base case puts every input at its most likely value and gives ${f(base)}.`);
  if (n > 1 && top.swing > 0) {
    const second = bars[1]!;
    sentences.push(`Next is "${second.name}" with a swing of ${f(second.swing)}; together the top two make up ${fmt(totalSwing ? (top.swing + second.swing) / totalSwing : 0, 'percent')} of all the swings.`);
  }
  if (top.swing > 0 && top.atHigh < top.atLow) sentences.push(`For "${top.name}" a higher value gives a lower ${what}.`);
  sentences.push('Each bar moves one input at a time with the others at their most likely, so it shows which assumption to firm up first, not the combined odds (Monte Carlo gives those).');
  notes.push('Inputs are moved one at a time; effects of two inputs moving together are not shown.');
  if (n > MAX_BARS) notes.push(`The chart shows the ${MAX_BARS} inputs with the biggest swings; the table lists all ${n.toLocaleString('en-US')}.`);

  const shown = bars.slice(0, MAX_BARS);
  return {
    model: 'sensitivity',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Base case', value: base, format: 'metric', hint: 'Every input at its most likely value.' },
      { label: 'Moves it most', value: top.name, hint: 'The input whose low-to-high range swings the answer most.' },
      { label: 'Biggest swing', value: top.swing, format: 'metric', hint: 'The answer at that input’s high minus at its low.' },
      { label: 'Lowest case', value: lo, format: 'metric', hint: 'The lowest answer from moving any one input.' },
      { label: 'Highest case', value: hi, format: 'metric', hint: 'The highest answer from moving any one input.' },
    ],
    chart: {
      kind: 'bars',
      labels: shown.map((b) => b.name),
      values: shown.map((b) => b.swing),
      low: shown.map((b) => b.atLow),
      high: shown.map((b) => b.atHigh),
      base,
      xFormat: 'metric',
      xLabel: combine === 'product' ? 'Result' : 'Total',
    },
    table: {
      columns: ['Input', 'Low', 'Most likely', 'High', 'Answer at low', 'Answer at high', 'Swing'],
      rows: bars.map((b) => [b.name, b.x.low, b.x.likely, b.x.high, b.atLow, b.atHigh, b.swing]),
    },
    notes,
  };
};
