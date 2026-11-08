// Copied from Lazarette ui-src/src/lib/voice-text.ts (PR 140). Turns streamed answer text into pieces for TalkForge, one sentence (or line) at a time, so speech
// can start while the answer is still arriving. Pure functions: no DOM, no network.

/** Longest piece sent in one request; longer runs without a sentence end are cut at a space. */
export const MAX_PIECE = 400;

/** Markdown and link noise read out loud is useless: keep the words. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')                 // code blocks
    .replace(/`([^`]*)`/g, '$1')                      // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')        // [text](url) and images
    .replace(/https?:\/\/\S+/g, 'link')               // bare addresses
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '') // headings and list markers
    .replace(/[*_~>|]+/g, ' ')                        // emphasis, quotes, table bars
    .replace(/\s+/g, ' ')
    .trim();
}

const speakable = (s: string) => /[\p{L}\p{N}]/u.test(s);

/**
 * Splits off every complete piece at the front of `buffer`. A piece ends at . ! ? (with any closing
 * quote or bracket) followed by white space, or at a line break. With `final`, whatever is left is a
 * piece too. Pieces are cleaned for speech; pieces with no letters or digits are dropped.
 */
export function takeSpeakable(buffer: string, final = false): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  // Code blocks are skipped whole: a finished one is dropped, an unfinished one waits (and is
  // dropped at the end) so its lines are never read out one by one.
  let rest = buffer.replace(/```[\s\S]*?```/g, ' ');
  const open = rest.indexOf('```');
  const held = open >= 0 ? rest.slice(open) : '';
  if (open >= 0) rest = rest.slice(0, open);
  const push = (raw: string) => {
    const clean = cleanForSpeech(raw);
    if (speakable(clean)) pieces.push(clean);
  };
  for (;;) {
    const m = /[.!?]+["')\]]*\s|\n/.exec(rest);
    if (m && m.index + m[0].length <= MAX_PIECE) {
      push(rest.slice(0, m.index + m[0].length));
      rest = rest.slice(m.index + m[0].length);
      continue;
    }
    if (rest.length > MAX_PIECE) {
      const space = rest.lastIndexOf(' ', MAX_PIECE);
      const cut = space > MAX_PIECE / 2 ? space + 1 : MAX_PIECE;
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    break;
  }
  if (final) {
    push(rest);
    return { pieces, rest: '' };
  }
  return { pieces, rest: rest + held };
}
