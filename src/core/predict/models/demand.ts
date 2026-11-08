// Spare-parts demand: the reorder point and safety stock for a part used now and then. The quantity
// used each period (blank periods count as 0) is classified and forecast, then turned into stock
// levels for the lead time.
//
// Methods:
// - Pattern: Syntetos, Boylan and Croston (2005): ADI (average periods between demands) and CV² of the
//   non-zero sizes, cut at 1.32 and 0.49 into smooth, erratic, intermittent and lumpy.
// - Croston (1972): smooth the non-zero sizes and the intervals between them separately; rate = z/p.
// - Syntetos–Boylan approximation (SBA, 2005): Croston × (1 − α/2), which removes Croston's upward bias.
// - Teunter, Syntetos and Babai (TSB, 2011): smooth the chance of a demand every period (so the rate
//   decays when a part stops being used) and the size when there is one; rate = π·z.
// - Poisson: a steady small-count rate (the mean), with exact Poisson lead-time quantiles.
// The 'auto' rule: Poisson when the mean is under 5 a period and the variance is within 25% of the mean
// (counts that behave like independent arrivals); otherwise SBA for intermittent and lumpy patterns,
// and Croston for smooth and erratic ones (with a demand every period Croston is plain exponential
// smoothing).
// Stock: lead-time demand mean = L·rate; spread from Poisson, or from the one-step forecast errors
// (sd·√L, assuming independent errors). Reorder point = mean + z·sd (Poisson: the smallest r with
// P(D ≤ r) ≥ service); safety stock = reorder point − mean; EOQ = √(2·D·S/H) (Harris, 1913).

import { futureLabels, timeSeries } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { mean, normalInv, variance } from '../stats.ts';
import { ModelError, type ModelRunner, type ModelStat, numParam, param } from '../types.ts';

export type Pattern = 'smooth' | 'erratic' | 'intermittent' | 'lumpy';
export type DemandMethod = 'croston' | 'sba' | 'tsb' | 'poisson';

/** Syntetos–Boylan–Croston classification from ADI and CV² of the non-zero sizes. */
export function classify(values: ArrayLike<number>): { adi: number; cv2: number; pattern: Pattern } {
  const nz: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i]! > 0) nz.push(values[i]!);
  const adi = nz.length ? values.length / nz.length : Infinity;
  const m = mean(nz);
  const cv2 = nz.length > 1 ? variance(nz) / (m * m) : 0;
  const pattern: Pattern = adi < 1.32 ? (cv2 < 0.49 ? 'smooth' : 'erratic') : cv2 < 0.49 ? 'intermittent' : 'lumpy';
  return { adi, cv2, pattern };
}

/**
 * Croston's method (with `sba`, the Syntetos–Boylan correction). Starts from the first demand and its
 * interval (its 1-based period). Returns the one-step-ahead rate for every period (null before the
 * first demand is seen) and the final rate.
 */
export function croston(values: ArrayLike<number>, alpha: number, sba = false): { fitted: Array<number | null>; rate: number } {
  const n = values.length;
  const fitted: Array<number | null> = new Array(n).fill(null);
  const k = sba ? 1 - alpha / 2 : 1;
  let z = Number.NaN;
  let p = Number.NaN;
  let last = -1;
  for (let t = 0; t < n; t++) {
    if (last >= 0) fitted[t] = (k * z) / p;
    const d = values[t]!;
    if (d > 0) {
      if (last < 0) {
        z = d;
        p = t + 1;
      } else {
        z += alpha * (d - z);
        p += alpha * (t - last - p);
      }
      last = t;
    }
  }
  return { fitted, rate: last >= 0 ? (k * z) / p : 0 };
}

/** TSB: the demand chance π (start: the share of periods with demand) and size z (start: the first demand). */
export function tsb(values: ArrayLike<number>, alpha: number, beta = alpha): { fitted: Array<number | null>; rate: number } {
  const n = values.length;
  let nz = 0;
  let first = Number.NaN;
  for (let t = 0; t < n; t++)
    if (values[t]! > 0) {
      nz++;
      if (Number.isNaN(first)) first = values[t]!;
    }
  let pi = nz / n;
  let z = Number.isNaN(first) ? 0 : first;
  const fitted: Array<number | null> = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    fitted[t] = pi * z;
    const d = values[t]!;
    pi += beta * ((d > 0 ? 1 : 0) - pi);
    if (d > 0) z += alpha * (d - z);
  }
  return { fitted, rate: pi * z };
}

/** The smallest r with P(X ≤ r) ≥ q for X ~ Poisson(mu), summing the exact probabilities in log space. */
export function poissonQuantile(mu: number, q: number): number {
  if (mu <= 0) return 0;
  if (mu > 1e5) return Math.ceil(mu + normalInv(q) * Math.sqrt(mu) - 0.5);
  let logp = -mu;
  let cum = Math.exp(logp);
  let r = 0;
  while (cum < q && r < 1e7) {
    r++;
    logp += Math.log(mu / r);
    cum += Math.exp(logp);
  }
  return r;
}

export const eoq = (demandPerPeriod: number, orderCost: number, holdingCost: number) => Math.sqrt((2 * demandPerPeriod * orderCost) / holdingCost);

const PATTERN_WORDS: Record<Pattern, string> = {
  smooth: 'smooth (used most periods, in similar amounts)',
  erratic: 'erratic (used most periods, in very different amounts)',
  intermittent: 'intermittent (many periods with none, similar amounts when used)',
  lumpy: 'lumpy (many periods with none, very different amounts when used)',
};
const METHOD_WORDS: Record<DemandMethod, string> = { croston: 'Croston', sba: 'Syntetos-Boylan (SBA)', tsb: 'TSB', poisson: 'Poisson' };

export const runDemand: ModelRunner = (data, spec) => {
  const series = timeSeries(data, 4);
  const notes: string[] = [];
  const blanks = series.values.filter((v) => v === null).length;
  if (blanks) notes.push(`${blanks} period${blanks === 1 ? '' : 's'} with no figure ${blanks === 1 ? 'was' : 'were'} counted as zero demand.`);
  let negatives = 0;
  const values = series.values.map((v) => {
    const x = v ?? 0;
    if (x < 0) negatives++;
    return Math.max(0, x);
  });
  if (negatives) notes.push(`${negatives} negative quantit${negatives === 1 ? 'y (a return?) was' : 'ies (returns?) were'} counted as zero.`);
  const n = values.length;
  const nonZero = values.filter((v) => v > 0).length;
  if (nonZero === 0) throw new ModelError('Every period shows zero demand, so there is no usage to plan stock for.');
  if (nonZero < 2) throw new ModelError('Only one period shows any demand; at least two are needed to estimate how often the part is used.');

  const alpha = numParam(spec, 'alpha', 0.1, 0.01, 1);
  const leadTime = numParam(spec, 'leadTime', 2, 0, 104);
  const service = numParam(spec, 'service', 0.95, 0.5, 0.999);
  const orderCost = numParam(spec, 'orderCost', 0, 0, Number.MAX_VALUE);
  const holdingCost = numParam(spec, 'holdingCost', 0, 0, Number.MAX_VALUE);
  const asked: string = param(spec, 'method', 'auto');
  const cls = classify(values);
  const m = mean(values);
  const dispersion = n > 1 ? variance(values) / m : Number.NaN;
  let method: DemandMethod;
  let why: string;
  if (asked === 'croston' || asked === 'sba' || asked === 'tsb' || asked === 'poisson') {
    method = asked;
    why = 'as set';
  } else if (m < 5 && dispersion >= 0.75 && dispersion <= 1.25) {
    method = 'poisson';
    why = `because usage is a small count whose variance is close to its mean (${fmt(dispersion, 'decimal')}×), the mark of independent arrivals`;
  } else if (cls.pattern === 'intermittent' || cls.pattern === 'lumpy') {
    method = 'sba';
    why = `because the pattern is ${cls.pattern}`;
  } else {
    method = 'croston';
    why = `because the pattern is ${cls.pattern}`;
  }

  const est = method === 'poisson' ? { fitted: values.map((_, t) => (t === 0 ? null : mean(values.slice(0, t)))), rate: m } : method === 'tsb' ? tsb(values, alpha) : croston(values, alpha, method === 'sba');
  const rate = est.rate;

  // One-step errors for the spread of non-Poisson methods.
  let sse = 0;
  let cnt = 0;
  est.fitted.forEach((f, t) => {
    if (f === null) return;
    sse += (values[t]! - f) ** 2;
    cnt++;
  });
  const sd1 = cnt ? Math.sqrt(sse / cnt) : Math.sqrt(variance(values));
  let lead = leadTime;
  if (lead <= 0) {
    lead = 1;
    notes.push('Lead time is 0, so the reorder point is worked out for one period of demand.');
  }
  const ltMean = lead * rate;
  let rop: number;
  if (method === 'poisson') {
    rop = poissonQuantile(ltMean, service);
  } else {
    const ltSd = sd1 * Math.sqrt(lead);
    rop = Math.max(0, Math.ceil(ltMean + normalInv(service) * ltSd - 1e-9));
    if (cls.pattern !== 'smooth') notes.push('The reorder point assumes lead-time demand is roughly normal; with intermittent use the true spread is skewed, so check it against past stock-outs.');
  }
  const safety = rop - ltMean;
  const q = orderCost > 0 && holdingCost > 0 && rate > 0 ? eoq(rate, orderCost, holdingCost) : null;
  const unitsWord = (v: number) => `${fmt(v, 'decimal')} unit${v === 1 ? '' : 's'}`;

  const headline = `Reorder at ${fmt(rop, 'integer')} unit${rop === 1 ? '' : 's'}; keep a safety stock of ${fmt(Math.max(0, safety), 'decimal')} for ${pct(service)} service.`;
  const sentences: string[] = [
    `The part is used about ${unitsWord(rate)} a period (${METHOD_WORDS[method]}, chosen ${why}), so ${unitsWord(ltMean)} are expected over the ${fmt(lead, 'decimal')}-period lead time.`,
    `Usage is ${PATTERN_WORDS[cls.pattern]}: a demand every ${fmt(cls.adi, 'decimal')} periods on average, size variation CV² ${fmt(cls.cv2, 'decimal')}.`,
    `Ordering when stock falls to ${fmt(rop, 'integer')} covers lead-time demand ${pct(service)} of the time.`,
  ];
  if (q !== null) sentences.push(`The economic order quantity is about ${fmt(q, 'integer')} units, roughly one order every ${fmt(q / rate, 'decimal')} periods.`);
  if (method === 'tsb' && rate < 0.5 * m) sentences.push('TSB has brought the rate down because recent periods show less use: the part may be going out of service.');
  if (n < 12) notes.push(`Only ${n} periods of history: rates for parts used now and then need a year or more to settle.`);

  const stats: ModelStat[] = [
    { label: 'Rate per period', value: rate, format: 'decimal', hint: 'Forecast units used each period.' },
    { label: 'Reorder point', value: rop, format: 'integer', hint: 'Order when stock on hand and on order falls to this.' },
    { label: 'Safety stock', value: safety, format: 'decimal', hint: 'Units held above the expected lead-time demand.' },
    ...(q !== null ? [{ label: 'EOQ', value: q, format: 'integer' as const, hint: 'Order size that balances ordering and holding costs.' }] : []),
    { label: 'Pattern', value: cls.pattern, hint: `ADI ${fmt(cls.adi, 'decimal')}, CV² ${fmt(cls.cv2, 'decimal')}.` },
  ];

  const h = Math.min(52, Math.max(6, Math.ceil(lead)));
  const fut = futureLabels(series, h);
  const x = [...series.labels, ...fut.labels];
  const nulls = (k: number) => new Array<number | null>(k).fill(null);
  const actual = [...values, ...nulls(h)];
  const fit = [...est.fitted, ...nulls(h)];
  const forecast = [...nulls(n - 1), values[n - 1]!, ...new Array<number>(h).fill(rate)];
  const chart = {
    kind: 'series' as const,
    x,
    series: [
      { name: 'Used', values: actual, role: 'actual' as const },
      { name: 'Smoothed rate', values: fit, role: 'fit' as const },
      { name: 'Forecast rate', values: forecast, role: 'forecast' as const },
    ],
    yFormat: 'metric' as const,
  };
  const table = {
    columns: ['Period', 'Used', 'Smoothed rate', 'Forecast rate'],
    rows: x.map((label, i) => [label, i < n ? values[i]! : null, i < n ? (est.fitted[i] ?? null) : null, i >= n ? rate : null] as Array<string | number | null>),
  };
  return { model: 'demand', headline, sentences: sentences.slice(0, 5), stats, chart, table, notes };
};
