@echo off
rem Semaphore: starts the local server (127.0.0.1, ports 8800-8802) and opens the browser.
rem   --console      keep this console window (questions are asked here)
rem   --replace      if Semaphore is already running, stop it and start fresh
rem   --stay         keep running after the browser tab closes (or SEMAPHORE_AUTO_STOP=0)
rem   --no-browser   do not open a browser; print the session link
rem   -Port n        use exactly port n
rem Stop every running copy with server\Stop-Semaphore.ps1.
setlocal
set "SEM_CONSOLE="
for %%A in (%*) do if /I "%%~A"=="--console" set "SEM_CONSOLE=1"
if defined SEM_CONSOLE (
  powershell.exe -STA -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\Start-Semaphore.ps1" %*
) else (
  start "" powershell.exe -STA -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0server\Start-Semaphore.ps1" %*
)
endlocal
