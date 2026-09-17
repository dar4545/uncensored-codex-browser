@echo off
setlocal
rem Convenience wrapper: URL-policy request falsification, not a local always-allow result.
node "%~dp0patch-computer-use-url-policy.mjs" %*
set "RESULT=%ERRORLEVEL%"
if not defined CODEX_PATCH_NO_PAUSE if not defined npm_lifecycle_event pause
exit /b %RESULT%
