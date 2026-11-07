import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEATURE_LIST, featureState, withPersonal } from '../web/src/lib/features.ts';
import { SOCIAL_DEFAULTS } from '../web/src/lib/playbook.ts';

// Exitable: a person can switch a feature off for themselves, and a deployment's "off" always wins.

test('everything stays on when nobody turned anything off', () => {
  assert.deepEqual(withPersonal(SOCIAL_DEFAULTS, {}), SOCIAL_DEFAULTS);
});

test('a person can turn one feature off and leave the rest', () => {
  const s = withPersonal(SOCIAL_DEFAULTS, { impact: false });
  assert.equal(s.impact, false);
  assert.equal(s.signalBook, true);
});

test('a person cannot turn on what the deployment turned off', () => {
  const s = withPersonal({ ...SOCIAL_DEFAULTS, bz: false }, { bz: true });
  assert.equal(s.bz, false);
  assert.deepEqual(featureState({ ...SOCIAL_DEFAULTS, bz: false }, { bz: true }, 'bz'), { on: false, locked: true });
});

test('a stored value that is not false never turns a feature off', () => {
  const stored = { impact: 'no', teamLog: 0 } as unknown as Parameters<typeof withPersonal>[1];
  assert.deepEqual(withPersonal(SOCIAL_DEFAULTS, stored), SOCIAL_DEFAULTS);
});

test('every feature has a plain-English line, and none of them threatens a loss', () => {
  assert.deepEqual(FEATURE_LIST.map((f) => f.key).sort(), Object.keys(SOCIAL_DEFAULTS).sort());
  for (const f of FEATURE_LIST) {
    assert.ok(f.label.length > 0 && f.detail.length > 0);
    assert.doesNotMatch(`${f.label} ${f.detail}`, /\b(lose|lost|miss out|streak|don.t)\b/i);
  }
});
