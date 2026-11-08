// Unusual values in one measure across rows. Three methods:
// - Robust z (Iglewicz and Hoaglin, 1993): (x − median) / MAD, with the MAD scaled by 1.4826 so it
//   estimates the standard deviation of normal data (stats.mad); 3.5 is their suggested cut-off.
// - Z-score: (x − mean) / standard deviation. Simple, but a big outlier inflates the sd it is judged by.
// - Tukey's fences (box plot): below Q1 − t·IQR or above Q3 + t·IQR, t = 1.5 by convention.

import { cellLabel } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { mad as madOf, mean, median, quantileSorted, sd as sdOf, sorted } from '../stats.ts';
import { ModelError, type ModelOutput, type ModelRunner, numParam, param } from '../types.ts';

type Method = 'mad' | 'zscore' | 'iqr';

export const runAnomaly: ModelRunner = (data, spec): ModelOutput => {
  const notes: string[] = [];
  const m0 = data.metrics[0];
  if (!m0) throw new ModelError('Anomaly detection needs a measure to check.');
  const raw = param(spec, 'method', 'mad');
  const method: Method = raw === 'zscore' || raw === 'iqr' ? raw : 'mad';
  // The box-plot rule's usual multiple is 1.5; the shared default of 3.5 suits the other two.
  const t = method === 'iqr' && spec.params?.threshold === undefined ? 1.5 : numParam(spec, 'threshold', 3.5, 0.5, 10);

  const d0 = data.dims[0];
  const ordered = !!d0 && (d0.isDate || !!d0.grain);
  let pts: Array<{ label: string; key: string; v: number }> = [];
  let dropped = 0;
  for (const [i, r] of data.rows.entries()) {
    const v = r.values[0];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      dropped++;
      continue;
    }
    const label = data.dims.length ? r.dims.map((c, j) => cellLabel(c, data.dims[j]?.grain)).join(' · ') : `Row ${i + 1}`;
    pts.push({ label, key: String(r.dims[0] ?? ''), v });
  }
  if (ordered) pts = pts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (dropped) notes.push(`${dropped} row${dropped === 1 ? ' was' : 's were'} left out because the measure was blank.`);
  const n = pts.length;
  if (n < 5) throw new ModelError(`Anomaly detection needs at least 5 rows with a number; this flag has ${n}.`);
  const xs = Float64Array.from(pts.map((p) => p.v));

  let centre: number;
  let lowFence: number;
  let highFence: number;
  let score: (x: number) => number;
  let unitWord: string;
  if (method === 'iqr') {
    const s = sorted(xs);
    const q1 = quantileSorted(s, 0.25);
    const q3 = quantileSorted(s, 0.75);
    const iqr = q3 - q1;
    if (!(iqr > 0)) throw new ModelError('At least half the values are identical, so the box-plot fences have no width; try the z-score method.');
    centre = quantileSorted(s, 0.5);
    lowFence = q1 - t * iqr;
    highFence = q3 + t * iqr;
    // How far past the box, in box widths: beyond t is outside a fence.
    score = (x) => (x > q3 ? (x - q3) / iqr : x < q1 ? (x - q1) / iqr : 0);
    unitWord = 'box widths beyond the middle half';
  } else if (method === 'zscore') {
    centre = mean(xs);
    const s = sdOf(xs);
    if (!(s > 0)) throw new ModelError('Every value is the same, so none stands out.');
    lowFence = centre - t * s;
    highFence = centre + t * s;
    score = (x) => (x - centre) / s;
    unitWord = 'standard deviations from the average';
    if (n < 12 && t > (n - 1) / Math.sqrt(n)) notes.push(`With ${n} rows no z-score can pass ${fmt(t, 'decimal')}; lower the threshold or use the robust method.`);
  } else {
    centre = median(xs);
    let m = madOf(xs);
    if (!(m > 0)) {
      // More than half the values equal the median: fall back to the mean absolute deviation
      // (scaled by √(π/2) ≈ 1.2533 to estimate the sd of normal data).
      let a = 0;
      for (let i = 0; i < n; i++) a += Math.abs(xs[i]! - centre);
      m = (1.2533 * a) / n;
      if (!(m > 0)) throw new ModelError('Every value is the same, so none stands out.');
      notes.push('More than half the values are identical, so the spread was measured by the mean absolute deviation instead of the median one.');
    }
    const scale = m;
    lowFence = centre - t * scale;
    highFence = centre + t * scale;
    score = (x) => (x - centre) / scale;
    unitWord = 'robust deviations from the median';
  }

  const flagged = pts
    .map((p, i) => ({ ...p, i, score: score(p.v) }))
    .filter((p) => p.v > highFence || p.v < lowFence);
  const worst = [...flagged].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
  const highs = flagged.filter((p) => p.v > highFence).length;

  const mf = m0.format;
  const f = (v: number) => fmt(v, 'metric', mf);
  const typicalWord = method === 'zscore' ? 'average' : 'median';
  const headline = worst
    ? `${flagged.length} of ${n.toLocaleString('en-US')} values ${flagged.length === 1 ? 'is' : 'are'} unusual; the most extreme is ${worst.label} at ${f(worst.v)}, ${fmt(Math.abs(worst.score), 'decimal')} ${unitWord} ${worst.v > centre ? 'above' : 'below'}.`
    : `No values are unusual: all ${n.toLocaleString('en-US')} sit between ${f(lowFence)} and ${f(highFence)}.`;
  const sentences: string[] = [];
  sentences.push(`The typical value (${typicalWord}) is ${f(centre)}; values outside ${f(lowFence)} to ${f(highFence)} are flagged.`);
  if (flagged.length) sentences.push(`${highs} ${highs === 1 ? 'is' : 'are'} unusually high and ${flagged.length - highs} unusually low. Check each against its source before acting: an outlier is often a data error, sometimes the most important row.`);
  if (method === 'zscore') sentences.push('Z-scores are pulled by the outliers they look for; the robust method is safer when there are several.');
  else if (method === 'mad') sentences.push('The robust method judges each value against the median and the median distance, so a few extreme values cannot hide each other.');
  if (n > 0 && flagged.length / n > 0.1) notes.push(`${pct(flagged.length / n)} of values are flagged: the data may be skewed or mixed groups rather than containing a few outliers.`);

  const MAX_POINTS = 5000;
  let chart: ModelOutput['chart'];
  if (ordered) {
    const keep = pts.length > MAX_POINTS ? pts.length - MAX_POINTS : 0;
    if (keep) notes.push(`The chart shows the last ${MAX_POINTS.toLocaleString('en-US')} points; all were checked.`);
    chart = {
      kind: 'series',
      x: pts.slice(keep).map((p) => p.label),
      series: [
        { name: m0.label, values: pts.slice(keep).map((p) => p.v), role: 'actual' },
        { name: 'Typical', values: pts.slice(keep).map(() => centre), role: 'line' },
        { name: 'Upper fence', values: pts.slice(keep).map(() => highFence), role: 'limit' },
        { name: 'Lower fence', values: pts.slice(keep).map(() => lowFence), role: 'limit' },
      ],
      marks: flagged.filter((p) => p.i >= keep).map((p) => ({ index: p.i - keep, tone: p.v > highFence ? ('bad' as const) : ('warn' as const), label: p.label })),
      yFormat: 'metric',
    };
  } else {
    const flagSet = new Map(flagged.map((p) => [p.i, p]));
    const shown = pts.slice(0, MAX_POINTS);
    if (pts.length > MAX_POINTS) notes.push(`The chart shows the first ${MAX_POINTS.toLocaleString('en-US')} rows; all were checked.`);
    chart = {
      kind: 'scatter',
      points: shown.map((p, i) => {
        const fl = flagSet.get(i);
        return { x: i + 1, y: p.v, label: p.label, ...(fl ? { tone: fl.v > highFence ? ('bad' as const) : ('warn' as const) } : {}) };
      }),
      xLabel: 'Row',
      yLabel: m0.label,
      yFormat: 'metric',
    };
  }

  const scoreCol = method === 'iqr' ? 'Box widths beyond' : method === 'zscore' ? 'Z-score' : 'Robust z';
  return {
    model: 'anomaly',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Unusual values', value: flagged.length, format: 'integer' },
      { label: 'Share flagged', value: flagged.length / n, format: 'percent' },
      { label: `Typical (${typicalWord})`, value: centre, format: 'metric' },
      { label: 'Low fence', value: lowFence, format: 'metric', hint: 'Values below this are flagged.' },
      { label: 'High fence', value: highFence, format: 'metric', hint: 'Values above this are flagged.' },
    ],
    chart,
    table: {
      columns: [d0?.label ?? 'Row', m0.label, scoreCol, 'Direction'],
      rows: [...flagged].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).map((p) => [p.label, p.v, p.score, p.v > highFence ? 'High' : 'Low']),
    },
    notes,
  };
};
