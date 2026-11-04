# Environment check

Double-click **`Check-Environment.bat`** on a workstation to find out what that machine allows. It tests the things the Fleet local web apps depend on, writes a log, and prints one verdict per known failure. It needs only Windows PowerShell 5.1, no admin rights and no installs, and nothing leaves the computer. It also works on its own: copy just these two files anywhere.

Use it to compare two kinds of machine (for example NMCI against Nautilus): run it on each, then diff the two logs.

## What it tests

| Verdict | The failure it explains | What is checked |
| --- | --- | --- |
| `ZIP-EXTRACT` | A downloaded zip "has nothing in it" or will not extract | A zip made here is read by .NET `ZipFile`, `Expand-Archive`, Explorer's own extraction (`Shell.Application`) and `tar.exe`; `Compress-Archive`; a gzip + Base64 + SHA-256 round trip (the fallback package format); and every `Semaphore*.zip` in Downloads or Desktop (or `-ZipPath`) is classified as a real zip, a **tar file named .zip**, truncated, or empty |
| `LAUNCH` | A launcher does nothing or fails | `.bat` and `.ps1` run, execution policy, language mode (ConstrainedLanguage), C# `Add-Type`, WinForms tray icon, Credential Manager, DPAPI, AppLocker and code-integrity policy, Mark of the Web, write access |
| `NOT-BUILT` | "The browser interface has not been built" | `web\dist` and its assets are present; a **real** Semaphore copy is started on a spare loopback port exactly as a double-click would start it, its page and JS bundle are fetched, then it is stopped |
| `PORTS` | Semaphore does not start or its page is unreachable | `TcpListener` on `127.0.0.1` ports 8800 to 8802; HTTP to loopback by raw socket, with no proxy and with the system proxy |
| `BLANK-PAGE` | The page opens but is blank or unstyled | Edge or Chrome opens a page served from `127.0.0.1` that tries what the UI needs: modern JS, dynamic `import()`, Web Worker (blob and file), WebAssembly, IndexedDB, Web Crypto (SHA-256, AES-GCM), canvas, SVG, and the modern CSS Tailwind 4 relies on |

## Run it

```
Check-Environment.bat
Check-Environment.bat -NoBrowser            skip the browser tests
Check-Environment.bat -NoLaunch             serve the page but open the printed address yourself
Check-Environment.bat -NoSemaphoreRun       do not start a real Semaphore copy
Check-Environment.bat -ZipPath C:\path\Semaphore-0.3.0.zip
```

If PowerShell cannot run the script at all, the window shows the execution policy and language mode it sees; send a photo of it.

## The log

Each run writes `logs\env-check-<COMPUTERNAME>-<date>-<time>.log` next to the script (or `%TEMP%\FleetEnvCheck` if that folder is read-only). It is written line by line, so a partial log survives an interruption. Lines look like `[FAIL] zip.expand-archive | message`; `PASS`, `FAIL`, `WARN`, `INFO` and `ERROR` are the statuses. The end of the log holds the `verdict.*` lines.

The log holds the machine name, domain name, OS build, browser versions and policy settings. Your user name is replaced by `<user>` and non-ASCII characters by `?`.

## Compare two machines

```
Check-Environment.bat -Compare nmci.log nautilus.log
```

Prints only the keys whose status or value differ. Keys starting `run.` (times and paths) are ignored.

## Safety

It writes only to its `logs` folder and a temporary folder it deletes. The only network use is to `127.0.0.1`. The browser page is served on a random port under a random token and refuses any other host name. It does not read passwords, tokens or files outside its own folder, except the registry values listed in the log and the names of `Semaphore*.zip` files in Downloads and Desktop.
