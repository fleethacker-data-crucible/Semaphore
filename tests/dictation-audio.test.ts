// Voice input's pure audio helpers (web/src/lib/dictation-audio.ts), as Lazarette tests them (PR 142),
// and the Voice list labels (web/src/lib/talkforge-voices.ts, PR 144).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTranscript, createUtterance, downsample, joinDraft, rms } from '../web/src/lib/dictation-audio.ts';
import { voiceOptions } from '../web/src/lib/talkforge-voices.ts';

const tone = (n: number, amp: number) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 3));
const quiet = (n: number) => new Float32Array(n);

test('downsample turns 48 kHz into 16 kHz by averaging, and copies when the rate matches', () => {
  assert.deepEqual(Array.from(downsample(Float32Array.from([1, 1, 1, 0, 0, 0]), 48000)), [1, 0]);
  const a = Float32Array.from([0.1, 0.2]);
  const b = downsample(a, 16000);
  assert.deepEqual(Array.from(b), Array.from(a));
  assert.notEqual(b, a);
});

test('an utterance waits for speech, then ends after 1.5 s of quiet', () => {
  const u = createUtterance();
  assert.equal(u.push(quiet(4096)), 'waiting');
  assert.equal(u.push(tone(8000, 0.2)), 'speaking');
  assert.equal(u.heard, true);
  assert.equal(u.push(quiet(16000)), 'speaking');
  assert.equal(u.push(quiet(8000)), 'done');
  assert.equal(u.audio().length, 8000 + 24000);
});

test('a click is not speech, and nothing records past the limit', () => {
  const u = createUtterance();
  u.push(tone(800, 0.2));
  assert.equal(u.heard, false);
  assert.equal(u.push(quiet(30000)), 'speaking');
  assert.equal(createUtterance({ maxMs: 1000 }).push(tone(16000, 0.2)), 'done');
});

test('rms measures loudness; Whisper silence markers are dropped; typed words come first', () => {
  assert.equal(rms(quiet(10)), 0);
  assert.ok(Math.abs(rms(Float32Array.from([0.5, -0.5])) - 0.5) < 1e-9);
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(music) Open   Settings. '), 'Open Settings.');
  assert.equal(joinDraft('  Show me', 'last year'), 'Show me last year');
  assert.equal(joinDraft('', 'last year'), 'last year');
  assert.equal(joinDraft('typed', ''), 'typed');
});

test('the Voice list puts the TalkForge default first and marks which voices start quickly', () => {
  const list = {
    found: true,
    default: 'en_US-libritts-high',
    message: '',
    voices: [
      { id: 'en_US-libritts-high', quality: 'high', speakers: 904, dataset: 'libritts', language: 'English, United States', default: true },
      { id: 'en_US-amy-low', quality: 'low', speakers: 1, dataset: 'amy', language: '', default: false },
      { id: 'odd', quality: '', speakers: 1, dataset: '', language: '', default: false },
    ],
  };
  assert.deepEqual(
    voiceOptions(list, '').map((o) => o.label),
    ['TalkForge default (en_US-libritts-high)', 'en_US-libritts-high (high quality, slower to start, 904 speakers)', 'en_US-amy-low (low quality, starts quickly)', 'odd'],
  );
  assert.deepEqual(voiceOptions(null, 'gone-voice').at(-1), { value: 'gone-voice', label: 'gone-voice (not installed)' });
  assert.deepEqual(voiceOptions(null, ''), [{ value: '', label: 'TalkForge default' }]);
});
