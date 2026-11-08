// Speech-to-text worker for voice input, as in Lazarette (ui-src/src/workers/stt.worker.ts, PR 142):
// Whisper tiny.en through transformers.js, entirely in this browser tab. The library, the model and
// the ONNX runtime come from the server's fixed /stt/ paths (TalkForge's assets folder, read-only);
// nothing is bundled from npm. Remote model hosts are switched off, so a missing file is an error,
// never a download. Audio arrives as 16 kHz mono Float32 samples and never leaves the tab.
//
// Built as its own module bundle (web/build.mjs, assets/stt.<hash>.js) and started only when voice
// input is first used. This file alone is served with 'wasm-unsafe-eval' (server/Http.ps1), which the
// ONNX runtime needs to compile WebAssembly.

interface Asr {
  (audio: Float32Array): Promise<{ text?: string } | { text?: string }[]>;
}
interface TransformersLib {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string; useBrowserCache: boolean; backends: { onnx: { wasm: { wasmPaths: string; numThreads: number } } } };
  pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<Asr>;
}

let asr: Asr | null = null;
let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  const url = '/stt/transformers.min.js'; // served by the Semaphore server at run time, not bundled
  const lib = (await import(/* webpackIgnore: true */ url)) as TransformersLib;
  lib.env.allowRemoteModels = false;
  lib.env.allowLocalModels = true;
  lib.env.localModelPath = '/stt/models/';
  lib.env.useBrowserCache = false;
  lib.env.backends.onnx.wasm.wasmPaths = '/stt/onnx/';
  lib.env.backends.onnx.wasm.numThreads = 1; // no SharedArrayBuffer here (no cross-origin isolation), and no extra workers
  asr = await lib.pipeline('automatic-speech-recognition', 'whisper-tiny.en', { dtype: 'q8', device: 'wasm' });
}

// The page tsconfig has the DOM library, not the WebWorker one: the two members used here, typed.
const scope = self as unknown as { onmessage: ((e: MessageEvent<{ type: string; id?: number; audio?: Float32Array }>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      loading ??= load();
      await loading;
      scope.postMessage({ type: 'ready', id: m.id, text: '' });
    } else if (m.type === 'transcribe') {
      loading ??= load();
      await loading;
      const out = await asr!(m.audio!);
      const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '');
      scope.postMessage({ type: 'text', id: m.id, text: text.trim() });
    }
  } catch (err) {
    loading = null;
    scope.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
