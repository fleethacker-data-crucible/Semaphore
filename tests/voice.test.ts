import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Briefing } from '../src/core/briefing.ts';
import { pickLocalVoice, speechText, SPEECH_MAX_CHARS, type VoiceLike } from '../src/core/voice.ts';

const briefing = (texts: string[]): Briefing => ({ by: 'rules', dropped: 0, sentences: texts.map((text, i) => ({ text, flagId: `f${i}` })) });

test('a briefing is spoken as full sentences in order', () => {
  assert.equal(speechText(briefing(['Gulf stands out: $3.24M against a typical $1.9M.', 'Labor cost rose 8%', '  Two flags  need\nreview '])), 'Gulf stands out: $3.24M against a typical $1.9M. Labor cost rose 8%. Two flags need review.');
});

test('empty sentences are skipped and an empty briefing is silent', () => {
  assert.equal(speechText(briefing(['', '   '])), '');
  assert.equal(speechText(briefing([])), '');
});

test('the spoken text is capped at whole sentences', () => {
  const long = 'x'.repeat(500) + '.';
  const text = speechText(briefing([long, long, long, long]));
  assert.ok(text.length <= SPEECH_MAX_CHARS);
  assert.equal(text, `${long} ${long}`);
});

const voices: VoiceLike[] = [
  { name: 'Cloud English', lang: 'en-US', localService: false },
  { name: 'Local German', lang: 'de-DE', localService: true },
  { name: 'Local English UK', lang: 'en-GB', localService: true },
  { name: 'Local English US', lang: 'en-US', localService: true },
];

test('only a local voice is ever chosen, and the page language wins', () => {
  assert.equal(pickLocalVoice(voices, 'en-US')!.name, 'Local English US');
  assert.equal(pickLocalVoice(voices, 'en-AU')!.name, 'Local English UK');
  assert.equal(pickLocalVoice(voices, 'fr-FR')!.name, 'Local German');
});

test('with no local voice nothing is chosen, even when cloud voices exist', () => {
  assert.equal(pickLocalVoice([{ name: 'Cloud English', lang: 'en-US', localService: false }], 'en-US'), null);
  assert.equal(pickLocalVoice([], 'en-US'), null);
});

test('a voice that does not state localService true is treated as not local', () => {
  assert.equal(pickLocalVoice([{ name: 'Unknown', lang: 'en-US' } as unknown as VoiceLike], 'en-US'), null);
});
