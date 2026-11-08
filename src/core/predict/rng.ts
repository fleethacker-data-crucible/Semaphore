// Repeatable random numbers. Every model that draws at random takes a seed, so the same flag on the
// same data gives the same P50 every time it is opened, and a test can pin an answer.
//
// sfc32 (Chris Doty-Humphrey's small fast counting generator) seeded through splitmix32: fast in
// JavaScript's 32-bit integer maths, passes PractRand to 2^40 bytes, and needs no dependency.

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: number) {
    let s = seed >>> 0 || 0x9e3779b9;
    const split = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = split();
    this.b = split();
    this.c = split();
    this.d = split();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform on [0, 1), with 53 bits. */
  next(): number {
    const hi = this.nextU32() >>> 5;
    const lo = this.nextU32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** Uniform on (0, 1): never exactly 0, for logs. */
  open(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    return u;
  }

  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal (Marsaglia's polar method). */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const z = this.spare;
      this.spare = null;
      return mean + sd * z;
    }
    let u: number, v: number, s: number;
    do {
      u = 2 * this.next() - 1;
      v = 2 * this.next() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return mean + sd * u * m;
  }

  /** Gamma(shape, 1) by Marsaglia and Tsang; shape below 1 uses the boost u^(1/shape). */
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.open(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.open();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }

  /** Triangular on [low, high] with its peak at `mode` (inverse CDF). */
  triangular(low: number, mode: number, high: number): number {
    if (high <= low) return low;
    const u = this.next();
    const f = (mode - low) / (high - low);
    return u < f ? low + Math.sqrt(u * (high - low) * (mode - low)) : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
  }

  /** PERT: a beta on [low, high] with mean (low + 4·mode + high) / 6 (λ = 4). */
  pert(low: number, mode: number, high: number): number {
    if (high <= low) return low;
    const a = 1 + (4 * (mode - low)) / (high - low);
    const b = 1 + (4 * (high - mode)) / (high - low);
    return low + (high - low) * this.beta(a, b);
  }

  /** Poisson(λ): Knuth's product method for small λ, the PTRS transformed rejection above 30. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = this.next();
      while (p > limit) {
        k++;
        p *= this.next();
      }
      return k;
    }
    // Hörmann (1993), PTRS.
    const slam = Math.sqrt(lambda);
    const loglam = Math.log(lambda);
    const b = 0.931 + 2.53 * slam;
    const a = -0.059 + 0.02483 * b;
    const invalpha = 1.1239 + 1.1328 / (b - 3.4);
    const vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const u = this.next() - 0.5;
      const v = this.next();
      const us = 0.5 - Math.abs(u);
      const k = Math.floor(((2 * a) / us + b) * u + lambda + 0.43);
      if (us >= 0.07 && v <= vr) return k;
      if (k < 0 || (us < 0.013 && v > us)) continue;
      if (Math.log(v) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -lambda + k * loglam - lnFactorial(k)) return k;
    }
  }

  /** Fisher–Yates shuffle in place. */
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = xs[i]!;
      xs[i] = xs[j]!;
      xs[j] = t;
    }
    return xs;
  }
}

function lnFactorial(k: number): number {
  if (k < 2) return 0;
  // Stirling with two correction terms: exact to ~1e-10 from k = 10, and k here is above 30·0.5.
  return k * Math.log(k) - k + 0.5 * Math.log(2 * Math.PI * k) + 1 / (12 * k) - 1 / (360 * k * k * k);
}

/** A draw from a named distribution over [low, high] peaking at `likely`. */
export function draw(rng: Rng, dist: 'triangular' | 'pert' | 'normal' | 'uniform' | 'lognormal', low: number, likely: number, high: number): number {
  switch (dist) {
    case 'uniform':
      return rng.uniform(low, high);
    case 'pert':
      return rng.pert(low, likely, high);
    case 'normal': {
      // low and high as the 5th and 95th percentiles around `likely`.
      const sd = (high - low) / (2 * 1.6448536269514722);
      return rng.normal(likely, sd);
    }
    case 'lognormal': {
      // Positive values only: likely is the median, high the 95th percentile.
      if (likely <= 0 || high <= likely) return rng.triangular(low, likely, high);
      const mu = Math.log(likely);
      const sigma = (Math.log(high) - mu) / 1.6448536269514722;
      return Math.exp(rng.normal(mu, sigma));
    }
    default:
      return rng.triangular(low, likely, high);
  }
}
