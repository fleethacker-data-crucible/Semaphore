# Reading a briefing aloud

"Brief me" has a **Read aloud** button. It speaks the briefing with a voice installed on this PC, through the browser's speech synthesis, and stops when you click **Stop reading**, close the panel or leave the page. Code: `src/core/voice.ts`, `web/src/components/Reports.tsx`.

- **Local voices only.** The browser lists online voices (`localService` false) that send the text to a vendor. Semaphore picks a voice only when it says it is local, preferring the page language. With none, it says so and stays silent.
- **Off until clicked.** Nothing is spoken on its own. The text is the briefing's sentences, at most 1,200 characters, cut at a whole sentence.
- **No Fairlead route yet.** The Fleet contract names TalkForge and `/v1/audio/speech` through Fairlead as the suite voice. That needs a running Fairlead and TalkForge, so it is not built here.

Tested: `tests/voice.test.ts` covers the spoken text and voice choice. The button itself was not heard on a workstation or exercised in a browser; it needs a hand check on a PC with an installed voice.

# Spoken answers and voice input (TalkForge)

The assistant can read its answers aloud and listen to you, as Lazarette's does (Lazarette PRs 140, 141, 142 and 144). Both use TalkForge, the Fleet's offline speech tool, from its folder on this computer. Code: `server/Intelligence.ps1` (speech relay, starting TalkForge, voice list), `server/Http.ps1` (the `/stt/` files and headers), `server/Common.ps1` (settings), `web/src/lib/voice.ts`, `web/src/lib/dictation.ts`, `web/src/stt-worker.ts`, `web/src/components/VoiceCard.tsx`, `web/src/components/AssistantRoot.tsx`.

## Setting it up

| Where | What | Default |
| --- | --- | --- |
| `SEMAPHORE_VOICE_URL` (environment or `config\semaphore.env`) | TalkForge's address: `http://127.0.0.1:<port>` or `http://[::1]:<port>` only | `http://127.0.0.1:25009` |
| `TALKFORGE_TOKEN` shared from Lazarette, or `SEMAPHORE_VOICE_TOKEN` | The token TalkForge runs with: any random text of 16 or more characters (docs/VAULT.md) | none |
| `config\settings.json` `voice.autoStart` | Start TalkForge when speech is needed and nothing answers on the address | `true` |
| `voice.folder`, or `SEMAPHORE_VOICE_FOLDER` (which wins) | The TalkForge folder: a full path holding `tools\talkforge.mjs` | a `TalkForge` folder next to the Semaphore folder, else `%USERPROFILE%\Projects\TalkForge` |
| `voice.input` | The deployment switch for voice input; `false` blocks the microphone for Semaphore | `true` |

```json
{ "voice": { "autoStart": true, "folder": "C:\\Users\\you\\Projects\\TalkForge", "input": true } }
```

`voice.input` is read when Semaphore starts; the rest when it is used. Settings > AI drafting shows each of them (never the token) and has the person's own choices, kept in this browser: **Voice** (a list of the voices installed in TalkForge), **Speed**, **Test voice**, and under **Voice input**, **Talk with the microphone** and **Send when I stop talking**.

## Starting TalkForge when it is needed

You do not have to run `talkforge serve`. When the page needs speech (an answer to read, **Test voice**, turning the speaker on, or clicking the orb with the speaker on) it asks `GET /api/voice/status`. When nothing answers it asks `POST /api/voice/start`, says *Getting the voice ready* in the panel, in **Test voice** and on the orb, and polls until TalkForge answers (up to 45 s). A sentence that came back `voice-offline` is tried once more after that.

- **Reuse, never a second copy.** Before starting, the server asks the address's `/__fleethacker/heartbeat` (TalkForge's lifecycle probe, no token). A TalkForge that answers, one Lazarette started or one in a terminal, is used as it is. Starts are serialised, and while one is starting (45 s) no other begins. If another program holds the port, Semaphore says so and starts nothing.
- **The token is never on a command line.** Process creation auditing and PowerShell transcription record command lines on the workstations. The child is `node.exe "<folder>\tools\talkforge.mjs" serve --port <port> --idle-timeout 30` in a hidden window, with the token only in its `TALKFORGE_TOKEN` environment variable; `SEMAPHORE_VOICE_TOKEN`, `SEMAPHORE_AI_KEY`, `TALKFORGE_TOKEN_FILE` and `TALKFORGE_LAZARETTE_ITEM` are removed from its environment. The token is read (from Lazarette or the environment) on a worker and never logged.
- **Stopping.** TalkForge stops by itself after 30 minutes without speech. When Semaphore stops it ends the TalkForge it started, and only that one; a TalkForge it reused keeps running.
- **Node.js** is found as Lazarette finds it: `node.exe` on `PATH`. TalkForge needs Node.js 18 or newer; without it the panel says so.
- **What the panel can say**: auto start off, the folder not found (or not a full path), node missing, a token shorter than 16 characters or not shared, an address not of the form `http://127.0.0.1:<port>`, another program on the port, *did not start in time* or *stopped while starting* (run `talkforge serve` in a terminal to see why).

## The voice list

`GET /api/voice/voices` reads `<TalkForge>\assets\models`: each `<id>.onnx` with its `<id>.onnx.json` is a voice (TalkForge need not run). TalkForge's default (`DEFAULT_VOICE` in `tools\node-engine.mjs`) comes first, and each is marked by quality: medium and low start speaking much sooner than high. Piper's configs have keys that differ only by case, which Windows PowerShell 5.1's `ConvertFrom-Json` refuses, so only the shown fields (quality, speakers, dataset, language) are read out of the text.

## Voice input

Click the orb, or the microphone next to **Send**, and speak. The words appear in the message box while you talk and are sent after about 1.5 s of quiet (or wait for **Send** when **Send when I stop talking** is off). Click again while it listens to stop without sending; with **Talk to the orb** set to press and hold, hold while you talk and let go to send. Closing the panel stops listening. The orb now starts left of the panel, so it can be clicked again while the panel is open.

- **Where the audio goes: nowhere.** Whisper tiny.en runs in a module Web Worker (`assets/stt.<hash>.js`, started the first time you talk) through transformers.js. No request carries audio. The microphone is opened only while listening and closed the moment listening ends.
- **No npm package.** transformers.js, the ONNX runtime and the model are TalkForge's files, served read-only at fixed paths: `/stt/transformers.min.js`, nine `/stt/models/whisper-tiny.en/...` files and `/stt/onnx/ort-wasm-simd-threaded.jsep.{mjs,wasm}` (from `assets\vendor\onnx`). The name must be one of these exactly; nothing else under TalkForge can be read and no path is built from the request. They need no session token (a worker fetches them) but pass the same Host and Origin gate, and answer `404` while voice input is off. `GET /api/voice/dictation/status` says which are missing; install them with `populate-assets.ps1 -Only 'stt/*'` in the TalkForge folder.
- **Headers.** `Permissions-Policy` carries `microphone=(self)` while `voice.input` is on and `microphone=()` otherwise; the custom widget frame always has `microphone=()`. The page's Content-Security-Policy is unchanged. The Whisper worker's script alone is sent with the same policy plus `'wasm-unsafe-eval'` in `script-src`, which a dedicated worker needs to compile the ONNX runtime's WebAssembly; it does not allow JavaScript `eval`. `connect-src 'self'` and `worker-src 'self'` already cover the files and the worker.
- The first time, the browser asks whether Semaphore may use the microphone.

Tested: `tests/server/TalkForge.Tests.ps1` (finding the folder, reuse, the start with the token in the environment only, auto start off, folder missing, node missing, another program on the port, the voice list with case-duplicate keys, the `/stt/` files and traversal, the headers), `tests/dictation-audio.test.ts` and `tests/assistant.test.ts` (the audio helpers, the voice list labels, getting ready), and `tests/e2e/voice.spec.ts` against the mock (getting ready, Test voice, the voice list, voice input with a fake microphone, voice input off).
