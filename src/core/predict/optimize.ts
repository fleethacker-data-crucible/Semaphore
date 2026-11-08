// Nelder–Mead simplex minimisation, for fitting smoothing constants, ARIMA coefficients and Weibull
// parameters. Derivative-free and robust on the few-parameter problems the models pose. Callers map
// bounded parameters through a transform (a logistic for 0..1, exp for positive values).

export interface MinimizeResult {
  x: number[];
  fx: number;
  iterations: number;
  converged: boolean;
}

export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { step?: number | number[]; maxIter?: number; tol?: number } = {}): MinimizeResult {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 200 * n;
  const tol = opts.tol ?? 1e-10;
  const steps = Array.isArray(opts.step) ? opts.step : new Array<number>(n).fill(opts.step ?? 0.1);
  const safe = (x: number[]) => {
    const v = f(x);
    return Number.isFinite(v) ? v : Number.MAX_VALUE;
  };
  let simplex: Array<{ x: number[]; fx: number }> = [{ x: [...x0], fx: safe(x0) }];
  for (let i = 0; i < n; i++) {
    const x = [...x0];
    x[i]! += steps[i] || 0.1;
    simplex.push({ x, fx: safe(x) });
  }
  let it = 0;
  let converged = false;
  for (; it < maxIter; it++) {
    simplex.sort((a, b) => a.fx - b.fx);
    const best = simplex[0]!;
    const worst = simplex[n]!;
    if (Math.abs(worst.fx - best.fx) <= tol * (Math.abs(best.fx) + tol)) {
      converged = true;
      break;
    }
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j]! += simplex[i]!.x[j]! / n;
    const at = (t: number) => centroid.map((c, j) => c + t * (worst.x[j]! - c));
    const xr = at(-1);
    const fr = safe(xr);
    if (fr < best.fx) {
      const xe = at(-2);
      const fe = safe(xe);
      simplex[n] = fe < fr ? { x: xe, fx: fe } : { x: xr, fx: fr };
    } else if (fr < simplex[n - 1]!.fx) {
      simplex[n] = { x: xr, fx: fr };
    } else {
      const outside = fr < worst.fx;
      const xc = at(outside ? -0.5 : 0.5);
      const fc = safe(xc);
      if (fc < (outside ? fr : worst.fx)) simplex[n] = { x: xc, fx: fc };
      else {
        simplex = simplex.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => best.x[j]! + 0.5 * (v - best.x[j]!)), fx: 0 }));
        for (let i = 1; i <= n; i++) simplex[i]!.fx = safe(simplex[i]!.x);
      }
    }
  }
  simplex.sort((a, b) => a.fx - b.fx);
  return { x: simplex[0]!.x, fx: simplex[0]!.fx, iterations: it, converged };
}

/** Maps any real to (lo, hi) and back: optimise unbounded, use bounded. */
export const toUnit = (z: number, lo = 0, hi = 1) => lo + (hi - lo) / (1 + Math.exp(-z));
export const fromUnit = (v: number, lo = 0, hi = 1) => {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, (v - lo) / (hi - lo)));
  return Math.log(u / (1 - u));
};
