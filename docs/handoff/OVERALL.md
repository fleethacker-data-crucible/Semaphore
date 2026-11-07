# Semaphore handoff (2026-11-07)

For the session that continues this work on the owner's Windows workstation, with full access.
Start with `docs/handoff/LOCAL-VERIFICATION.md`: nothing in PowerShell on this branch has run yet.

## Context

- **What Semaphore is.** An analyst dashboard workbench: a Windows PowerShell 5.1 loopback server, a React 19 UI, and shared playbook JSON files. It is part of the "Fleet" suite in `fleethacker-data-crucible`, alongside Lazarette (the vault), Fairlead (the AI and intelligence router), Halyard and others.
- **Target machine.** A locked-down Navy Windows 11 workstation:
  - standard user, Windows PowerShell 5.1 only;
  - no node, git or installs;
  - WDAC blocks EXEs and DLLs from user folders, but `Add-Type` compiling C# from source works;
  - PowerShell transcription is ON, so never print a secret;
  - DPAPI works; Credential Manager works through P/Invoke, not COM;
  - offline, loopback only.

  The captured profile is `docker-test-profile.json` in `sun-of-anton/tool-audit`, which also holds the Nautilus twin (a Docker-based workstation clone) and Drydock (a job sandbox).
- **Secrets design (owner's decision).**
  - AI provider keys live in **Lazarette**, are shared only with **Fairlead**, and Fairlead issues Semaphore an `fl-…` client token (Credential Manager `Fairlead/Semaphore`). Semaphore never holds a provider key.
  - Database, AWS and Foundry secrets come from Lazarette's **tool loopback route** (Lazarette `docs/TOOLS.md`).
- **Repo rules (`AGENTS.md`).**
  - No compatibility aliases.
  - Find Lazarette only by the rule in Lazarette's docs.
  - Commit only as the configured identity, with no Co-Authored-By or tool names in commits or PRs.
  - PowerShell 5.1 syntax.
- **UX rules.** `docs/UNIFIED-UI.md` (Fleet UI), plus the engagement ethics in `sun-of-anton/engagement-framework` → `README.md`: honest, aligned, private by default, can be switched off, minimal data. No leaderboards, no loss-framed streaks, no push notifications.

## What the branch `ccr-e62db918-x89h3m` contains (35 commits ahead of main, no PR yet)

| Area | Issues | Summary |
|---|---|---|
| Session security | (review finding) | Launch links carry a single-use, 10-minute launch code that the page trades for the token at `POST /api/launch`. The token no longer appears in browser command lines or transcripts. |
| Session UX | #87 | Separate screens for no-server, offline (with Try again), ended, stopped and link-used. End session asks first and saves first. |
| Save safety | #88, #84 | ETag/If-Match/409 with Load theirs / Save mine as a copy / Overwrite. Writes are atomic. Changes from another tab are detected. Pending saves are sent, not dropped. Storage failures are reported. |
| Errors | #89, #69 | Friendly error messages, per-panel error boundaries, a local client-error log (`/api/client-log`). Error toasts stay until dismissed. A "Why it didn't draft" card. Undo after deleting a flag. |
| Limits | #91 | A shared `LIMITS` table, a 2 MB check before saving, guards against running the same action twice. |
| Keyboard/IA | #77 | Ctrl+K palette, `?` help with a phrasebook, a six-control header, focusable flags with Enter/A/F/D. |
| Learning | #67, #68, #70 | First-run "shakedown", brief hints and a word-teaching path, an honest accept moment with Undo. |
| Motivation | #71–#76 | Empty states, the leadership loop with "BZ: this helped", a "This week" tab, impact counts, a weekly watch log, the Signal Book. Each can be switched off in `config/settings.json`. |
| Accessibility | #79 | Statuses as icon plus word, hatched rule bars, a colour-blind skin, reduced-motion handling, 32 px targets, Show as table, keyboard cross-filtering. |
| Data | #81, #82, #83 | Quote-aware CSV parsing with no silent loss. Blob storage read in the worker (peak memory 557 → 224 MB on 1M rows). Result cache TTL/LRU. Cards recompute only for relevant selections. |
| Performance | #78 | ESM code splitting with lazy panels, immutable caching for hashed assets, a size budget (`npm run size`). |
| Credentials | #63, #64, #65 | Lazarette tool loopback route (`semaphore vault pair`), with one share per role. The Fairlead token goes only to the PID that owns port 8776. A Credential Manager read falls back to the DPAPI file. |
| Headers | #90 | worker-src, COOP and Permissions-Policy. Inline style is allowed only for ECharts tooltip attributes. A build contract rejects inline script. |
| SQL fixes | (review) | Cleaned columns bind once per `?`. Spark gets `LIMIT`. "Today" is the local calendar day. Unapplied blank/boolean selections are flagged. |
| Tests | #86 | Playwright e2e against `tests/e2e/mock-server.mjs`, with an Edge job in CI. |
| Release | #66, #56 | Includes PR #59's `build/Build-Semaphore.ps1`, plus `build/Test-SemaphoreZip.ps1` and `.github/workflows/release.yml`. The "not built" page points to the prebuilt zip. |

`CHANGELOG.md` → Unreleased describes every change.

## Order of work

1. **Run `docs/handoff/LOCAL-VERIFICATION.md`** in full: parse check, Pester, e2e in Edge, hand checks against the real server, release zip, Nautilus twin. Fix failures on the branch.
2. **Open the PR** from `ccr-e62db918-x89h3m` to `main` when green.
   - The body lists the issues it resolves: #56, #63–#84 except #82 (partial) and #85, and #86–#91.
   - Note that PR #59 (packaging) is included and can be closed when this PR merges.
   - PR #58 (test procedure doc) is separate.
3. **Finish the partial items** (small):
   - #85: `web/src/app.tsx` is still about 1,440 lines; continue extracting hooks (`useCsvFiles`, `usePlaybookEffects`, `useReports`) toward under 400.
   - #82: a progress display while a large CSV is read.
   - #81: Data → Clean should offer "numbers kept as text" for columns where conversion failed (`src/core/quality.ts`).
   - #72: the weekly impact line on the welcome page (`Welcome.tsx`).
   - #75: a "Flag for review" path from the leadership Ask view.
   - #70: "See it as leadership will" as a second toast action (the toast API supports only one today).
   - #86: e2e scenarios for the oversized-save message and a reviewed Ask answer.
   - #63: a pairing control under Data → Sources (pairing is CLI-only today).
   - Opening the example page fires "Leadership can now ask for Work orders and 4 more". It is noisy on a first run; suppress it for the example hoist or the first open.
   - `docs/CLI.md`: list `client-log` among the browser-only routes.
4. **Cross-repo follow-ups:**
   - Lazarette `docs/FLEET-ITEMS.md`: Semaphore now uses "shares named per source in sources.json".
   - Port registry: Lazarette 8765 collides with `lasso` 8765–8766, which needs a decision in the comms repo. `FleetPorts.psd1` lists `fairlead` 8776 (policy guessed as `reuse`).
   - Fairlead#72: provider keys from Lazarette only, with no Fairlead-stored copies.
   - ECharts `tooltip.renderMode: 'richText'` would let CSP drop `style-src-attr 'unsafe-inline'`.
5. **Issue hygiene.** After merge, close the resolved issues with `state_reason: completed`. Keep #28 open as the umbrella and update its checklist.

## Where things are

- **Server:**
  - `server/Http.ps1`: transport, gate, launch codes, headers.
  - `server/Routes.ps1`: documents, ETag, client log.
  - `server/Vault.ps1` and `server/Lazarette.Client.ps1`: secrets.
  - `server/Intelligence.ps1`: Fairlead and PID binding.
- **UI shell:**
  - `web/src/app.tsx`;
  - `web/src/hooks/` (useSession, usePersistence, useShortcuts, useCommands, useBusy, useFlagKeys);
  - `web/src/lib/` (api, session, toasts, accept, onboarding, skills, flag-keys, relevance, storage, data);
  - `web/src/components/` (Header, SessionScreen, ConflictBar, CommandPalette, HelpDialog, Shakedown, SignalBook, EmptyState, ErrorBoundary, DraftMiss, LazyPanels).
- **Core:** `src/core/` (csv, cleaning, sql, impact, playbook, hoist LIMITS).
- **Tests:**
  - `tests/*.test.ts` (node --test);
  - `tests/server/*.Tests.ps1` (Pester);
  - `tests/e2e/` (Playwright plus the mock server).
- **Build:** `web/build.mjs` (ESM split, picks the `main.tsx` entry), `web/build-contract.mjs`, `web/size.mjs`, `build/`.

## Commands

```powershell
npm ci; npm run typecheck; npm test; npm run build; npm run size
$env:SEMAPHORE_E2E_BROWSER_CHANNEL='msedge'; npm run e2e
powershell -NoProfile -Command "Import-Module Pester -RequiredVersion 5.7.1; Invoke-Pester tests\server -Output Detailed"
.\Launch-Semaphore.bat            # --console, --no-browser, --replace, --stay, --ask, -Port n
.\Semaphore-CLI.bat commands --json
```

## Separate track (not Semaphore)

The owner wants an **ethical engagement framework**: a research synthesis of the psychology methods,
then a TypeScript library (mastery, open difficulty adjustment, spacing, goals, feedback, impact,
rhythm, recognition, and guardrails that enforce the five tests), later a C# port for games, with
Semaphore as the first adopter. It lives in the private repo `sun-of-anton/engagement-framework`; its `README.md` holds the
teardowns, the evidence table and the framework plan. Research APIs (OpenAlex,
Semantic Scholar, arXiv, Crossref) were blocked in the cloud session; locally they should be
reachable.
