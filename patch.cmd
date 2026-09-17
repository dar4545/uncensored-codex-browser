@echo off
setlocal EnableExtensions
pushd "%~dp0"

set "MODE="
set "FINGERPRINTS="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--verify" (
  if defined MODE goto usage
  set "MODE=--verify"
) else if /I "%~1"=="--dry-run" (
  if defined MODE goto usage
  set "MODE=--dry-run"
) else if /I "%~1"=="--restore" (
  if defined MODE goto usage
  set "MODE=--restore"
) else if /I "%~1"=="--include-fingerprints" (
  set "FINGERPRINTS=--include-fingerprints"
) else if /I "%~1"=="--help" (
  goto usage_ok
) else (
  echo Unsupported launcher option: %~1
  goto usage
)
shift
goto parse_args

:args_done
set "PATCH_ARGS=%MODE% %FINGERPRINTS%"
set "AUDIT_ARGS=%FINGERPRINTS%"
set "FAILED=0"

echo ============================================================
echo  Codex desktop patches - all-in-one
echo ============================================================
echo.

echo [1/4] In-app browser bundles and browser-service config pin
node "%~dp0tools\patch-codex-browser-allow-all.mjs" %PATCH_ARGS%
if errorlevel 1 set "FAILED=1"
echo.

echo [2/4] Native Computer Use URL-policy helpers
node "%~dp0tools\patch-computer-use-url-policy.mjs" %PATCH_ARGS%
if errorlevel 1 set "FAILED=1"
echo.

echo [3/4] Computer Use skill documents
node "%~dp0tools\patch-computer-use-docs.mjs" %PATCH_ARGS%
if errorlevel 1 set "FAILED=1"
echo.

echo [4/4] Read-only Codex home/config audit
node "%~dp0tools\check-codex-home.mjs" %AUDIT_ARGS%
if errorlevel 1 set "FAILED=1"
echo.

if "%FAILED%"=="0" (
  echo OVERALL: all steps OK.
) else (
  echo OVERALL: one or more steps reported problems.
)

popd
if not defined CODEX_PATCH_NO_PAUSE if not defined npm_lifecycle_event pause
if "%FAILED%"=="0" (exit /b 0) else (exit /b 1)

:usage
echo Usage: patch.cmd [--verify ^| --dry-run ^| --restore] [--include-fingerprints]
echo Only these shared options are accepted. For per-tool options, run that Node script directly.
popd
exit /b 2

:usage_ok
echo Usage: patch.cmd [--verify ^| --dry-run ^| --restore] [--include-fingerprints]
echo Runs all three patch layers, then the read-only config audit.
popd
exit /b 0
