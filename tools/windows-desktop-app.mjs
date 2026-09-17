import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PACKAGE_NAME = 'OpenAI.Codex';
const DISPLAY_NAME = 'ChatGPT';

function architectureName(value) {
  const names = { 0: 'x86', 5: 'ARM', 9: 'x64', 11: 'neutral', 12: 'ARM64', 14: 'x86-on-ARM64' };
  return names[Number(value)] ?? String(value ?? 'unknown');
}

/**
 * Verify the exact Windows desktop app this project supports.
 *
 * Get-AppxPackage is part of Windows and returns the current user's Store package.
 * Paths stay internal: callers print only the package/display names and pass any error
 * through their own path-masking helper.
 */
export function inspectWindowsDesktopApp() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'platform', detail: 'Windows is required.' };
  }

  const command = [
    `$p = Get-AppxPackage -Name '${PACKAGE_NAME}' | Select-Object -First 1`,
    `if ($null -eq $p) { exit 3 }`,
    `$p | Select-Object Name,Version,Architecture,PackageFamilyName,InstallLocation | ConvertTo-Json -Compress`,
  ].join('; ');

  let raw;
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    }).trim();
  } catch (error) {
    const status = Number(error?.status);
    return {
      ok: false,
      reason: status === 3 ? 'not-installed' : 'package-query-failed',
      detail: status === 3
        ? `Microsoft Store package ${PACKAGE_NAME} is not installed for the current Windows user.`
        : `Could not query the Microsoft Store package (${error?.message ?? 'unknown error'}).`,
    };
  }

  let data;
  try { data = JSON.parse(raw); }
  catch { return { ok: false, reason: 'bad-package-output', detail: 'The Store package query returned unreadable data.' }; }

  if (data?.Name !== PACKAGE_NAME || typeof data?.InstallLocation !== 'string' || !data.InstallLocation) {
    return { ok: false, reason: 'wrong-package', detail: `Expected Microsoft Store package ${PACKAGE_NAME}.` };
  }

  const executable = path.join(data.InstallLocation, 'app', 'ChatGPT.exe');
  const manifest = path.join(data.InstallLocation, 'AppxManifest.xml');
  const resources = path.join(data.InstallLocation, 'app', 'resources');
  if (!fs.existsSync(executable) || !fs.existsSync(manifest)) {
    return {
      ok: false,
      reason: 'unexpected-layout',
      detail: `The ${PACKAGE_NAME} package was found, but app\\${DISPLAY_NAME}.exe or AppxManifest.xml is missing.`,
    };
  }

  const architecture = architectureName(data.Architecture);
  if (architecture !== 'x64') {
    return {
      ok: false,
      reason: 'unsupported-architecture',
      detail: `This release supports the x64 Store package; the installed package reports ${architecture}.`,
    };
  }

  let manifestText;
  try { manifestText = fs.readFileSync(manifest, 'utf8'); }
  catch (error) {
    return { ok: false, reason: 'manifest-unreadable', detail: `Could not read AppxManifest.xml (${error.message}).` };
  }

  const desktopTarget = /TargetDeviceFamily\s+Name="Windows\.Desktop"/i.test(manifestText);
  const fullTrustExe = /<Application\b[^>]*\bExecutable="app[\\/]ChatGPT\.exe"[^>]*\bEntryPoint="Windows\.FullTrustApplication"/i.test(manifestText);
  const visualElement = manifestText.match(/<uap:VisualElements\b[^>]*>/i)?.[0] ?? '';
  const chatGptDisplayName = /\bDisplayName="ChatGPT"/i.test(visualElement);
  if (!desktopTarget || !fullTrustExe || !chatGptDisplayName) {
    return {
      ok: false,
      reason: 'unsupported-manifest',
      detail: `The ${PACKAGE_NAME} manifest no longer describes the expected Windows.Desktop full-trust ${DISPLAY_NAME} app.`,
    };
  }

  return {
    ok: true,
    packageName: PACKAGE_NAME,
    displayName: DISPLAY_NAME,
    version: String(data.Version ?? ''),
    architecture,
    packageFamilyName: String(data.PackageFamilyName ?? ''),
    installLocation: data.InstallLocation,
    executable,
    resources,
  };
}

export function storeTargetLabel(app) {
  return app?.ok
    ? `Microsoft Store “${DISPLAY_NAME}” (${PACKAGE_NAME}, ${app.architecture || 'architecture unknown'})`
    : `Microsoft Store “${DISPLAY_NAME}” (${PACKAGE_NAME})`;
}
