import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// UNIFIED-UI section 7: text passes WCAG AA (4.5:1) in every skin and theme. The tokens are read
// from web/src/styles.css (and the Fleet tokens they point at from web/vendor/fleet/fleet.css):
// ink, ink-2 and ink-3 as text, and accent as link or label text, on the page, the card and the
// sidebar. Tokens mixed with color-mix() are skipped: they cannot be resolved without a browser.

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8'));
const fleet = strip(readFileSync(new URL('../web/vendor/fleet/fleet.css', import.meta.url), 'utf8'));

type Vars = Record<string, string>;

/**
 * Every `--name: value;` declaration inside the innermost blocks whose selector (whitespace
 * collapsed) matches `selector`. A block nested in @media is found by its own selector.
 */
function block(text: string, selector: RegExp): Vars {
  const out: Vars = {};
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // The text before a block may also hold @import lines (styles.css): the selector is what follows the last ';'.
    const sel = m[1]!.split(';').pop()!.replace(/\s+/g, ' ').trim();
    if (!selector.test(sel)) continue;
    for (const d of m[2]!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  }
  return out;
}

/** Fleet's tokens for a theme: fleet.css declares dark on `:root, :root[data-theme='dark']` and light under data-theme='light'. */
function fleetVars(theme: 'light' | 'dark'): Vars {
  const dark = block(fleet, /^:root(, ?:root\[data-theme=['"]dark['"]\])?$/);
  if (theme === 'dark') return dark;
  return { ...dark, ...block(fleet, /^:root\[data-theme=['"]light['"]\]$/) };
}

/** Semaphore's tokens for one skin and theme, layered the way the cascade layers them. */
function skinVars(skin: 'fleet' | 'classic' | 'safe', theme: 'light' | 'dark'): Vars {
  let vars: Vars = { ...fleetVars(theme), ...block(css, /^:root$/) };
  if (theme === 'dark') vars = { ...vars, ...block(css, /^:root\[data-theme=['"]dark['"]\]$/) };
  if (skin !== 'fleet') {
    vars = { ...vars, ...block(css, new RegExp(`^:root\\[data-skin=['"]${skin}['"]\\]$`)) };
    if (theme === 'dark') vars = { ...vars, ...block(css, new RegExp(`^:root\\[data-skin=['"]${skin}['"]\\]\\[data-theme=['"]dark['"]\\]$`)) };
  }
  return vars;
}

/** A token's hex colour after following var() references, or null when it is mixed or not a plain colour. */
function resolve(vars: Vars, name: string, depth = 0): string | null {
  const v = vars[name];
  if (!v || depth > 10) return null;
  if (v.includes('color-mix')) return null;
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref) return resolve(vars, ref[1]!, depth + 1);
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

const TEXT = ['ink', 'ink-2', 'ink-3', 'accent'];
const SURFACES = ['bg', 'panel', 'panel-2'];

test('contrast: the formula agrees with the known pairs', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.ok(Math.abs(contrast('#132633', '#fbfaf2') - 14.8) < 0.3, 'Fleet body text, documented as 14.8:1');
});

for (const skin of ['fleet', 'classic', 'safe'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`skin ${skin}, ${theme}: text tokens are AA (4.5:1) on every surface`, () => {
      const vars = skinVars(skin, theme);
      let checked = 0;
      const failures: string[] = [];
      for (const t of TEXT) {
        const fg = resolve(vars, t);
        if (!fg) continue;
        for (const s of SURFACES) {
          const bg = resolve(vars, s);
          if (!bg) continue;
          checked++;
          const ratio = contrast(fg, bg);
          if (ratio < 4.5) failures.push(`--${t} ${fg} on --${s} ${bg}: ${ratio.toFixed(2)}:1`);
        }
      }
      assert.ok(checked >= 9, `resolved ${checked} pairs; the tokens should resolve to plain colours`);
      assert.deepEqual(failures, []);
    });
  }
}
