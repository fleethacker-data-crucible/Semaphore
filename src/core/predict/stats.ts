// Statistics every model shares: summaries, quantiles, and the distribution functions behind
// p-values and intervals (normal, Student's t, chi-square, F, gamma, beta). Written out here so the
// models need no library; each is a standard published method, named where it is used.

export function sum(xs: ArrayLike<number>): number {
  // Neumaier's compensated sum: long Monte Carlo totals stay exact to the last digit that matters.
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}

export function mean(xs: ArrayLike<number>): number {
  return xs.length ? sum(xs) / xs.length : Number.NaN;
}

/** Sample variance (n − 1). */
export function variance(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i]! - m) ** 2;
  return s / (n - 1);
}

export function sd(xs: ArrayLike<number>): number {
  return Math.sqrt(variance(xs));
}

export function sorted(xs: ArrayLike<number>): Float64Array {
  return Float64Array.from(xs as ArrayLike<number>).sort();
}

/** The p-quantile of already-sorted values, interpolated (Hyndman and Fan type 7, as R and Excel). */
export function quantileSorted(s: ArrayLike<number>, p: number): number {
  const n = s.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return s[0]!;
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export function quantile(xs: ArrayLike<number>, p: number): number {
  return quantileSorted(sorted(xs), p);
}

export function median(xs: ArrayLike<number>): number {
  return quantile(xs, 0.5);
}

/** Median absolute deviation, scaled by 1.4826 so it estimates the standard deviation of normal data. */
export function mad(xs: ArrayLike<number>): number {
  const m = median(xs);
  const dev = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) dev[i] = Math.abs(xs[i]! - m);
  return 1.4826 * median(dev);
}

/** Pearson correlation. */
export function correlation(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : Number.NaN;
}

/** Equal-width bins over the values, for a histogram. */
export function histogram(xs: ArrayLike<number>, bins = 40): Array<{ x0: number; x1: number; count: number }> {
  if (xs.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return [{ x0: lo, x1: hi, count: xs.length }];
  const k = Math.max(1, Math.min(bins, Math.ceil(Math.sqrt(xs.length))));
  const w = (hi - lo) / k;
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < xs.length; i++) counts[Math.min(k - 1, Math.floor((xs[i]! - lo) / w))]!++;
  return counts.map((count, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, count }));
}

// ---- special functions ----------------------------------------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** ln Γ(x) (Lanczos, g = 7): about 15 significant digits for x > 0. */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export function gammaFn(x: number): number {
  return Math.exp(lgamma(x));
}

/** Regularised lower incomplete gamma P(a, x) (Numerical Recipes: series below a + 1, continued fraction above). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let s = del;
    for (let n = 0; n < 500; n++) {
      ap++;
      del *= x / ap;
      s += del;
      if (Math.abs(del) < Math.abs(s) * 1e-15) break;
    }
    return s * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  return 1 - gammaQcf(a, x);
}

function gammaQcf(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Regularised incomplete beta I_x(a, b) (Numerical Recipes betacf, Lentz's method). */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}

function betacf(x: number, a: number, b: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** erf by W. J. Cody's rational approximations through erfc: about 1e-15 relative. */
export function erfc(x: number): number {
  // Numerical Recipes erfccheb (Chebyshev), accurate to ~1.2e-16.
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const COF = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17];
  let d = 0;
  let dd = 0;
  for (let j = COF.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + COF[j]!;
    dd = tmp;
  }
  const r = t * Math.exp(-z * z + 0.5 * (COF[0]! + ty * d) - dd);
  return x >= 0 ? r : 2 - r;
}

export function normalCdf(x: number, mean = 0, sdv = 1): number {
  return 0.5 * erfc(-(x - mean) / (sdv * Math.SQRT2));
}

/** The normal quantile (Acklam's algorithm, then one Halley step): full double precision. */
export function normalInv(p: number, mean = 0, sdv = 1): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  x = x - u / (1 + (x * u) / 2);
  return mean + sdv * x;
}

/** Student's t CDF with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * betaI(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student's t quantile, by bisection and Newton on tCdf. */
export function tInv(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (!Number.isFinite(df) || df > 1e6) return normalInv(p);
  let lo = -1e3;
  let hi = 1e3;
  let x = normalInv(p);
  for (let i = 0; i < 200; i++) {
    const f = tCdf(x, df) - p;
    if (Math.abs(f) < 1e-14) break;
    if (f > 0) hi = x;
    else lo = x;
    const dens = Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
    let next = x - f / dens;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - x) < 1e-13 * Math.max(1, Math.abs(x))) {
      x = next;
      break;
    }
    x = next;
  }
  return x;
}

/** Two-sided p-value of a t statistic. */
export function tPValue(t: number, df: number): number {
  return Math.min(1, 2 * (1 - tCdf(Math.abs(t), df)));
}

export function chiSquareCdf(x: number, df: number): number {
  return gammaP(df / 2, x / 2);
}

/** F CDF with (d1, d2) degrees of freedom. */
export function fCdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0;
  return betaI((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2);
}

/** A z multiplier for a two-sided interval at `level` (0.95 → 1.96). */
export function zFor(level: number): number {
  return normalInv(0.5 + Math.min(0.999, Math.max(0.5, level)) / 2);
}
