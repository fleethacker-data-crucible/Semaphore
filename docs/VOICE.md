# Reading a briefing aloud

"Brief me" has a **Read aloud** button. It speaks the briefing with a voice installed on this PC, through the browser's speech synthesis, and stops when you click **Stop reading**, close the panel or leave the page. Code: `src/core/voice.ts`, `web/src/components/Reports.tsx`.

- **Local voices only.** The browser lists online voices (`localService` false) that send the text to a vendor. Semaphore picks a voice only when it says it is local, preferring the page language. With none, it says so and stays silent.
- **Off until clicked.** Nothing is spoken on its own. The text is the briefing's sentences, at most 1,200 characters, cut at a whole sentence.
- **No Fairlead route yet.** The Fleet contract names TalkForge and `/v1/audio/speech` through Fairlead as the suite voice. That needs a running Fairlead and TalkForge, so it is not built here.

Tested: `tests/voice.test.ts` covers the spoken text and voice choice. The button itself was not heard on a workstation or exercised in a browser; it needs a hand check on a PC with an installed voice.
