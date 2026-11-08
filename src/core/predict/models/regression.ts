// Regression (drivers): what moves a measure, and by how much. Ordinary least squares by Householder
// QR (linalg.leastSquares) with an intercept. The first measure is the target, the rest are drivers;
// with exactly one driver the `degree` setting fits a polynomial curve (x, x², x³).
//
// Reported: coefficients with standard errors, t statistics, two-sided p-values and confidence
// intervals (Student's t), R² and adjusted R², the overall F test, the residual standard deviation,
// standardised coefficients (β·sd(x)/sd(y)) to rank drivers on one scale, and the variance inflation
// factor (VIF = 1/(1−R²ⱼ)) of each driver to flag collinearity.

import { droppedNote, items } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { leastSquares } from '../linalg.ts';
import { fCdf, mean, sd, tInv, tPValue } from '../stats.ts';
import { type ModelChart, ModelError, type ModelRunner, type ModelStat, numParam } from '../types.ts';

/** "< 0.001" or "0.042": a p-value as an analyst reads it. */
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '–';
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}

/** Plain words for how sure a p-value lets us be. */
export function pWords(p: number): string {
  return p < 0.01 ? 'very unlikely to be chance' : p < 0.05 ? 'unlikely to be chance' : p < 0.1 ? 'only weak evidence' : 'could easily be chance';
}

/** R² of one column regressed on the others plus an intercept (for VIF and naming collinear drivers). */
function auxR2(cols: number[][], j: number): number {
  const n = cols[0]?.length ?? 0;
  const y = cols[j]!;
  const others = cols.filter((_, i) => i !== j);
  const x = Array.from({ length: n }, (_, r) => [1, ...others.map((c) => c[r]!)]);
  const my = mean(y);
  let tss = 0;
  for (const v of y) tss += (v - my) ** 2;
  if (tss === 0) return 1;
  try {
    const fit = leastSquares(x, y);
    return 1 - fit.rss / tss;
  } catch {
    return 1;
  }
}

/** The drivers that make the design singular, named for the error message. */
function collinearNames(cols: number[][], names: string[]): string[] {
  const out: string[] = [];
  cols.forEach((c, j) => {
    if (sd(c) === 0 || !Number.isFinite(sd(c))) out.push(`${names[j]} (it never changes)`);
  });
  if (out.length) return out;
  cols.forEach((_, j) => {
    if (auxR2(cols, j) > 1 - 1e-9) out.push(names[j]!);
  });
  return out;
}

export const runRegression: ModelRunner = (data, spec) => {
  const it = items(data, 3, 2);
  const level = numParam(spec, 'level', 0.9, 0.5, 0.999);
  const target = it.metricLabels[0]!;
  const tFormat = data.metrics[0]?.format;
  const driverNames = it.metricLabels.slice(1);
  const notes: string[] = [...droppedNote(it.dropped)];
  const y = it.values.map((r) => r[0]!);
  const n = y.length;

  const askedDegree = Math.round(numParam(spec, 'degree', 1, 1, 3));
  const degree = driverNames.length === 1 ? askedDegree : 1;
  if (askedDegree > 1 && driverNames.length > 1) notes.push('The curve setting applies with one driver only, so straight-line effects were fitted.');

  // Design columns: drivers as they are, or x, x², x³ for a one-driver curve.
  let cols: number[][];
  let names: string[];
  if (degree > 1) {
    const x = it.values.map((r) => r[1]!);
    cols = [];
    names = [];
    for (let d = 1; d <= degree; d++) {
      cols.push(x.map((v) => v ** d));
      names.push(d === 1 ? driverNames[0]! : `${driverNames[0]}${d === 2 ? '²' : '³'}`);
    }
  } else {
    cols = driverNames.map((_, j) => it.values.map((r) => r[j + 1]!));
    names = [...driverNames];
  }
  const k = cols.length;
  if (n <= k + 1) throw new ModelError(`Regression with ${k} driver term${k === 1 ? '' : 's'} needs more than ${k + 1} rows; this flag has ${n}. Add rows or drop drivers.`);
  const ySd = sd(y);
  if (!(ySd > 0)) throw new ModelError(`${target} is the same on every row, so there is nothing to explain.`);

  const design = Array.from({ length: n }, (_, r) => [1, ...cols.map((c) => c[r]!)]);
  let fit: ReturnType<typeof leastSquares>;
  try {
    fit = leastSquares(design, y);
  } catch {
    const bad = collinearNames(cols, names);
    throw new ModelError(`The drivers are not independent${bad.length ? `: ${bad.join(', ')} can be worked out from the others` : ''}. Drop one of them and run again.`);
  }

  const df = n - k - 1;
  const my = mean(y);
  let tss = 0;
  for (const v of y) tss += (v - my) ** 2;
  const rss = Math.max(0, fit.rss);
  const exact = rss <= 1e-20 * tss;
  const sigma2 = exact ? 0 : rss / df;
  const tcrit = tInv(0.5 + level / 2, df);
  const coef = fit.beta.map((b, j) => {
    const se = Math.sqrt(Math.max(0, sigma2 * fit.xtxInv[j]![j]!));
    const t = se > 0 ? b / se : b === 0 ? 0 : Infinity * Math.sign(b);
    const p = se > 0 ? tPValue(t, df) : b === 0 ? 1 : 0;
    return { b, se, t, p, low: b - tcrit * se, high: b + tcrit * se };
  });
  const r2 = exact ? 1 : 1 - rss / tss;
  const adjR2 = 1 - ((1 - r2) * (n - 1)) / df;
  const fStat = exact ? Infinity : ((tss - rss) / k) / (rss / df);
  const fP = exact ? 0 : 1 - fCdf(fStat, k, df);
  const residSd = Math.sqrt(sigma2);

  // Standardised coefficients: the change in sd(y) per sd(x), comparable across drivers.
  const xSd = cols.map((c) => sd(c));
  const std = names.map((_, j) => (coef[j + 1]!.b * xSd[j]!) / ySd);
  const stdLow = names.map((_, j) => (coef[j + 1]!.low * xSd[j]!) / ySd);
  const stdHigh = names.map((_, j) => (coef[j + 1]!.high * xSd[j]!) / ySd);

  // Variance inflation factors (degree-1 fits with two or more drivers).
  const vif = degree === 1 && k >= 2 ? cols.map((_, j) => 1 / Math.max(1e-12, 1 - auxR2(cols, j))) : names.map(() => Number.NaN);
  const collinear = names.filter((_, j) => vif[j]! > 5);
  if (collinear.length) notes.push(`${collinear.join(', ')} ${collinear.length === 1 ? 'moves' : 'move'} closely with other drivers (VIF above 5), so ${collinear.length === 1 ? 'its' : 'their'} separate effects are uncertain; the combined fit is still sound.`);
  if (n < 10 * k) notes.push(`Only ${n} rows for ${k} driver term${k === 1 ? '' : 's'}: about 10 rows per driver gives steadier estimates.`);
  if (degree > 1) notes.push('Polynomial terms move together by design, so read the curve as a whole rather than each term on its own.');

  // Headline: the strongest driver in plain words.
  const sentences: string[] = [];
  let headline: string;
  const order = names.map((_, j) => j).sort((a, b) => Math.abs(std[b]!) - Math.abs(std[a]!));
  if (degree > 1) {
    const x = it.values.map((r) => r[1]!);
    const mx = mean(x);
    let slope = 0;
    for (let d = 1; d <= degree; d++) slope += d * coef[d]!.b * mx ** (d - 1);
    headline = `${target} follows a ${degree === 2 ? 'curve' : 'S-curve'} in ${driverNames[0]}: around the average ${driverNames[0]} of ${fmt(mx)}, each extra unit ${slope >= 0 ? 'adds' : 'takes off'} ${fmt(Math.abs(slope), 'metric', tFormat)} ${slope >= 0 ? 'to' : 'from'} ${target}.`;
  } else {
    const j = order[0]!;
    const b = coef[j + 1]!.b;
    const dFormat = data.metrics[j + 1]?.format;
    const unit = dFormat === 'currency' ? `$1 of ${names[j]}` : dFormat === 'percent' ? `percentage point of ${names[j]}` : `unit of ${names[j]}`;
    const per = dFormat === 'percent' ? b / 100 : b;
    headline = `Each extra ${unit} ${per >= 0 ? 'adds' : 'takes off'} ${fmt(Math.abs(per), 'metric', tFormat)} ${per >= 0 ? 'to' : 'from'} ${target}${k > 1 ? ', holding the other drivers steady' : ''}.`;
    if (k > 1) sentences.push(`${names[j]} is the strongest driver: one standard deviation more moves ${target} by ${fmt(Math.abs(std[j]!), 'decimal')} of its own standard deviation${coef[j + 1]!.p < 0.05 ? '' : ', though the effect could be chance'}.`);
  }
  sentences.push(`Together the driver${k === 1 && degree === 1 ? '' : 's'} explain ${pct(r2)} of the variation in ${target} (adjusted for the number of drivers, ${pct(Math.max(0, adjR2))}); the fit as a whole is ${pWords(fP)} (F test p ${fmtP(fP)}).`);
  if (degree === 1 && k > 1) {
    const weak = names.filter((_, j) => coef[j + 1]!.p >= 0.05);
    if (weak.length) sentences.push(`${weak.join(', ')} ${weak.length === 1 ? 'has' : 'have'} no clear effect once the others are counted (p 0.05 or above).`);
  }
  if (!exact) sentences.push(`Predictions from this fit are typically off by about ${fmt(residSd, 'metric', tFormat)} (residual standard deviation).`);
  else notes.push('The drivers explain the target exactly, so there is no noise left to measure uncertainty from.');

  const stats: ModelStat[] = [
    { label: 'R²', value: r2, format: 'percent', hint: 'The share of the variation in the target the drivers explain.' },
    { label: 'Adjusted R²', value: adjR2, format: 'percent', hint: 'R² with a penalty for each driver, for comparing fits with different drivers.' },
    { label: 'F test p', value: fP, format: 'decimal', hint: 'The chance of a fit this good if no driver mattered.' },
    { label: 'Typical error', value: residSd, format: 'metric', hint: 'Residual standard deviation: how far actual values sit from the fit.' },
    { label: 'Rows', value: n, format: 'integer' },
  ];

  let chart: ModelChart;
  if (driverNames.length === 1) {
    const x = it.values.map((r) => r[1]!);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of x) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const steps = degree === 1 ? 1 : 60;
    const line: Array<[number, number]> = [];
    for (let s = 0; s <= steps; s++) {
      const xv = lo + ((hi - lo) * s) / steps;
      let yv = coef[0]!.b;
      for (let d = 1; d <= degree; d++) yv += coef[d]!.b * xv ** d;
      line.push([xv, yv]);
    }
    chart = { kind: 'scatter', points: x.map((xv, i) => ({ x: xv, y: y[i]!, label: it.labels[i]! })), xLabel: driverNames[0]!, yLabel: target, line, yFormat: 'metric' };
  } else {
    chart = { kind: 'bars', labels: order.map((j) => names[j]!), values: order.map((j) => std[j]!), low: order.map((j) => stdLow[j]!), high: order.map((j) => stdHigh[j]!), base: 0, xFormat: 'decimal', xLabel: `Standardised effect on ${target} (standard deviations per standard deviation of the driver)` };
  }

  const lvl = `${Math.round(level * 100)}%`;
  const table = {
    columns: ['Driver', 'Coefficient', 'Std. error', `Low (${lvl})`, `High (${lvl})`, 'p-value', 'Standardised', 'VIF'],
    rows: [
      ['(Intercept)', coef[0]!.b, coef[0]!.se, coef[0]!.low, coef[0]!.high, coef[0]!.p, null, null] as Array<string | number | null>,
      ...names.map((nm, j) => [nm, coef[j + 1]!.b, coef[j + 1]!.se, coef[j + 1]!.low, coef[j + 1]!.high, coef[j + 1]!.p, std[j]!, Number.isFinite(vif[j]!) ? vif[j]! : null] as Array<string | number | null>),
    ],
  };
  return { model: 'regression', headline, sentences: sentences.slice(0, 5), stats, chart, table, notes };
};
