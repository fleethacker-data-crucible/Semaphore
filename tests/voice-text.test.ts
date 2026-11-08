// Lazarette's tests for the speech text splitter (ui-src/src/lib/voice-text.test.ts), run on Semaphore's copy.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PIECE, cleanForSpeech, takeSpeakable } from '../web/src/lib/voice-text.ts';

const expect = (actual: unknown) => ({
  toEqual: (want: unknown) => assert.deepEqual(actual, want),
  toBe: (want: unknown) => assert.equal(actual, want),
  toBeLessThanOrEqual: (want: number) => assert.ok((actual as number) <= want),
  toMatch: (want: RegExp) => assert.match(actual as string, want),
  not: { toMatch: (want: RegExp) => assert.doesNotMatch(actual as string, want), toContain: (want: string) => assert.ok(!(actual as string).includes(want)) },
  toContain: (want: string) => assert.ok((actual as string).includes(want)),
  toHaveLength: (n: number) => assert.equal((actual as unknown[]).length, n),
  toBeGreaterThan: (n: number) => assert.ok((actual as number) > n),
});

describe('takeSpeakable', () => {
  it('splits complete sentences and keeps the unfinished one', () => {
    const r = takeSpeakable('First sentence. Second one! Third? And a half');
    expect(r.pieces).toEqual(['First sentence.', 'Second one!', 'Third?']);
    expect(r.rest).toBe('And a half');
  });

  it('waits for the space after the full stop, so 3.5 and e.g. stay whole until the sentence ends', () => {
    expect(takeSpeakable('Version 3.5 is').pieces).toEqual([]);
    expect(takeSpeakable('Version 3.5 is out. ').pieces).toEqual(['Version 3.5 is out.']);
  });

  it('ends a piece at a line break and keeps closing quotes with their sentence', () => {
    const r = takeSpeakable('Say "hello." Then\nnext line');
    expect(r.pieces).toEqual(['Say "hello."', 'Then']);
    expect(r.rest).toBe('next line');
  });

  it('flushes the rest when the answer is complete', () => {
    expect(takeSpeakable('No full stop at the end', true)).toEqual({ pieces: ['No full stop at the end'], rest: '' });
  });

  it('drops pieces with nothing to say', () => {
    expect(takeSpeakable('---\n\n```\ncode\n```\n**', true).pieces).toEqual([]);
  });

  it('cuts a very long run without a sentence end at a space', () => {
    const long = 'word '.repeat(200);
    const r = takeSpeakable(long);
    expect(r.pieces.length).toBeGreaterThan(0);
    for (const p of r.pieces) expect(p.length).toBeLessThanOrEqual(MAX_PIECE);
    expect(r.rest.length).toBeLessThanOrEqual(MAX_PIECE);
  });

  it('works when text arrives a few characters at a time', () => {
    const text = 'Open Settings. Choose Assistant.\nThen save.';
    let buf = '';
    const out: string[] = [];
    for (const ch of text) {
      const r = takeSpeakable(buf + ch);
      out.push(...r.pieces);
      buf = r.rest;
    }
    out.push(...takeSpeakable(buf, true).pieces);
    expect(out).toEqual(['Open Settings.', 'Choose Assistant.', 'Then save.']);
  });
});

describe('cleanForSpeech', () => {
  it('reads the words, not the markdown or addresses', () => {
    expect(cleanForSpeech('## Steps\n- Press **Save** in [Settings](https://x.example/a).')).toBe('Steps Press Save in Settings.');
    expect(cleanForSpeech('See https://example.invalid/docs for `lazarette get`.')).toBe('See link for lazarette get.');
  });
});
