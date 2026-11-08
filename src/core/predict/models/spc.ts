// Statistical process control: is a change real or noise? Three charts (Montgomery, Introduction to
// Statistical Quality Control):
// - Individuals (Shewhart X chart): centre = baseline mean, sigma = average moving range / d2
//   (d2 = 1.128 for ranges of two), limits at ± the sigma setting; with the Western Electric run
//   rules (Western Electric Statistical Quality Control Handbook, 1956) on top.
// - EWMA (Roberts, 1959): z = λx + (1 − λ)z₋₁ with the exact time-varying limits
//   μ ± Lσ·√(λ/(2 − λ)·(1 − (1 − λ)^2i)).
// - Tabular CUSUM (Page, 1954): C⁺ = max(0, x − (μ + kσ) + C⁺₋₁), C⁻ = max(0, (μ − kσ) − x + C⁻₋₁),
//   a signal when either passes hσ.

import { cellLabel, timeSeries } from '../data.ts';
import { fmt } from '../format.ts';
import { ModelError, type ModelOutput, type ModelRunner, type Tone, numParam, param } from '../types.ts';

const D2 = 1.128;

export interface Signal {
  index: number;
  rule: 1 | 2 | 3 | 4;
  side: 'above' | 'below';
}

const RULE_TEXT: Record<Signal['rule'], string> = {
  1: 'beyond the limits',
  2: '2 of 3 beyond 2σ',
  3: '4 of 5 beyond 1σ',
  4: '8 in a row on one side',
};

/**
 * Western Electric rules on standardised values z = (x − centre) / sigma. Each point gets at most one
 * signal, the lowest-numbered rule it completes. With `all` false only rule 1 (beyond `limit`).
 */
export function westernElectric(z: ArrayLike<number>, limit: number, all: boolean): Signal[] {
  const out: Signal[] = [];
  const n = z.length;
  for (let i = 0; i < n; i++) {
    const zi = z[i]!;
    const side: Signal['side'] = zi >= 0 ? 'above' : 'below';
    const sgn = zi >= 0 ? 1 : -1;
    if (Math.abs(zi) > limit) {
      out.push({ index: i, rule: 1, side });
      continue;
    }
    if (!all) continue;
    const countBeyond = (len: number, k: number) => {
      if (i < len - 1) return 0;
      let c = 0;
      for (let j = i - len + 1; j <= i; j++) if (sgn * z[j]! > k) c++;
      return c;
    };
    // The point completing the run must itself be part of it.
    if (sgn * zi > 2 && countBeyond(3, 2) >= 2) {
      out.push({ index: i, rule: 2, side });
      continue;
    }
    if (sgn * zi > 1 && countBeyond(5, 1) >= 4) {
      out.push({ index: i, rule: 3, side });
      continue;
    }
    if (i >= 7 && zi !== 0) {
      let run = true;
      for (let j = i - 7; j <= i; j++) if (!(sgn * z[j]! > 0)) run = false;
      if (run) out.push({ index: i, rule: 4, side });
    }
  }
  return out;
}

export const runSpc: ModelRunner = (data, spec): ModelOutput => {
  const notes: string[] = [];
  const d0 = data.dims[0];
  const m0 = data.metrics[0];
  if (!d0 || !m0) throw new ModelError('A control chart needs an ordered field (usually a date) and one measure.');

  // The series in order: by date when the field is a date, else the rows as given.
  let labels: string[] = [];
  let xs: number[] = [];
  let blanks = 0;
  if (d0.isDate) {
    const s = timeSeries(data, 8);
    s.values.forEach((v, i) => {
      if (typeof v === 'number' && Number.isFinite(v)) {
        labels.push(s.labels[i]!);
        xs.push(v);
      } else blanks++;
    });
  } else {
    for (const r of data.rows) {
      const v = r.values[0];
      if (typeof v === 'number' && Number.isFinite(v)) {
        labels.push(cellLabel(r.dims[0] ?? null, d0.grain));
        xs.push(v);
      } else blanks++;
    }
  }
  if (blanks) notes.push(`${blanks} point${blanks === 1 ? '' : 's'} with no value ${blanks === 1 ? 'was' : 'were'} skipped.`);
  if (xs.length > 10000) {
    notes.push(`Only the last 10,000 of ${xs.length.toLocaleString('en-US')} points are charted.`);
    labels = labels.slice(-10000);
    xs = xs.slice(-10000);
  }
  const n = xs.length;
  if (n < 8) throw new ModelError(`A control chart needs at least 8 points with values; this flag has ${n}.`);

  const L = numParam(spec, 'sigma', 3, 1, 6);
  const lambda = numParam(spec, 'lambda', 0.2, 0.05, 1);
  const k = numParam(spec, 'k', 0.5, 0.1, 3);
  const h = numParam(spec, 'h', 5, 1, 10);
  const rules = param(spec, 'rules', true);
  const kindRaw = param(spec, 'chart', 'imr');
  const kind = kindRaw === 'ewma' || kindRaw === 'cusum' ? kindRaw : 'imr';
  let base = Math.round(numParam(spec, 'baseline', 0, 0, 10000));
  if (base > 0 && base < 5) {
    notes.push(`A baseline of ${base} points is too few to set limits; the first 5 were used.`);
    base = 5;
  }
  if (base > n) {
    notes.push(`The baseline asks for ${base} points but there are ${n}; all of them were used.`);
    base = 0;
  }
  const nb = base || n;

  // Centre and sigma from the baseline: mean, and the average moving range over d2.
  let centre = 0;
  for (let i = 0; i < nb; i++) centre += xs[i]!;
  centre /= nb;
  let mr = 0;
  for (let i = 1; i < nb; i++) mr += Math.abs(xs[i]! - xs[i - 1]!);
  mr /= nb - 1;
  const sigma = mr / D2;
  if (!(sigma > 0)) throw new ModelError('The values never change from one point to the next in the baseline, so there is no natural variation to set limits from.');

  const mf = m0.format;
  const f = (v: number) => fmt(v, 'metric', mf);
  const ucl = centre + L * sigma;
  const lcl = centre - L * sigma;
  const x = labels;
  const marks: Array<{ index: number; tone: Tone; label?: string }> = [];
  let signals: Array<{ index: number; text: string; side: 'above' | 'below' }> = [];
  let chart: ModelOutput['chart'];
  const tableCols = ['Point', m0.label, 'Centre', 'Lower limit', 'Upper limit'];
  const extraCols: string[] = [];
  const extra: Array<Array<number | null>> = [];
  let lower: number[];
  let upper: number[];

  if (kind === 'imr') {
    const z = xs.map((v) => (v - centre) / sigma);
    const sig = westernElectric(z, L, rules);
    const say = (s: Signal) =>
      s.rule === 1
        ? `the value ${s.side === 'above' ? 'rose above the upper' : 'fell below the lower'} limit`
        : s.rule === 2
          ? `2 of 3 points sat more than 2σ ${s.side} the centre`
          : s.rule === 3
            ? `4 of 5 points sat more than 1σ ${s.side} the centre`
            : `8 points in a row sat ${s.side} the centre`;
    signals = sig.map((s) => ({ index: s.index, side: s.side, text: say(s) }));
    for (const s of sig) marks.push({ index: s.index, tone: s.rule === 1 ? 'bad' : 'warn', label: s.rule === 1 ? `Beyond ${fmt(L, 'decimal')}σ` : RULE_TEXT[s.rule] });
    lower = xs.map(() => lcl);
    upper = xs.map(() => ucl);
    chart = {
      kind: 'series',
      x,
      series: [
        { name: m0.label, values: xs, role: 'actual' },
        { name: 'Centre', values: xs.map(() => centre), role: 'line' },
        { name: 'Upper limit', values: upper, role: 'limit' },
        { name: 'Lower limit', values: lower, role: 'limit' },
      ],
      marks,
      yFormat: 'metric',
    };
  } else if (kind === 'ewma') {
    const zs: number[] = [];
    lower = [];
    upper = [];
    let zPrev = centre;
    for (let i = 0; i < n; i++) {
      const zi = lambda * xs[i]! + (1 - lambda) * zPrev;
      zPrev = zi;
      zs.push(zi);
      const w = L * sigma * Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * (i + 1))));
      lower.push(centre - w);
      upper.push(centre + w);
      if (zi > centre + w || zi < centre - w) {
        const side = zi > centre ? 'above' : 'below';
        signals.push({ index: i, side, text: `the smoothed average ${side === 'above' ? 'rose above' : 'fell below'} its limit` });
        marks.push({ index: i, tone: 'bad', label: 'EWMA beyond limit' });
      }
    }
    extraCols.push('EWMA');
    extra.push(zs);
    chart = {
      kind: 'series',
      x,
      series: [
        { name: 'EWMA', values: zs, role: 'actual' },
        { name: m0.label, values: xs, role: 'fit' },
        { name: 'Centre', values: xs.map(() => centre), role: 'line' },
        { name: 'Upper limit', values: upper, role: 'limit' },
        { name: 'Lower limit', values: lower, role: 'limit' },
      ],
      marks,
      yFormat: 'metric',
    };
    notes.push(`The EWMA weights each new point by ${fmt(lambda, 'decimal')}: smaller weights catch smaller, slower drifts.`);
  } else {
    const hi: number[] = [];
    const lo: number[] = [];
    let cp = 0;
    let cm = 0;
    for (let i = 0; i < n; i++) {
      cp = Math.max(0, xs[i]! - (centre + k * sigma) + cp);
      cm = Math.max(0, centre - k * sigma - xs[i]! + cm);
      hi.push(cp);
      lo.push(-cm);
      const up = cp > h * sigma;
      const down = cm > h * sigma;
      if (up || down) {
        const side = up ? 'above' : 'below';
        signals.push({ index: i, side, text: `the running sum shows a shift ${up ? 'up' : 'down'}` });
        marks.push({ index: i, tone: 'bad', label: up ? 'CUSUM shift up' : 'CUSUM shift down' });
      }
    }
    lower = xs.map(() => -h * sigma);
    upper = xs.map(() => h * sigma);
    extraCols.push('CUSUM up', 'CUSUM down');
    extra.push(hi, lo);
    chart = {
      kind: 'series',
      x,
      series: [
        { name: 'CUSUM up', values: hi, role: 'actual' },
        { name: 'CUSUM down', values: lo, role: 'actual' },
        { name: 'Zero', values: xs.map(() => 0), role: 'line' },
        { name: 'Upper limit', values: upper, role: 'limit' },
        { name: 'Lower limit', values: lower, role: 'limit' },
      ],
      marks,
      yFormat: 'metric',
    };
    notes.push(`CUSUM adds up how far each point sits beyond ${fmt(k, 'decimal')}σ from the centre and signals past ${fmt(h, 'decimal')}σ: good at catching small sustained shifts.`);
  }

  const count = signals.length;
  const last = signals.at(-1);
  const chartName = kind === 'imr' ? 'control chart' : kind === 'ewma' ? 'EWMA chart' : 'CUSUM chart';
  const headline = !last
    ? `The process is in control: all ${n.toLocaleString('en-US')} points vary within the limits${kind === 'imr' && rules ? ' with no unusual runs' : ''}, so the changes are ordinary noise.`
    : `${count} point${count === 1 ? '' : 's'} signal${count === 1 ? 's' : ''} a real change on the ${chartName}; the latest is ${labels[last.index]}, where ${last.text}.`;
  const sentences: string[] = [];
  sentences.push(`The centre is ${f(centre)} and natural variation is about ${f(sigma)} (one sigma, from the average point-to-point change), so ${kind === 'imr' ? `ordinary values fall between ${f(lcl)} and ${f(ucl)}` : 'the limits sit where noise alone would rarely reach'}.`);
  if (base) sentences.push(`The limits come from the first ${base} points only, so later points are judged against that period.`);
  if (last) {
    const first = signals[0]!;
    if (count > 1) sentences.push(`The first signal was at ${labels[first.index]}; look for what changed around then.`);
    sentences.push('A signal means something beyond everyday variation is at work: worth finding the cause rather than reacting to every rise and fall.');
  } else sentences.push('Reacting to individual ups and downs here would be chasing noise.');
  if (n < 20) notes.push(`Only ${n} points: limits from fewer than 20 are rough.`);
  notes.push('Assumes the points are independent; strong seasonality or autocorrelation makes the limits too tight.');

  const marked = new Map(signals.map((s) => [s.index, s.text]));
  const rows = xs.map((v, i) => [labels[i]!, v, kind === 'cusum' ? 0 : centre, lower[i]!, upper[i]!, ...extra.map((e) => e[i] ?? null), marked.get(i) ?? ''] as Array<string | number | null>);

  return {
    model: 'spc',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Centre', value: centre, format: 'metric', hint: base ? `Mean of the first ${base} points.` : 'Mean of all points.' },
      { label: 'Lower limit', value: lcl, format: 'metric', hint: `Centre − ${fmt(L, 'decimal')}σ.` },
      { label: 'Upper limit', value: ucl, format: 'metric', hint: `Centre + ${fmt(L, 'decimal')}σ.` },
      { label: 'Sigma', value: sigma, format: 'metric', hint: 'Average moving range ÷ 1.128.' },
      { label: 'Signals', value: count, format: 'integer', hint: 'Points beyond the limits or completing a run rule.' },
    ],
    chart,
    table: { columns: [...tableCols, ...extraCols, 'Signal'], rows },
    notes,
  };
};
