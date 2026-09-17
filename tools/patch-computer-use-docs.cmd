@echo off
setlocal
rem Convenience wrapper: user-authority patch for the Computer Use skill docs.
rem Patch/restore runs append to ..\records\docs-patch-report.json (see --report to change it).
node "%~dp0patch-computer-use-docs.mjs" %*
set "RESULT=%ERRORLEVEL%"
if not defined CODEX_PATCH_NO_PAUSE if not defined npm_lifecycle_event pause
exit /b %RESULT%
