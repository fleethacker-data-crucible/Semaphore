@echo off
rem Semaphore for leadership: opens the question view (ask, get answers, see what changed).
rem Same options as Launch-Semaphore.bat.
call "%~dp0Launch-Semaphore.bat" --ask %*
