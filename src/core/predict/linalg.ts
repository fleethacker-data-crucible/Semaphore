// Small dense linear algebra for the models: least squares by Householder QR (stable where the
// normal equations are not), the inverse of R'R for standard errors, and a Gauss–Jordan solve.
// Matrices are arrays of rows; sizes here are a few dozen columns at most.

export type Matrix = number[][];

export function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function identity(n: number): Matrix {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i]![i] = 1;
  return m;
}

export function transpose(a: Matrix): Matrix {
  const r = a.length;
  const c = a[0]?.length ?? 0;
  const t = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) t[j]![i] = a[i]![j]!;
  return t;
}

export function matmul(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const k = b.length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const oi = out[i]!;
    for (let p = 0; p < k; p++) {
      const v = ai[p]!;
      if (v === 0) continue;
      const bp = b[p]!;
      for (let j = 0; j < m; j++) oi[j]! += v * bp[j]!;
    }
  }
  return out;
}

export function matvec(a: Matrix, x: ArrayLike<number>): number[] {
  return a.map((row) => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j]! * x[j]!;
    return s;
  });
}

/** Solves A x = b by Gauss–Jordan with partial pivoting. Returns null when A is singular. */
export function solve(a: Matrix, b: number[]): number[] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    const p = m[col]![col]!;
    for (let j = col; j <= n; j++) m[col]![j]! /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) m[r]![j]! -= f * m[col]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

/** The inverse by Gauss–Jordan, or null when singular. */
export function inverse(a: Matrix): Matrix | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...identity(n)[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    const p = m[col]![col]!;
    for (let j = 0; j < 2 * n; j++) m[col]![j]! /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[col]![j]!;
    }
  }
  return m.map((row) => row.slice(n));
}

export interface LeastSquares {
  /** Coefficients, one per column of X. */
  beta: number[];
  /** (X'X)^-1, for standard errors: se_j = sqrt(sigma² · xtxInv[j][j]). */
  xtxInv: Matrix;
  fitted: number[];
  residuals: number[];
  /** Residual sum of squares. */
  rss: number;
  /** Numerical rank; below the column count means a column is a combination of others. */
  rank: number;
}

/**
 * Least squares X β ≈ y by Householder QR, with optional row weights (weighted least squares).
 * Throws when X has fewer rows than columns or is rank-deficient.
 */
export function leastSquares(x: Matrix, y: ArrayLike<number>, weights?: ArrayLike<number>): LeastSquares {
  const n = x.length;
  const p = x[0]?.length ?? 0;
  if (n < p) throw new Error('Fewer rows than unknowns.');
  const sw = weights ? Array.from({ length: n }, (_, i) => Math.sqrt(Math.max(0, weights[i]!))) : null;
  const a = x.map((row, i) => row.map((v) => (sw ? v * sw[i]! : v)));
  const b = Array.from({ length: n }, (_, i) => (sw ? y[i]! * sw[i]! : y[i]!));
  const rdiag = new Array<number>(p).fill(0);
  let rank = 0;
  const scale = Math.max(1e-300, ...a.flat().map(Math.abs));
  for (let k = 0; k < p; k++) {
    let norm = 0;
    for (let i = k; i < n; i++) norm = Math.hypot(norm, a[i]![k]!);
    if (norm <= 1e-11 * scale) {
      rdiag[k] = 0;
      continue;
    }
    rank++;
    if (a[k]![k]! < 0) norm = -norm;
    for (let i = k; i < n; i++) a[i]![k]! /= norm;
    a[k]![k]! += 1;
    for (let j = k + 1; j < p; j++) {
      let s = 0;
      for (let i = k; i < n; i++) s += a[i]![k]! * a[i]![j]!;
      s = -s / a[k]![k]!;
      for (let i = k; i < n; i++) a[i]![j]! += s * a[i]![k]!;
    }
    let s = 0;
    for (let i = k; i < n; i++) s += a[i]![k]! * b[i]!;
    s = -s / a[k]![k]!;
    for (let i = k; i < n; i++) b[i]! += s * a[i]![k]!;
    rdiag[k] = -norm;
  }
  if (rank < p) throw new Error('The columns are not independent.');
  // Back-substitute R β = Qᵀb.
  const beta = new Array<number>(p).fill(0);
  for (let k = p - 1; k >= 0; k--) {
    let s = b[k]!;
    for (let j = k + 1; j < p; j++) s -= a[k]![j]! * beta[j]!;
    beta[k] = s / rdiag[k]!;
  }
  // (X'X)^-1 = R^-1 R^-T.
  const rinv = zeros(p, p);
  for (let j = 0; j < p; j++) {
    rinv[j]![j] = 1 / rdiag[j]!;
    for (let i = j - 1; i >= 0; i--) {
      let s = 0;
      for (let k = i + 1; k <= j; k++) s += a[i]![k]! * rinv[k]![j]!;
      rinv[i]![j] = -s / rdiag[i]!;
    }
  }
  const xtxInv = matmul(rinv, transpose(rinv));
  const fitted = x.map((row) => row.reduce((s, v, j) => s + v * beta[j]!, 0));
  const residuals = fitted.map((f, i) => y[i]! - f);
  const rss = residuals.reduce((s, r, i) => s + (weights ? weights[i]! : 1) * r * r, 0);
  return { beta, xtxInv, fitted, residuals, rss, rank };
}
