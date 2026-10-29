@echo off
rem Semaphore: store the Fairlead client key used for AI drafting (encrypted for this Windows account).
rem   -Check   only check the stored key against Fairlead
rem   -Clear   remove the stored key (local rules draft every flag)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\Set-SemaphoreAiKey.ps1" %*
pause
