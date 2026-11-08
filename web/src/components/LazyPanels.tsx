// The panels the page opens on demand (#78), loaded when first opened so the welcome page and the
// builder parse less up front. With the build's ESM splitting each becomes its own chunk; with a
// single bundle the import() is inlined and they simply load at once. Wrap each in <Panel> (from
// ErrorBoundary.tsx) for the skeleton and the error card.

import { lazy } from 'react';

export const DataPanel = lazy(() => import('./DataPanel.tsx').then((m) => ({ default: m.DataPanel })));
export const QlikImport = lazy(() => import('./QlikImport.tsx').then((m) => ({ default: m.QlikImport })));
export const SqlDesk = lazy(() => import('./SqlDesk.tsx').then((m) => ({ default: m.SqlDesk })));
export const KitsPanel = lazy(() => import('./KitsPanel.tsx').then((m) => ({ default: m.KitsPanel })));
export const LineageView = lazy(() => import('./LineageView.tsx').then((m) => ({ default: m.LineageView })));
export const ShareDialog = lazy(() => import('./ShareDialog.tsx').then((m) => ({ default: m.ShareDialog })));
export const DesignDialog = lazy(() => import('./DesignDialog.tsx').then((m) => ({ default: m.DesignDialog })));
export const StylePanel = lazy(() => import('./StylePanel.tsx').then((m) => ({ default: m.StylePanel })));
export const SignalBook = lazy(() => import('./SignalBook.tsx').then((m) => ({ default: m.SignalBook })));
export const HelpDialog = lazy(() => import('./HelpDialog.tsx').then((m) => ({ default: m.HelpDialog })));
export const AssistantRoot = lazy(() => import('./AssistantRoot.tsx').then((m) => ({ default: m.AssistantRoot })));
export const CommandPalette = lazy(() => import('./CommandPalette.tsx').then((m) => ({ default: m.CommandPalette })));
export const OpenHoistDialog = lazy(() => import('./OpenHoistDialog.tsx').then((m) => ({ default: m.OpenHoistDialog })));
export const PlaybookPanel = lazy(() => import('./PlaybookPanel.tsx').then((m) => ({ default: m.PlaybookPanel })));
export const SettingsDialog = lazy(() => import('./SettingsDialog.tsx').then((m) => ({ default: m.SettingsDialog })));
export const AskView = lazy(() => import('./AskView.tsx').then((m) => ({ default: m.AskView })));
