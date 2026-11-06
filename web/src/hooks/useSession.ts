// The page's one session (lib/session.ts), wired to lib/api.ts: every api() call reports a network
// failure, a 401 or an answer to it, and the heartbeat reports each beat.

import { useEffect, useSyncExternalStore } from 'react';
import { cameWithLaunchCode, configureApi, endSession, probe, sessionToken, startHeartbeat, startSession } from '../lib/api.ts';
import { createSession, type SessionSnapshot } from '../lib/session.ts';

// The launch code leaves the address bar as soon as the page runs (lib/api.ts startSession).
void startSession();

const session = createSession({
  probe: () => probe(),
  startHeartbeat: (onResult) => startHeartbeat(onResult),
  end: () => endSession(),
  isFile: () => location.protocol === 'file:',
  hadLaunchCode: cameWithLaunchCode,
  hadToken: () => !!sessionToken(),
  now: () => Date.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id as number),
});

configureApi({ onNetwork: session.networkFailed, onSession: session.sessionRefused, onSuccess: session.serverAnswered });

let booted = false;

export interface UseSession extends SessionSnapshot {
  retry: () => void;
  /** End session: flush, stop the heartbeat, tell the server. */
  end: (flush: () => Promise<void>) => Promise<void>;
}

export function useSession(): UseSession {
  const snap = useSyncExternalStore(session.subscribe, session.get, session.get);
  useEffect(() => {
    if (!booted) {
      booted = true;
      void session.boot();
    }
    const onVisibility = () => session.visibility(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  return { ...snap, retry: () => void session.retry(), end: session.end };
}
