@echo off
rem Fleet environment check: double-click. Needs only Windows PowerShell 5.1. No admin, no installs, nothing leaves this computer.
rem It opens Edge or Chrome on a page served from 127.0.0.1 for the browser tests (add -NoBrowser to skip that),
rem then writes a log to the logs folder next to this file.
rem   -NoBrowser        skip the browser tests
rem   -NoSemaphoreRun   do not start a real Semaphore copy
rem   -ZipPath <file>   also check that zip file
rem   -Compare a.log b.log   show only the differences between two logs (no tests run)
setlocal
powershell.exe -STA -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Check-Environment.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo PowerShell could not run the check ^(exit code %RC%^). What this computer allows:
  powershell.exe -NoLogo -NoProfile -Command "Get-ExecutionPolicy -List | Format-Table -AutoSize; 'LanguageMode: ' + $ExecutionContext.SessionState.LanguageMode; 'PowerShell: ' + $PSVersionTable.PSVersion"
  echo Send a photo or screenshot of this window.
)
echo.
pause
endlocal
