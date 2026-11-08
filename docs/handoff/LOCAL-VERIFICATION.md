# Local verification: what has not run yet

Branch: `ccr-e62db918-x89h3m` (fleethacker-data-crucible/Semaphore). Written 2026-11-07.

The branch was built in a Linux container **without PowerShell and without Edge**. Everything
in TypeScript was run there:
- `npm run typecheck`: pass
- `npm test`: 382 pass
- `npm run build`: pass, including the build contract
- `npm run size`: under budget
- `npm run e2e` in Chromium against the Node mock: 11/11 pass

**Nothing written in PowerShell has ever been executed.** It was only proofread for Windows
PowerShell 5.1. Run the steps below on the Windows workstation, fix what fails, and keep each fix
small. Read `AGENTS.md` first: Windows PowerShell 5.1 syntax, no compatibility aliases, commit only
as the configured git identity, and no Co-Authored-By lines or tool names in commits or PR text.

## 0. Get the branch

```powershell
git fetch origin ccr-e62db918-x89h3m
git checkout ccr-e62db918-x89h3m
npm ci
npm run build
```

## 1. Parse check (fast; do first)

Every `.ps1`, `.psm1` and `.psd1` under `server\`, `tests\` and `build\` must parse under Windows
PowerShell 5.1. This is the same check CI runs.

```powershell
powershell -NoProfile -Command "$bad=@(); foreach($f in Get-ChildItem server,tests,build -Recurse -Include *.ps1,*.psm1,*.psd1){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e); foreach($x in @($e)){$bad+=('{0}:{1} {2}' -f $f.FullName,$x.Extent.StartLineNumber,$x.Message)}}; $bad; if($bad.Count){exit 1}"
```

Also check that the server scripts are ASCII-only, because the self-check refuses anything else:
`powershell -NoProfile -File server\Start-Semaphore.ps1 -CheckOnly`

## 2. Pester (Windows PowerShell 5.1, Pester 5.7.1, as in `.github/workflows/ci.yml`)

```powershell
powershell -NoProfile -Command "Import-Module Pester -RequiredVersion 5.7.1 -Force; $c=New-PesterConfiguration; $c.Run.Path='tests/server'; $c.Run.PassThru=$true; $c.Output.Verbosity='Detailed'; $r=Invoke-Pester -Configuration $c; foreach($t in $r.Failed){'FAILED: '+$t.ExpandedPath}"
```

Test files new or changed on this branch, in order of risk:

| File | Covers | Risk |
|---|---|---|
| `tests/server/Vault.Tests.ps1` | Lazarette tool loopback route (#63, #64): fake Lazarette on loopback, HMAC proof, AES-CBC+HMAC sealed answer, DPAPI pairing, role mapping, every error state | **High**: about 530 changed lines, with crypto, a socket listener and DPAPI |
| `tests/server/Intelligence.Tests.ps1` | Fairlead PID binding (#65): `GetExtendedTcpTable` via Add-Type, mocks, one real Windows lookup; Credential Manager fallback to the DPAPI file | **High**: Add-Type and P/Invoke |
| `tests/server/Security.Tests.ps1` | Launch codes and `/api/launch`, the not-built page, ETag/If-Match/409, atomic writes, `/api/client-log`, CSP and headers, immutable asset caching | Medium |
| `tests/server/Release.Tests.ps1` | `build\Test-SemaphoreZip.ps1` smoke test | Medium |
| `tests/server/Social.Tests.ps1` | Social settings switches reaching `/api/info` | Low |
| `tests/server/Lifecycle.Tests.ps1`, `Scripts.Tests.ps1`, `Commands.Tests.ps1`, `Connectors.Tests.ps1` | 90 s heartbeat; FleetPorts adds `fairlead` 8776; CLI parity (`/api/launch`, `/api/client-log`, `vault pair/unpair`); new vault form in sources | Low |

PowerShell files changed on this branch, if a failure points at product code:
- `server\`: Commands.ps1, Common.ps1, Connectors.ps1, FleetPorts.psd1, Http.ps1, Intelligence.ps1, Lake.ps1, **Lazarette.Client.ps1 (new, copied from Lazarette)**, Query.ps1, Routes.ps1, Set-SemaphoreAiKey.ps1, Start-Semaphore.ps1, Vault.ps1.
- `build\`: Build-Semaphore.ps1, Test-SemaphoreZip.ps1 (new).

Likely trouble spots:
- 5.1-only syntax slips: `??`, `?.`, ternaries, `&&`/`||`, `-AsHashtable`.
- `[IO.File]::Replace` on a missing destination.
- `Add-Type` type names reused across test files in one Pester run.
- Hashtable key case-insensitivity.
- Loopback listener ports already in use.
- `Get-Date` UTC comparisons.

## 3. End-to-end in Edge (mock server)

```powershell
$env:SEMAPHORE_E2E_BROWSER_CHANNEL = 'msedge'
npm run e2e
```

These 11 specs passed in Chromium. Edge should behave the same; failures are most likely timing.
The lifecycle tests stop a server and wait 2-8 s.

## 4. The real server, by hand (about 10 minutes)

Run `Launch-Semaphore.bat` from the checkout after `npm run build`, then check:

1. The browser opens. The address bar shows `?launch=...` briefly, then it disappears. The example page loads.
2. Paste the same launch link into a new window. Expected: **"This launch link has already been used"**.
3. Run `Launch-Semaphore.bat --no-browser --console`. The console prints a link "works once, for 10 minutes". **Check the PowerShell transcript file: it must not contain the session token.** It contains only the launch code, which is spent once used.
4. Edit the hoist title, then within 1 s use Hoist ▾ → Open a saved hoist → another one. Then check `%USERPROFILE%\Semaphore\hoists\` (or `SEMAPHORE_HOME`): the first hoist's file holds the edit.
5. Open two tabs on the same hoist (Ctrl+K → Open, or a second launch link). Edit in both. The second save shows the conflict bar (Load theirs / Save mine as a copy / Overwrite).
6. Settings (gear icon, or the Settings button on the welcome page) → End session → confirm. The "Semaphore has stopped" screen appears, and the process has exited.
7. Switch to another app for 10 minutes and come back. The server must still be running (90 s heartbeat timeout plus background-tab beats, #80).
8. AI: with Fairlead running and a key installed for Semaphore, the AI button shows Fairlead. Stop Fairlead, then start some other program on 8776 (any loopback listener). Expected: "Something other than Fairlead is answering on port 8776; the key was not sent."
9. Vault (needs Lazarette main, which has Settings → Tools, Lazarette #93):
   - In Lazarette, Settings → Tools → Pair tool. Then run `Semaphore-CLI.bat vault pair` and paste the code (it is not echoed).
   - Share an item as `SMDATS_PASSWORD` (and `SMDATS_USER`).
   - Add a source with `"vault": { "password": "SMDATS_PASSWORD", "user": "SMDATS_USER" }` (see docs/VAULT.md) and run a flag.
   - Lock Lazarette, then run it again: the flag says "locked".

## 5. Release zip and the Nautilus twin

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build\Build-Semaphore.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build\Test-SemaphoreZip.ps1 -ZipPath dist\Semaphore-0.4.0.zip
```

Then use the Nautilus twin (from `sun-of-anton/tool-audit`, `nautilus-twin.zip`). This needs Docker
Desktop in Windows-containers mode.

```powershell
.\Start-NautilusTwin.ps1 -Verify
.\Start-NautilusTwin.ps1 -ToolFolder <extracted Semaphore folder> -Launcher Launch-Semaphore.bat -Port 8800
```

Open `http://127.0.0.1:8800` in Edge on the host using the printed launch link. The twin runs as a
standard user with Software Restriction rules, so this catches any binary, DLL load or admin
assumption.

Optionally run the release workflow by hand: Actions → release → Run workflow. It replaces assets of
the same name on an existing release.

## 6. Report back

For each step: passed, or failed with the first error and the fix you made (file:line). Push fixes to
`ccr-e62db918-x89h3m`. When all of steps 1-5 pass, the branch is ready for a PR.
