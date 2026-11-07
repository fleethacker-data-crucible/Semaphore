import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { AppBoundary } from './components/ErrorBoundary.tsx';
import { reportClientError } from './lib/api.ts';

// Client errors leave one line in the server's log (lib/api.ts reportClientError: no data values).
const view = () => new URL(location.href).searchParams.get('view') ?? 'builder';
const report = (level: 'error' | 'warn', e: unknown) => {
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'Unknown error');
  reportClientError({ level, message: `${err.name}: ${err.message}`, ...(err.stack ? { stack: err.stack } : {}), view: view() });
};
window.addEventListener('error', (e) => report('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('warn', e.reason));

createRoot(document.getElementById('root')!, {
  // Caught by an error boundary (a panel's card, or the page's): logged, the page carries on.
  onCaughtError: (e) => report('error', e),
  // Nothing caught it: logged, and React shows nothing; AppBoundary makes this rare.
  onUncaughtError: (e) => report('error', e),
}).render(
  <StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </StrictMode>,
);
