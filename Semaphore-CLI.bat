@echo off
rem Semaphore from the command line: Semaphore-CLI.bat commands, or <noun> <verb> [--json] [--out file] [--yes] [--dry-run].
rem Works on the Semaphore folder directly; no running Semaphore is needed. See docs\CLI.md.
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\Invoke-SemaphoreCli.ps1" %*
exit /b %ERRORLEVEL%
