#!/usr/bin/env node
/**
 * patch-codex-browser-allow-all.mjs
 *
 * Lets the Codex desktop in-app browser open ANY http(s) domain by patching the
 * domain-restriction gateways inside the `@oai/browser-desktop` service bundle
 * (scripts/browser-service.mjs) so that every domain-level decision returns the
 * "allowed" verdict.
 *
 * It auto-detects every current copy of the bundle used by Codex:
 *   - %LOCALAPPDATA%\OpenAI\Codex\runtimes\<family>\<hash>\...\@oai\browser-desktop\scripts\browser-service.mjs
 *   - %LOCALAPPDATA%\OpenAI\Codex\runtimes\...\@oai\cua\...\skill\scripts\browser-service.mjs
 *   - %USERPROFILE%\.codex\plugins\cache\openai-bundled\<plugin>\<version>\scripts\browser-service.mjs
 *   - %USERPROFILE%\.codex\.tmp\bundled-marketplaces\...\scripts\browser-service.mjs   (staging copies)
 * and cross-checks the path pinned in .codex\config.toml (NODE_REPL_TRUSTED_SERVICES)
 * plus any live process running from a runtime hash directory.
 *
 * Patch points (each insertion is tagged with a greppable comment):
 *   1. site-status  : fetchBlocked()            -> always "not blocked"; the
 *                     remote /aura/site_status check is no longer consulted.
 *   2. origin-policy: getOriginPolicyDecision() -> always null ("no policy
 *                     opinion" = allowed). Single gateway for network-policy
 *                     (deniedDomains / allowlist-only / disabled) and per-origin
 *                     browser_use origin policy (access / uploads / downloads /
 *                     raw CDP denials).
 *   3. host-callback: the two `await this.runtime.assertBrowserUrlAllowed?.(url)`
 *                     call sites are neutralized (void 0).
 *   4. config pin  : .codex\config.toml `NODE_REPL_TRUSTED_SERVICES.browser` — the
 *                     path Codex writes from a hardcoded plugin name (`browser`,
 *                     the control-in-app-browser plugin). If that dir no longer
 *                     exists in the plugin cache (plugin renamed/merged, e.g. to
 *                     `chrome`), the best existing copy is resolved dynamically
 *                     and the pin is rewritten surgically. --restore puts the
 *                     backed-up value back.
 *
 * Usage:
 *   node patch-codex-browser-allow-all.mjs              patch every detected copy
 *   node patch-codex-browser-allow-all.mjs --dry-run    show what would change
 *   node patch-codex-browser-allow-all.mjs --verify     report patch state only
 *   node patch-codex-browser-allow-all.mjs --restore    restore pristine backups + config pin
 *   node patch-codex-browser-allow-all.mjs --file <p>   patch one specific file
 *   node patch-codex-browser-allow-all.mjs --no-process-scan
 *   node patch-codex-browser-allow-all.mjs --include-fingerprints
 *
 * Requires Node >= 18. Restart Codex after patching; re-run after Codex updates.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectWindowsDesktopApp, storeTargetLabel } from './windows-desktop-app.mjs';

// ---------------------------------------------------------------------------
// Privacy: shorten personal paths before anything is printed or recorded.
// ---------------------------------------------------------------------------
// Output from these tools gets pasted into chats, issues and reports. Replace known
// Windows roots first, then hide any drive letter or UNC server/share that remains.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const maskRules = [
  [process.env.CODEX_HOME, '$CODEX_HOME'],
  [process.env.LOCALAPPDATA, '%LOCALAPPDATA%'],
  [process.env.APPDATA, '%APPDATA%'],
  [process.env.ProgramW6432, '%PROGRAMFILES%'],
  [process.env.ProgramFiles, '%PROGRAMFILES%'],
  [process.env['ProgramFiles(x86)'], '%PROGRAMFILES(X86)%'],
  [process.env.SystemRoot, '%SYSTEMROOT%'],
  [process.env.TEMP, '%TEMP%'],
  [process.env.TMP, '%TEMP%'],
  [os.homedir(), '~'],
]
  .filter(([p]) => Boolean(p))
  .sort((a, b) => String(b[0]).length - String(a[0]).length);
const mask = (value) => {
  let text = String(value);
  for (const [p, label] of maskRules) {
    text = text.replace(new RegExp(escapeRegex(p), 'gi'), label);
    text = text.replace(new RegExp(escapeRegex(String(p).replace(/\\/g, '/')), 'gi'), label);
  }
  // Hide volatile install identifiers without losing the useful part of the path.
  text = text.replace(/(%PROGRAMFILES%[\\/]WindowsApps[\\/]OpenAI\.Codex_)[^\\/\s"']+/gi,
    '$1<version>_<architecture>__<publisher-id>');
  text = text.replace(/(%LOCALAPPDATA%[\\/]OpenAI[\\/]Codex[\\/]runtimes[\\/][^\\/\s"']+[\\/])[^\\/\s"']+/gi,
    '$1<runtime-id>');
  text = text.replace(/(%LOCALAPPDATA%[\\/]OpenAI[\\/]Codex[\\/]bin[\\/])[0-9a-f]{6,}/gi,
    '$1<build-id>');
  text = text.replace(/(~[\\/]\.codex[\\/]plugins[\\/]cache[\\/][^\\/\s"']+[\\/][^\\/\s"']+[\\/])[^\\/\s"']+/gi,
    '$1<version>');
  text = text.replace(/(config\.toml\.bak-)[A-Za-z0-9._-]+/gi, '$1<backup>');
  text = text.replace(/%TEMP%[\\/][^\s"'`),;]+/gi, '%TEMP%/<temporary-item>');
  // Unknown absolute paths may contain spaces and custom folder names. Once an
  // unrecognised root appears, hide the rest of that line/string rather than leaking a suffix.
  text = text.replace(/\\\\[^\r\n]+/g, '<unc>');
  text = text.replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '<external-path>');
  text = text.replace(/(^|[\s"'`(=])\/(?!\/)[^\r\n]*/gm, '$1<external-path>');
  text = text.replace(/(\.codex-allowall\.old)-\d{10,}/g, '$1-<run-id>');
  return text;
};
const show = (p) => mask(String(p)).replace(/\\/g, '/');
const out = (s = '') => console.log(mask(String(s)));
const err = (s = '') => console.error(mask(String(s)));
const maskDeep = (v) => (typeof v === 'string' ? mask(v)
  : Array.isArray(v) ? v.map(maskDeep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]))
      : v);

const MARKER = 'codex-allowall-patch';
const BACKUP_SUFFIX = '.codex-allowall.bak';
const PRE_RESTORE_SUFFIX = '.codex-allowall.patched';
const BUNDLE_MIN_BYTES = 200 * 1024;

// ---------------------------------------------------------------------------
// Patch rules. `find` must match exactly `expected` times in a pristine bundle;
// if it does not, the file is left untouched and reported as an unknown variant.
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: 'site-status',
    title: 'site-status gate (fetchBlocked) — a page can never be site-status blocked',
    find: /\{let (\w+)=await \w+\((\w+),\w+\.endpoint,\{method:"GET"\}\);if\(!\w+\.ok\)throw new \w+\(\w+\.status\);let \w+=await \w+\.json\(\);return \w+\(\w+\)\}/g,
    replace: '{/*' + MARKER + ':site-status*/return!1}',
    patched: /\{\/\*codex-allowall-patch:site-status\*\/return!1\}/g,
    originalsAfterPatch: 0,
    expected: 1,
  },
  {
    id: 'origin-policy',
    title: 'origin/network policy gateway (getOriginPolicyDecision) — always allowed',
    find: /async getOriginPolicyDecision\((\w+),(\w+)\)\{/g,
    replace: 'async getOriginPolicyDecision($1,$2){/*' + MARKER + ':origin-policy*/return null;',
    patched: /async getOriginPolicyDecision\(\w+,\w+\)\{\/\*codex-allowall-patch:origin-policy\*\/return null;/g,
    originalsAfterPatch: 1,
    expected: 1,
  },
  {
    id: 'host-callback',
    title: 'host-app callback (assertBrowserUrlAllowed) — the two guard calls are neutralized',
    find: /await this\.runtime\.assertBrowserUrlAllowed\?\.\((\w+)\)/g,
    replace: 'void 0/*' + MARKER + ':host-callback*/',
    patched: /void 0\/\*codex-allowall-patch:host-callback\*\//g,
    originalsAfterPatch: 0,
    expected: 2,
  },
];
const EXPECTED_MARKERS = RULES.reduce((n, r) => n + r.expected, 0);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function optValue(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

if (flag('--help') || flag('-h')) {
  out(`Codex in-app browser patch

Usage: node tools/patch-codex-browser-allow-all.mjs [mode] [options]
  --dry-run               show changes without writing
  --verify                require every detected bundle to be patched
  --restore               restore validated pristine backups
  --file <path>           operate on one bundle (config-pin repair skipped)
  --no-process-scan       skip live-process discovery
  --include-fingerprints  include exact hashes, sizes, mtimes and volatile IDs
  --help                  show this help`);
  process.exit(0);
}
const opts = {
  dryRun: flag('--dry-run'),
  restore: flag('--restore'),
  verify: flag('--verify'),
  noProcessScan: flag('--no-process-scan'),
  includeFingerprints: flag('--include-fingerprints'),
  file: optValue('--file'),
};
if (process.platform !== 'win32') {
  err('Windows only: this patch targets the Microsoft Store desktop app (package "OpenAI.Codex",');
  err('shown as "ChatGPT" in the Start menu). The Linux and macOS builds of Codex are not');
  err('supported — they have different layouts and different helpers. See README.md.');
  process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) < 18) {
  err('Node >= 18 is required.');
  process.exit(2);
}
const storeApp = inspectWindowsDesktopApp();
if (!storeApp.ok && !opts.restore) {
  err('Supported app not found: ' + storeApp.detail);
  err('This tool only patches the Microsoft Store app shown as “ChatGPT” (package OpenAI.Codex).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const rel = (p) => p.replace(/\\/g, '/');

function countMatches(text, regex) {
  const m = text.match(new RegExp(regex.source, 'g'));
  return m ? m.length : 0;
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function mtimeStr(p) {
  try { return fs.statSync(p).mtime.toISOString().replace('T', ' ').slice(0, 19); }
  catch { return '?'; }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function walkForServiceFiles(dir, out, depth = 0) {
  if (depth > 24) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name === '.git') continue;
      walkForServiceFiles(full, out, depth + 1);
    } else if (e.isFile() && e.name === 'browser-service.mjs') {
      out.add(full);
    }
  }
}

function discover() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const roots = [
    path.join(localAppData, 'OpenAI', 'Codex', 'runtimes'),
    path.join(codexHome, 'plugins', 'cache'),
    path.join(codexHome, '.tmp'),
  ];
  const out = new Set();
  for (const r of roots) walkForServiceFiles(r, out);
  const files = [...out].sort();
  return { files, codexHome };
}

/**
 * Evidence from .codex\config.toml about which copies Codex is currently using:
 *  - NODE_REPL_TRUSTED_SERVICES       -> exact service path the host loads for node_repl/browser
 *  - runtimes\<family>\<hash> strings -> runtime dir in use (node_repl command, NODE_REPL_NODE_PATH, ...)
 *  - Codex\bin\<hash> strings         -> app build in use (CODEX_CLI_PATH, ...)
 *  - BROWSER_USE_CODEX_APP_VERSION    -> plugin cache version dir
 */
function readConfigEvidence(codexHome) {
  const ev = { browserServicePath: null, runtimeDirs: new Set(), appBuildHashes: new Set(), appVersion: null };
  try {
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const m = toml.match(/NODE_REPL_TRUSTED_SERVICES\s*=\s*'(.*)'/);
    if (m) {
      try {
        const services = JSON.parse(m[1]);
        if (services && typeof services.browser === 'string') ev.browserServicePath = services.browser;
      } catch { /* not JSON, ignore */ }
    }
    for (const mm of toml.matchAll(/runtimes[\\/]([A-Za-z0-9_]+)[\\/]([0-9a-fA-F]{6,})/g)) ev.runtimeDirs.add(`${mm[1]}/${mm[2]}`);
    for (const mm of toml.matchAll(/[\\/]Codex[\\/]bin[\\/]([0-9a-fA-F]{6,})/g)) ev.appBuildHashes.add(mm[1]);
    const v = toml.match(/BROWSER_USE_CODEX_APP_VERSION\s*=\s*"([^"]+)"/);
    if (v) ev.appVersion = v[1];
  } catch { /* no config.toml */ }
  return ev;
}

// ---------------------------------------------------------------------------
// Config pin: NODE_REPL_TRUSTED_SERVICES.browser (the node_repl browser service)
//
// Codex writes the pin from a hardcoded plugin name (the `browser` /
// control-in-app-browser plugin): <codexHome>/plugins/cache/<marketplace>/browser/
// <version>/scripts/browser-service.mjs. node_repl resolves the service by name
// and loads that exact file, so the path must exist. When the plugin cache only
// contains the renamed/merged plugin dir (observed: `chrome`), the pinned path
// dangles. Resolve the best existing copy dynamically on every run instead of
// hardcoding a replacement name, and rewrite just that one JSON value.
// ---------------------------------------------------------------------------
const PIN_RE = /NODE_REPL_TRUSTED_SERVICES\s*=\s*'([^']*)'/;

function parsePinPath(p) {
  const m = rel(p).match(/\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/scripts\/browser-service\.mjs$/i);
  return m ? { marketplace: m[1], plugin: m[2], version: m[3] } : null;
}

function discoverPinCandidates(codexHome) {
  const out = [];
  const cacheRoot = path.join(codexHome, 'plugins', 'cache');
  let marketplaces;
  try { marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch { return out; }
  for (const mk of marketplaces) {
    if (!mk.isDirectory() || mk.isSymbolicLink()) continue;
    const mkDir = path.join(cacheRoot, mk.name);
    let plugins;
    try { plugins = fs.readdirSync(mkDir, { withFileTypes: true }); } catch { continue; }
    for (const pl of plugins) {
      if (!pl.isDirectory() || pl.isSymbolicLink()) continue;
      if (pl.name.startsWith('plugin-backup-')) continue; // uninstall backups, not loadable copies
      const plDir = path.join(mkDir, pl.name);
      let latestVersion = null;
      try { latestVersion = path.basename(fs.realpathSync(path.join(plDir, 'latest'))); } catch { /* no latest link */ }
      let versions;
      try { versions = fs.readdirSync(plDir, { withFileTypes: true }); } catch { continue; }
      for (const v of versions) {
        if (!v.isDirectory() || v.isSymbolicLink() || v.name === 'latest') continue;
        const svc = path.join(plDir, v.name, 'scripts', 'browser-service.mjs');
        if (!fs.existsSync(svc)) continue;
        out.push({ file: svc, marketplace: mk.name, plugin: pl.name, version: v.name, latest: v.name === latestVersion });
      }
    }
  }
  return out;
}

function versionScoreDesc(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1, y = pb[i] ?? -1;
    if (x !== y) return y - x;
  }
  return String(b).localeCompare(String(a));
}

/**
 * Pick the most plausible replacement for a dangling pin, highest score first:
 *  - exact same version dir (plugin renamed/merged, version kept)
 *  - same plugin name (pinned plugin still present, its version dir moved on)
 *  - same marketplace, then dir with a `latest` link pointing at this version
 *  - version == BROWSER_USE_CODEX_APP_VERSION, then newest version
 */
function resolvePinTarget(candidates, pin, appVersion) {
  if (candidates.length === 0) return null;
  const rank = (c) => {
    let s = 0;
    if (pin) {
      if (c.version === pin.version) s -= 100;
      if (c.plugin === pin.plugin) s -= 30;
      if (c.marketplace === pin.marketplace) s -= 5;
    }
    if (c.latest) s -= 20;
    if (appVersion && c.version === appVersion) s -= 10;
    return s;
  };
  return [...candidates].sort((a, b) =>
    rank(a) - rank(b) ||
    versionScoreDesc(a.version, b.version) ||
    a.plugin.localeCompare(b.plugin) ||
    a.marketplace.localeCompare(b.marketplace))[0];
}

function evaluateConfigPin(codexHome, ev) {
  const file = path.join(codexHome, 'config.toml');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, present: false }; }
  const m = text.match(PIN_RE);
  if (!m) return { file, present: true, text, raw: null };
  let json = null;
  try { json = JSON.parse(m[1]); } catch { /* malformed entry, leave alone */ }
  const pinPath = json && typeof json.browser === 'string' ? json.browser : null;
  const pin = pinPath ? parsePinPath(pinPath) : null;
  const exists = pinPath ? fs.existsSync(pinPath) : false;
  let candidates = [], resolved = null;
  if (pinPath && !exists) {
    candidates = discoverPinCandidates(codexHome);
    resolved = resolvePinTarget(candidates, pin, ev ? ev.appVersion : null);
  }
  return { file, present: true, text, raw: m[1], json, pinPath, pin, exists, candidates, resolved };
}

function writeConfigPin(st, newValue) {
  const newText = st.text.replace(PIN_RE, `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ ...st.json, browser: newValue })}'`);
  const backup = st.file + BACKUP_SUFFIX;
  try {
    fs.copyFileSync(st.file, backup); // refresh with the exact pre-fix config for this repair
    writeAtomic(st.file, newText);
  } catch (e) {
    return { status: 'error', detail: 'cannot write config.toml (is Codex holding it?): ' + e.message };
  }
  try {
    const after = JSON.parse(fs.readFileSync(st.file, 'utf8').match(PIN_RE)[1]);
    if (after.browser !== newValue || !fs.existsSync(newValue)) throw new Error('post-check mismatch');
  } catch (e) {
    try { writeAtomic(st.file, st.text); } catch { /* ignore */ } // roll back
    return { status: 'error', detail: 'config pin post-check failed — rolled back: ' + e.message };
  }
  return { status: 'repaired', from: st.pinPath, to: newValue };
}

function restoreConfigPin(st) {
  if (!st.present || st.raw == null || !st.json) return { status: 'none' };
  const backup = st.file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { status: 'no-backup' };
  try {
    const backupText = fs.readFileSync(backup, 'utf8');
    const bm = backupText.match(PIN_RE);
    let bak = null;
    try { bak = bm && JSON.parse(bm[1]); } catch { /* ignore */ }
    if (!bak || typeof bak.browser !== 'string') return { status: 'invalid-backup' };
    if (bak.browser === st.json.browser) return { status: 'unchanged' };
    const neutral = (text) => text.replace(PIN_RE, "NODE_REPL_TRUSTED_SERVICES = '<browser-value>'");
    if (neutral(backupText) !== neutral(st.text)) {
      return { status: 'stale-backup', detail: 'config changed outside the browser pin; refusing to restore an older value' };
    }
    const newText = st.text.replace(PIN_RE, `NODE_REPL_TRUSTED_SERVICES = '${JSON.stringify({ ...st.json, browser: bak.browser })}'`);
    writeAtomic(st.file, newText);
    return { status: 'restored', from: st.pinPath, to: bak.browser };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

function applyConfigPin(st, mode) {
  if (!st.present) return { status: 'no-config' };
  if (st.raw == null) return { status: 'no-pin' };
  if (mode === 'restore') return restoreConfigPin(st);
  if (!st.pinPath) return { status: 'no-pin' };
  if (st.exists) return { status: 'ok' };
  if (!st.resolved) return { status: 'unresolvable', from: st.pinPath };
  const to = rel(st.resolved.file);
  if (mode === 'dry-run') return { status: 'would-repair', from: st.pinPath, to };
  if (mode === 'verify') return { status: 'stale', from: st.pinPath, to };
  return writeConfigPin(st, to);
}

/**
 * Live-process evidence (Windows): which runtime hash Codex's node processes run from,
 * which codex.exe is running, and — when the service process itself is alive — the
 * exact bundle path it executes.
 */
function scanProcesses() {
  try {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*cua_node*' -or $_.CommandLine -like '*browser-service*' -or $_.Name -like 'codex*' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8', timeout: 30000 });
    if (ps.status !== 0 || !ps.stdout || !ps.stdout.trim()) return null;
    const procs = JSON.parse(ps.stdout);
    const list = Array.isArray(procs) ? procs : [procs];
    const runtimeDirs = new Set();
    const servicePaths = new Set();
    const appExePaths = new Set();
    for (const p of list) {
      const cl = p.CommandLine || '';
      for (const m of cl.matchAll(/runtimes[\\/]([^\\/"]+)[\\/]([^\\/"]+)/g)) runtimeDirs.add(`${m[1]}/${m[2]}`);
      const sm = cl.match(/([A-Za-z]:[\\/][^"]*?browser-service\.mjs)/);
      if (sm) servicePaths.add(sm[1]);
      const cm = cl.match(/([A-Za-z]:[\\/][^"]*?codex\.exe)/i);
      if (cm) appExePaths.add(cm[1]);
    }
    return { runtimeDirs, servicePaths, appExePaths, serviceRunning: servicePaths.size > 0, count: list.length };
  } catch { return null; }
}

/** Labels describing how a bundle copy relates to the currently used Codex install. */
function labelsFor(file, ev, proc) {
  const labels = new Set();
  const target = norm(file);
  if (ev && ev.browserServicePath && norm(ev.browserServicePath) === target) labels.add('pinned-by-config');
  if (proc) {
    for (const p of proc.servicePaths) if (norm(p) === target) labels.add('running-now');
  }
  const relLower = rel(file).toLowerCase();
  if (ev) for (const h of ev.runtimeDirs) if (relLower.includes(('runtimes/' + h).toLowerCase())) { labels.add('runtime-pinned-in-config'); break; }
  if (proc) for (const h of proc.runtimeDirs) if (relLower.includes(('runtimes/' + h).toLowerCase())) { labels.add('in-use-runtime'); break; }
  return [...labels];
}

function evidenceRank(labels) {
  if (labels.includes('running-now')) return 0;
  if (labels.includes('pinned-by-config')) return 1;
  if (labels.includes('in-use-runtime')) return 2;
  if (labels.includes('runtime-pinned-in-config')) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Inspect / patch / restore
// ---------------------------------------------------------------------------
function inspect(text) {
  const markers = {};
  let markerTotal = 0;
  for (const r of RULES) {
    const n = text.split('/*' + MARKER + ':' + r.id + '*/').length - 1;
    markers[r.id] = n;
    markerTotal += n;
  }
  const originals = {};
  for (const r of RULES) originals[r.id] = countMatches(text, r.find);

  const replacements = {};
  for (const r of RULES) replacements[r.id] = countMatches(text, r.patched);

  let state;
  const patchedShape = RULES.every((r) =>
    markers[r.id] === r.expected &&
    originals[r.id] === r.originalsAfterPatch &&
    replacements[r.id] === r.expected);
  if (markerTotal === EXPECTED_MARKERS && patchedShape) state = 'patched';
  else if (markerTotal === 0 && RULES.every(r => originals[r.id] === r.expected)) state = 'original';
  else state = 'unknown-variant';
  return { state, markers, markerTotal, originals, replacements };
}

function renderPatched(originalText) {
  if (inspect(originalText).state !== 'original') return null;
  let text = originalText;
  for (const rule of RULES) text = text.replace(new RegExp(rule.find.source, 'g'), rule.replace);
  return inspect(text).state === 'patched' ? text : null;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function patchFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < BUNDLE_MIN_BYTES) return { status: 'error', detail: `unexpectedly small (${buf.length} bytes)` };
  const text = buf.toString('utf8');
  const info = inspect(text);

  if (info.state === 'patched') {
    try {
      const backup = file + BACKUP_SUFFIX;
      if (!fs.existsSync(backup)) return { status: 'no-backup', detail: 'patched bundle has no pristine backup' };
      const backupText = fs.readFileSync(backup, 'utf8');
      if (inspect(backupText).state !== 'original' || renderPatched(backupText) !== text) {
        return { status: 'invalid-backup', detail: 'backup does not reproduce this patched bundle byte-for-byte' };
      }
      return { status: 'already-patched' };
    } catch (e) { return { status: 'error', detail: 'cannot validate backup: ' + e.message }; }
  }
  if (info.state !== 'original') {
    const detail = Object.entries(info.originals).map(([k, v]) => `${k}:${v}`).join(' ');
    return { status: 'anchor-mismatch', detail: `no exact gateway matches (${detail}) — bundle variant not recognized, not touching it` };
  }

  let out = text;
  const applied = [];
  for (const r of RULES) {
    const re = new RegExp(r.find.source, 'g');
    const n = countMatches(out, re);
    if (n !== r.expected) return { status: 'anchor-mismatch', detail: `${r.id}: found ${n}, expected ${r.expected}` };
    out = out.replace(re, r.replace);
    applied.push(r.id);
  }
  const post = inspect(out);
  if (post.state !== 'patched') return { status: 'anchor-mismatch', detail: 'post-check failed' };

  if (opts.dryRun) return { status: 'would-patch', applied, bytesIn: buf.length, bytesOut: Buffer.byteLength(out) };

  // Keep a validated pristine backup of this build.
  const backup = file + BACKUP_SUFFIX;
  try {
    let backupOk = false;
    if (fs.existsSync(backup)) {
      const backupText = fs.readFileSync(backup, 'utf8');
      backupOk = inspect(backupText).state === 'original';
    }
    if (!backupOk || !buf.equals(fs.readFileSync(backup))) fs.copyFileSync(file, backup);
    writeAtomic(file, out);
  } catch (e) {
    try { const tmp = file + '.tmp-' + process.pid; if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { status: 'error', detail: 'cannot write (is Codex locking it? quit Codex and retry): ' + e.message };
  }
  const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (chk.status !== 0) {
    if (/SyntaxError/.test(chk.stderr || '')) {
      try { fs.copyFileSync(backup, file); } catch { /* ignore */ } // roll back
      return { status: 'error', detail: 'patched file failed syntax check — rolled back: ' + (chk.stderr || '').split('\n')[0] };
    }
    return { status: 'patched', applied, note: 'syntax check unavailable on this Node: ' + (chk.stderr || '').split('\n')[0] };
  }
  return { status: 'patched', applied, bytesIn: buf.length, bytesOut: Buffer.byteLength(out), backup };
}

function restoreFile(file) {
  try {
    const current = fs.readFileSync(file, 'utf8');
    const info = inspect(current);
    if (info.markerTotal === 0) return { status: 'not-patched' };
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) return { status: 'no-backup' };
    const backupText = fs.readFileSync(backup, 'utf8');
    const backupInfo = inspect(backupText);
    if (backupInfo.state !== 'original') return { status: 'invalid-backup', detail: `backup state is ${backupInfo.state}` };
    const expectedPatched = renderPatched(backupText);
    if (expectedPatched !== current) return { status: 'stale-backup', detail: 'backup does not reproduce this patched bundle byte-for-byte' };
    fs.writeFileSync(file + PRE_RESTORE_SUFFIX, current, 'utf8');
    fs.copyFileSync(backup, file);
    const after = inspect(fs.readFileSync(file, 'utf8'));
    return { status: after.state === 'original' ? 'restored' : 'restore-verify-failed' };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { files: discovered, codexHome } = discover();
const ev = readConfigEvidence(codexHome);
if (!ev.appVersion && storeApp.version) ev.appVersion = storeApp.version;
const proc = opts.noProcessScan ? null : scanProcesses();
const pinState = opts.file ? null : evaluateConfigPin(codexHome, ev);

let targets = (opts.file ? [path.resolve(opts.file)] : discovered).map((file) => {
  const labels = labelsFor(file, ev, proc);
  return { file, labels, rank: evidenceRank(labels) };
});
if (pinState && pinState.resolved) {
  const want = norm(pinState.resolved.file);
  const hit = targets.find((t) => norm(t.file) === want);
  if (hit) hit.labels = [...new Set([...hit.labels, 'config-pin-target'])];
  else targets.push({ file: pinState.resolved.file, labels: ['config-pin-target'], rank: 0 });
}
if (!opts.file) targets.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));

out('Codex in-app browser patch — allow any domain  (' + RULES.length + ' gateway patch points)');
out('Target: ' + (storeApp.ok ? storeTargetLabel(storeApp) + ' [verified]' : 'local backups only (Store package unavailable during restore)'));
out('Codex home: ' + codexHome);
out('Mode: ' + (opts.restore ? 'restore' : opts.verify ? 'verify' : opts.dryRun ? 'dry-run' : 'patch'));
out('');
out('Detection evidence for what Codex is currently using:');
if (ev.browserServicePath) out('  · trusted node_repl browser service (config.toml NODE_REPL_TRUSTED_SERVICES):\n      ' + ev.browserServicePath);
if (ev.runtimeDirs.size) out('  · runtime configuration found' + (opts.includeFingerprints ? ': ' + [...ev.runtimeDirs].join(', ') : ''));
if (ev.appBuildHashes.size) out('  · app-build configuration found' + (opts.includeFingerprints ? ': ' + [...ev.appBuildHashes].join(', ') : ''));
if (ev.appVersion) out('  · browser plugin version found' + (opts.includeFingerprints ? ': ' + ev.appVersion : ''));
if (proc) {
  out('  · running processes scanned: ' + proc.count +
    (proc.runtimeDirs.size ? ' | runtime configuration seen' + (opts.includeFingerprints ? ': ' + [...proc.runtimeDirs].join(', ') : '') : ''));
  out('  · browser-service.mjs process running now: ' + (proc.serviceRunning ? [...proc.servicePaths].join(', ') : 'no (the service is loaded on demand)'));
  if (proc.appExePaths.size) out('  · codex.exe running from: ' + [...proc.appExePaths].join(', '));
} else {
  out('  · process scan skipped');
}
if (pinState && pinState.present && pinState.raw != null) {
  out('Config pin (NODE_REPL_TRUSTED_SERVICES -> node_repl browser service):');
  out('  · pinned path: ' + (pinState.pinPath || '(entry is not a plain path)'));
  if (pinState.pinPath) {
    out('  · pinned path exists: ' + (pinState.exists ? 'yes' : 'no'));
    if (!pinState.exists) {
      if (pinState.resolved) out('  · resolves to: ' + rel(pinState.resolved.file) +
        '  [' + pinState.resolved.plugin + '/' + (opts.includeFingerprints ? pinState.resolved.version : '<version>') + (pinState.resolved.latest ? ', latest' : '') + ']');
      else out('  · no browser-service.mjs found in the plugin cache — cannot resolve');
    }
  }
  out('');
}
out('Found ' + targets.length + ' bundle copy(ies), highest evidence first:');
for (const t of targets) out('  - ' + t.file + (t.labels.length ? '   [' + t.labels.join(', ') + ']' : ''));
out('');

let failures = 0;
let patchedCount = 0;
let alreadyCount = 0;
if (targets.length === 0) {
  out('✗ No browser-service.mjs copies were discovered; this patch layer was not applied.');
  failures++;
}

for (const { file, labels } of targets) {
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) { out('✗ ' + file + '\n    cannot read: ' + e.message); failures++; continue; }

  const info = inspect(buf.toString('utf8'));

  out('• ' + file);
  out('  ' + (opts.includeFingerprints
    ? 'size ' + buf.length + ' | sha256 ' + sha256(buf).slice(0, 16) + ' | mtime ' + mtimeStr(file) + ' | '
    : '') + (labels.length ? labels.join(', ') : 'detected copy'));

  if (opts.verify) {
    out('  state: ' + info.state + ' (markers ' + info.markerTotal + '/' + EXPECTED_MARKERS + ')');
    if (info.state === 'patched') {
      try {
        const backup = file + BACKUP_SUFFIX;
        if (!fs.existsSync(backup)) throw new Error('validated pristine backup is missing');
        const backupText = fs.readFileSync(backup, 'utf8');
        if (inspect(backupText).state !== 'original' || renderPatched(backupText) !== buf.toString('utf8')) {
          throw new Error('backup does not reproduce this patched bundle byte-for-byte');
        }
        out('  backup: validated for this bundle version');
        alreadyCount++;
      } catch (e) {
        out('  ✗ restore readiness failed: ' + e.message);
        failures++;
      }
    } else failures++;
    out('');
    continue;
  }

  if (opts.restore) {
    const res = restoreFile(file);
    if (res.status === 'restored') out('  restored from backup (previous patched copy saved as *' + PRE_RESTORE_SUFFIX + ')');
    else if (res.status === 'not-patched') out('  file is not patched — nothing to restore');
    else if (res.status === 'no-backup') { out('  file is patched but no backup was found — cannot restore'); failures++; }
    else if (res.status === 'invalid-backup') { out('  backup is not a validated pristine bundle — refusing to restore: ' + res.detail); failures++; }
    else if (res.status === 'stale-backup') { out('  backup belongs to a different bundle version — refusing to restore: ' + res.detail); failures++; }
    else { out('  restore FAILED' + (res.detail ? ': ' + res.detail : '')); failures++; }
    out('');
    continue;
  }

  out('  state: ' + info.state + (info.state === 'unknown-variant' ? ' (' + Object.entries(info.originals).map(([k, v]) => k + ':' + v).join(' ') + ')' : ''));
  const res = patchFile(file);
  switch (res.status) {
    case 'patched':
      patchedCount++;
      out('  ✓ patched: ' + res.applied.join(', ') + ' | ' + res.bytesIn + ' -> ' + res.bytesOut + ' bytes');
      out('    backup: ' + (res.backup || file + BACKUP_SUFFIX));
      if (res.note) out('    note: ' + res.note);
      break;
    case 'would-patch':
      out('  ~ would patch: ' + res.applied.join(', ') + ' | ' + res.bytesIn + ' -> ' + res.bytesOut + ' bytes (dry-run, nothing written)');
      break;
    case 'already-patched':
      alreadyCount++;
      out('  = already patched, skipping');
      break;
    default:
      failures++;
      out('  ✗ ' + res.status + ': ' + (res.detail || ''));
  }
  out('');
}

// ---- config pin action: repair a dangling NODE_REPL_TRUSTED_SERVICES.browser path ----
let pinNote = 'skipped';
if (!pinState) {
  pinNote = 'skipped (--file mode)';
} else {
  const pinMode = opts.restore ? 'restore' : opts.verify ? 'verify' : opts.dryRun ? 'dry-run' : 'patch';
  const res = applyConfigPin(pinState, pinMode);
  switch (res.status) {
    case 'no-config': pinNote = 'no config.toml found'; break;
    case 'no-pin': pinNote = 'no NODE_REPL_TRUSTED_SERVICES entry'; break;
    case 'ok':
      out('Config pin: ok — pinned path exists (' + pinState.pinPath + ')');
      pinNote = 'ok';
      break;
    case 'repaired':
      out('Config pin: repaired — dangling pinned path replaced');
      out('  from: ' + res.from);
      out('  to:   ' + res.to);
      pinNote = 'repaired';
      break;
    case 'would-repair':
      out('Config pin: would repair (dry-run, nothing written)');
      out('  from: ' + res.from);
      out('  to:   ' + res.to);
      pinNote = 'would repair';
      break;
    case 'stale':
      out('Config pin: stale — pinned path does not exist; re-run without --verify to repair');
      out('  from: ' + res.from);
      out('  to:   ' + res.to);
      failures++;
      pinNote = 'stale';
      break;
    case 'unresolvable':
      out('Config pin: pinned path missing and no replacement copy found in the plugin cache');
      out('  from: ' + res.from);
      failures++;
      pinNote = 'unresolvable';
      break;
    case 'restored':
      out('Config pin: restored backup value');
      out('  from: ' + res.from);
      out('  to:   ' + res.to);
      pinNote = 'restored';
      break;
    case 'unchanged': pinNote = 'unchanged'; break;
    case 'no-backup':
      pinNote = 'no backup to restore';
      if (pinMode === 'restore') { out('Config pin: no backup found — cannot prove the pin was restored'); failures++; }
      break;
    case 'none':
      pinNote = 'invalid or unparseable backup/current pin';
      if (pinMode === 'restore') { out('Config pin: current or backup pin is not parseable — refusing a false-success restore'); failures++; }
      break;
    default:
      out('Config pin: ' + res.status + (res.detail ? ' — ' + res.detail : ''));
      failures++;
      pinNote = res.status;
  }
  out('');
}

out('Summary: ' + patchedCount + ' patched, ' + alreadyCount + ' already patched, ' + failures + ' problem(s); config pin: ' + pinNote + '.');
if (patchedCount || alreadyCount) out('Fully quit and restart Codex so the patched service is loaded. Re-run this script after every Codex update.');
process.exit(failures ? 1 : 0);
