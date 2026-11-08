import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyThemeSpec, clampSpec, FLEET_THEME, loadTheme, resolveMode, ThemeStore, type ThemeStorage } from '../web/src/lib/theme.ts';
import { contrastRatio, edited, exportTheme, parseTheme, PRESETS, sameTheme, surprise } from '../web/src/lib/theme-presets.ts';

function memory(init: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}
function fakeRoot() {
  const props = new Map<string, string>();
  return { props, style: { setProperty: (n: string, v: string) => void props.set(n, v), removeProperty: (n: string) => void props.delete(n) }, dataset: {} as Record<string, string | undefined> };
}

test('the presets are Lazarette\'s ten, and each survives being read back', () => {
  assert.deepEqual(PRESETS.map((p) => p.name), ['Fleet', 'Midnight', 'Harbor', 'Ember', 'Forest', 'Graphite', 'Paper', 'Lagoon', 'Rose', 'Signal']);
  for (const p of PRESETS) assert.ok(sameTheme(clampSpec(JSON.parse(JSON.stringify(p))), p), p.name);
});

test('a theme from a file keeps only known values', () => {
  const s = clampSpec({ accent: 'red; background:url(x)', tint: '#123456', tintStrength: 99, shape: 'blob', mode: 'dark', glow: 'yes', name: 'x'.repeat(80) } as never);
  assert.equal(s.accent, '');
  assert.equal(s.tint, '#123456');
  assert.equal(s.tintStrength, 40);
  assert.equal(s.shape, 'soft');
  assert.equal(s.mode, 'dark');
  assert.equal(s.glow, false);
  assert.equal(s.name.length, 40);
});

test('a Lazarette theme file imports unchanged, and Semaphore\'s exports read the same way', () => {
  const lazarette = '{"v":1,"name":"Harbor","mode":"dark","accent":"#38bdf8","tint":"#062a3a","tintStrength":30,"shape":"soft","density":"comfortable","type":"inter","motion":"full","pattern":"waves","contrast":"normal","glow":false}';
  const imported = parseTheme(lazarette)!;
  assert.ok(sameTheme(imported, PRESETS[2]!));
  assert.ok(sameTheme(parseTheme(exportTheme(imported))!, imported));
  assert.equal(parseTheme('[1,2]'), null);
  assert.equal(parseTheme('not json'), null);
});

test('the old light or dark choice becomes the theme\'s mode once', () => {
  assert.equal(loadTheme(memory({ 'semaphore.theme': '"dark"' })).mode, 'dark');
  assert.equal(loadTheme(memory()).mode, 'system');
  assert.equal(loadTheme(memory({ 'semaphore.theme.v1': '{"mode":"light"}', 'semaphore.theme': '"dark"' })).mode, 'light');
});

test('changes are kept, tell listeners, and an edited preset becomes Custom', () => {
  const storage = memory();
  const store = new ThemeStore(storage);
  let calls = 0;
  store.subscribe(() => calls++);
  store.replace(PRESETS[1]!);
  store.replace(edited(store.get(), { glow: false }));
  assert.equal(calls, 2);
  assert.equal(store.get().name, 'Custom');
  store.replace(edited(store.get(), { shape: 'pill' }));
  assert.equal(store.get().name, 'Custom', 'a custom theme keeps its name');
  assert.equal(JSON.parse(storage.data['semaphore.theme.v1']!).glow, false);
  store.reset();
  assert.ok(sameTheme(store.get(), FLEET_THEME));
});

test('Surprise me always gives an accent that reads on its tint', () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let s = FLEET_THEME;
  for (let i = 0; i < 40; i++) {
    s = surprise(s, random);
    assert.ok(contrastRatio(s.accent, s.tint) >= 4.5, `${s.accent} on ${s.tint}`);
    assert.match(s.accent, /^#[0-9a-f]{6}$/);
    assert.ok(s.tintStrength >= 25 && s.tintStrength <= 40);
  }
});

test('applying a theme writes the Fleet tokens the skin draws from, and Fleet writes nothing', () => {
  const root = fakeRoot();
  applyThemeSpec(PRESETS[1]!, true, root);
  assert.equal(root.props.get('--fl-accent'), '#7c9cff');
  assert.equal(root.props.get('--fl-accent-ink'), '#ffffff', 'as Lazarette decides it: dark ink only on accents lighter than 0.4');
  assert.match(root.props.get('--fl-background')!, /^color-mix\(in oklab, #0b1020 40%/);
  assert.equal(root.props.get('--fl-radius-card'), '16px');
  assert.equal(root.dataset.glow, 'true');
  applyThemeSpec(FLEET_THEME, false, root);
  assert.equal(root.props.size, 0, 'the default theme leaves the skin as it is');
  assert.equal(root.dataset.pattern, 'none');
  applyThemeSpec(PRESETS[9]!, true, root);
  assert.equal(root.props.get('--fl-foreground'), '#ffffff');
  assert.equal(root.dataset.contrast, 'high');
  assert.equal(root.dataset.motion, 'calm');
});

test('system mode follows Windows', () => {
  assert.equal(resolveMode('system', true), 'dark');
  assert.equal(resolveMode('system', false), 'light');
  assert.equal(resolveMode('light', true), 'light');
});
