#!/usr/bin/env node
/**
 * patch-computer-use-url-policy.mjs
 *
 * URL-policy request falsification for the native Computer Use helpers
 * (codex-computer-use.exe in @oai/sky and @oai/cua, codex-computer-use-swift.exe).
 *
 * What it does: rewrites ASCII literals so the site-status request is intended to
 * be made with a CONSTANT site_url (default https://www.example.com) instead of
 * the real page URL.
 *
 * What it is NOT: a local always-allow. The backend call still happens, the real
 * page URL still travels (under a different parameter name), and backend
 * availability, authentication, parsing, caching and verdict still decide the
 * outcome. The request shape below is inferred from literals; this tool does not
 * capture any HTTP request or response.
 *
 *   before: /backend-api/aura/site_status?site_url=<real>&url_request_source=codex_browser_use
 *   after:  /backend-api/aura/site_status?junk_url=<real>&site_url=<CONSTANT>&f=1
 *
 * Verification semantics (what the tool can and cannot establish):
 *   - classify(): exact literal-set matching. Mixed / foreign / partially patched
 *     files are reported as problems and never silently treated as "patched".
 *   - swap-diff check: when a pristine backup exists, the patched file must differ
 *     from it ONLY inside the expected literal spans, and every differing byte must
 *     equal the replacement byte for that span. This bounds the edit, it does not
 *     prove semantic correctness.
 *   - --verify inspects on-disk bytes and reports running helper processes with a
 *     start-time vs file-mtime comparison. A running instance that started before
 *     the patch cannot be assumed to be executing the current bytes.
 *   - The tool never asserts backend behaviour, operation compatibility, or that a
 *     normal Codex session loaded these bytes.
 *
 * Usage:
 *   node patch-computer-use-url-policy.mjs                  patch every detected copy
 *   node patch-computer-use-url-policy.mjs --dry-run        show what would change, write nothing
 *   node patch-computer-use-url-policy.mjs --verify         report on-disk state (+ running helpers)
 *   node patch-computer-use-url-policy.mjs --restore        restore validated pristine backups
 *   node patch-computer-use-url-policy.mjs --file <path>    operate on one specific file
 *   node patch-computer-use-url-policy.mjs --url <url>      constant site_url to substitute
 *   node patch-computer-use-url-policy.mjs --json           machine-readable report on stdout
 *   node patch-computer-use-url-policy.mjs --skip-proc      skip the running-process scan
 *
 * Requires Node >= 18. Re-run after every Codex update.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const maskDeep = (v) => (typeof v === 'string' ? mask(v)
  : Array.isArray(v) ? v.map(maskDeep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]))
      : v);

const BACKUP_SUFFIX = '.codex-allowall.bak';
const ASIDE_SUFFIX = '.codex-allowall.old';
const PRE_RESTORE_SUFFIX = '.codex-allowall.patched';
const DEFAULT_URL = 'https://www.example.com';
const TAIL_LEN = 37; // bytes available for "&site_url=<url><filler>" in both variants

const PRIVACY_NOTE =
  'NOTE: this is request falsification, not a local always-allow. The intended query still ' +
  'carries the real page URL (under another parameter) and still calls the backend; verdict, ' +
  'auth, parsing and caching still apply.';

const VERIFY_NOTE =
  'NOTE: the checks below cover on-disk bytes (and the bounded swap-diff). They do not prove ' +
  'backend behaviour, operation compatibility, or which bytes a running helper is executing.';

const HELP = `${PRIVACY_NOTE}

${VERIFY_NOTE}

Modes:
  (default)     patch every detected copy
  --dry-run     show the byte swaps that would be applied, write nothing
  --verify      report on-disk state, swap-diff vs backup, and running helper processes
  --restore     restore a validated pristine backup (patched copy kept as *${PRE_RESTORE_SUFFIX})
  --file <p>    operate on one file instead of the discovered set
  --url <u>     constant to substitute as site_url (must leave 0 or >=4 spare bytes)
  --json        emit a machine-readable report on stdout
  --include-fingerprints  include hashes, sizes, mtimes, process IDs and exact times
  --skip-proc   skip the PowerShell running-process scan
  --help        this text`;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const optValue = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (flag('--help') || flag('-h')) { console.log(HELP); process.exit(0); }

const opts = {
  dryRun: flag('--dry-run'),
  verify: flag('--verify'),
  restore: flag('--restore'),
  json: flag('--json'),
  includeFingerprints: flag('--include-fingerprints'),
  skipProc: flag('--skip-proc'),
  file: optValue('--file'),
  url: optValue('--url') ?? DEFAULT_URL,
};
const JSON_MODE = opts.json;
const say = (s = '') => { if (!JSON_MODE) console.log(mask(s)); };

if (process.platform !== 'win32') {
  console.error('Windows only: this patch targets the Microsoft Store desktop app (package "OpenAI.Codex",');
  console.error('shown as "ChatGPT" in the Start menu). The Linux and macOS builds of Codex are not');
  console.error('supported — they have different layouts and different helpers. See README.md.');
  process.exit(2);
}
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Node >= 18 is required.');
  process.exit(2);
}
const storeApp = inspectWindowsDesktopApp();
if (!storeApp.ok && !opts.restore) {
  console.error(mask('Supported app not found: ' + storeApp.detail));
  console.error('This tool only patches the Microsoft Store app shown as “ChatGPT” (package OpenAI.Codex).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Swap sets
// ---------------------------------------------------------------------------
function buildTail(url) {
  if (!/^https?:\/\/[!-~]+$/.test(url)) throw new Error('--url must be a plain http(s) URL without spaces');
  const need = TAIL_LEN - '&site_url='.length - url.length;
  let filler = '';
  if (need === 0) filler = '';
  else if (need >= 4) filler = '&f=' + '1'.repeat(need - 3); // valid extra param, e.g. "&f=1"
  else throw new Error(`URL length ${url.length} leaves ${need} bytes; pick a URL whose length leaves 0 or >=4 spare bytes`);
  return { tail: '&site_url=' + url + filler, need, filler };
}
let TAIL;
try { TAIL = buildTail(opts.url); } catch (e) { console.error(String(e.message ?? e)); process.exit(2); }

const VARIANTS = [
  {
    id: 'plain',
    label: 'codex-computer-use.exe (sky/cua helper)',
    swaps: [
      { old: '?site_url=', new: '?junk_url=' },
      { old: '&url_request_source=', new: TAIL.tail.slice(0, 20) },
      { old: 'codex_browser_use', new: TAIL.tail.slice(20) },
    ],
  },
  {
    id: 'swift',
    label: 'codex-computer-use-swift.exe (app cua-swift-helper)',
    swaps: [
      { old: '/backend-api/aura/site_status?site_url=', new: '/backend-api/aura/site_status?junk_url=' },
      { old: '&url_request_source=codex_browser_use', new: TAIL.tail },
    ],
  },
];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function countOccurrences(buf, needle) {
  const n = Buffer.from(needle, 'ascii');
  let count = 0, from = 0;
  for (;;) {
    const i = buf.indexOf(n, from);
    if (i < 0) return count;
    count++; from = i + 1;
  }
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rel = (p) => p.replace(/\\/g, '/');
const allOne = (a) => a.every((n) => n === 1);
const allZero = (a) => a.every((n) => n === 0);

function describeTail(buf) {
  const i = buf.indexOf('&site_url=');
  if (i < 0) return null;
  return buf.slice(i, i + 24).toString('ascii').replace(/[^\x20-\x7e]/g, '.');
}

/**
 * Exact literal-set classification. States:
 *   original | patched | patched-other-url | partial | unknown-variant
 */
function classify(buf) {
  const matches = [];
  for (const v of VARIANTS) {
    const olds = v.swaps.map((s) => countOccurrences(buf, s.old));
    const news = v.swaps.map((s) => countOccurrences(buf, s.new));
    if (allOne(olds) && allZero(news)) matches.push({ state: 'original', variant: v });
    else if (allOne(news) && allZero(olds)) matches.push({ state: 'patched', variant: v });
  }
  const orig = matches.find((m) => m.state === 'original');
  if (orig) return orig;
  const patched = matches.find((m) => m.state === 'patched');
  if (patched) return patched;
  if (matches.length > 1) return { state: 'ambiguous', detail: matches.map((m) => m.variant.id + ':' + m.state).join(', ') };
  const traces = [];
  let oldSeen = false, newSeen = false;
  for (const v of VARIANTS) {
    for (const s of v.swaps) {
      const o = countOccurrences(buf, s.old), n = countOccurrences(buf, s.new);
      if (o) oldSeen = true;
      if (n) newSeen = true;
      if (o || n) traces.push(`${v.id} ${JSON.stringify(s.old)} old=${o} new=${n}`);
    }
  }
  // A half-applied edit (some originals left, some replacements already in) must
  // never be reported as a finished patch.
  if (oldSeen && newSeen) return { state: 'partial', detail: traces.join('; ') };
  if (newSeen) return { state: 'patched-other-url', detail: 'tail: ' + describeTail(buf) };
  if (oldSeen) return { state: 'unexpected-literals', detail: traces.join('; ') };
  return { state: 'unknown-variant' };
}

/**
 * Bounded swap-diff: every byte that differs between the pristine backup and the
 * patched file must live inside an expected literal span and equal that span's
 * replacement byte. Returns proof-of-bounds, not proof-of-correctness.
 */
function verifyAgainstBackup(patchedBuf, backupBuf, variant) {
  const problems = [];
  const spans = [];
  if (patchedBuf.length !== backupBuf.length) problems.push(`length changed (${backupBuf.length} -> ${patchedBuf.length})`);
  for (const s of variant.swaps) {
    const ob = Buffer.from(s.old, 'ascii'), nb = Buffer.from(s.new, 'ascii');
    const bi = backupBuf.indexOf(ob), pi = patchedBuf.indexOf(nb);
    if (bi < 0) { problems.push(`original literal missing in backup: ${JSON.stringify(s.old)}`); continue; }
    if (pi < 0) { problems.push(`replacement literal missing in target: ${JSON.stringify(s.new)}`); continue; }
    if (bi !== pi) problems.push(`literal shifted (backup@${bi}, target@${pi}): ${JSON.stringify(s.old)}`);
    spans.push({ start: Math.max(bi, pi), len: ob.length, expected: nb, old: s.old });
  }
  if (problems.length) return { ok: false, problems, spans: [], diffBytes: null };
  const len = Math.min(patchedBuf.length, backupBuf.length);
  const outside = [];
  let diffBytes = 0;
  for (let i = 0; i < len; i++) {
    if (patchedBuf[i] === backupBuf[i]) continue;
    diffBytes++;
    const span = spans.find((sp) => i >= sp.start && i < sp.start + sp.len);
    if (!span) { outside.push(i); continue; }
    if (patchedBuf[i] !== span.expected[i - span.start]) outside.push(i);
  }
  if (outside.length) problems.push(`${outside.length} differing byte(s) outside/mismatching the expected literal spans`);
  return { ok: problems.length === 0, problems, spans, diffBytes };
}

// Restore is intentionally independent of the --url used to create the patch.
// The backup fixes the exact positions of the original literals; every other byte
// must still match, while bytes inside those spans may contain any same-length URL patch.
function verifyRestoreCandidate(currentBuf, backupBuf, variant) {
  const problems = [];
  const spans = [];
  if (currentBuf.length !== backupBuf.length) problems.push(`length changed (${backupBuf.length} -> ${currentBuf.length})`);
  for (const swap of variant.swaps) {
    const oldBytes = Buffer.from(swap.old, 'ascii');
    const start = backupBuf.indexOf(oldBytes);
    if (start < 0 || backupBuf.indexOf(oldBytes, start + 1) >= 0) {
      problems.push(`original literal missing or ambiguous in backup: ${JSON.stringify(swap.old)}`);
    } else spans.push({ start, len: oldBytes.length });
  }
  if (problems.length) return { ok: false, problems };
  const outside = [];
  for (let i = 0; i < Math.min(currentBuf.length, backupBuf.length); i++) {
    if (currentBuf[i] === backupBuf[i]) continue;
    if (!spans.some((span) => i >= span.start && i < span.start + span.len)) outside.push(i);
  }
  if (outside.length) problems.push(`${outside.length} differing byte(s) outside the known URL-policy literal spans`);
  return { ok: problems.length === 0, problems };
}

function probeWritable(file) {
  try { const fd = fs.openSync(file, 'r+'); fs.closeSync(fd); return 'ok'; }
  catch (e) { return e.code === 'EBUSY' ? 'locked' : 'read-only'; }
}

function writeAtomic(file, buf) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function restoreBytes(file, backupBuf) {
  try { writeAtomic(file, backupBuf); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function readPristineBackup(file) {
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) return { backup, state: 'missing' };
  try {
    const buf = fs.readFileSync(backup);
    const st = classify(buf);
    return { backup, buf, state: st.state, detail: st.detail, variant: st.variant };
  } catch (e) { return { backup, state: 'unreadable', detail: e.message }; }
}

function patchFile(file, wasLocked) {
  const buf = fs.readFileSync(file);
  const info = classify(buf);

  if (info.state === 'patched') {
    const bk = readPristineBackup(file);
    let diff = null;
    if (bk.state === 'original') diff = verifyAgainstBackup(buf, bk.buf, info.variant);
    return { status: 'already-patched', variant: info.variant.id, diff, backupState: bk.state, backup: bk.backup };
  }
  if (info.state !== 'original') return { status: info.state, detail: info.detail };

  const variant = info.variant;
  const out = Buffer.from(buf);
  const positions = [];
  for (const s of variant.swaps) {
    const ob = Buffer.from(s.old, 'ascii'), nb = Buffer.from(s.new, 'ascii');
    if (ob.length !== nb.length) return { status: 'error', detail: `internal length mismatch for ${JSON.stringify(s.old)}` };
    const i = out.indexOf(ob);
    if (i < 0) return { status: 'error', detail: `literal vanished mid-patch: ${JSON.stringify(s.old)}` };
    nb.copy(out, i);
    positions.push({ old: s.old, new: s.new, offset: i, len: ob.length });
  }
  if (opts.dryRun) return { status: 'would-patch', variant: variant.id, positions };

  const backup = file + BACKUP_SUFFIX;
  const existing = readPristineBackup(file);
  if (existing.state !== 'missing' && existing.state !== 'original') {
    return {
      status: 'error',
      detail: `existing backup ${rel(backup)} is not pristine (${existing.state}) — refusing to overwrite it; move it aside and re-run`,
    };
  }

  let note = null;
  let movedTo = null;
  let wrote = false;

  try {
    if (!fs.existsSync(backup) || !existing.buf || Buffer.compare(existing.buf, buf) !== 0) fs.copyFileSync(file, backup);
  } catch (e) {
    return { status: 'error', detail: 'cannot refresh the pristine backup for this exact helper version: ' + e.message };
  }

  const firstAttempt = () => {
    writeAtomic(file, out);
  };
  try {
    firstAttempt();
    wrote = true;
  } catch (e) {
    const retryable = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
    if (!retryable) return { status: 'error', detail: 'cannot write: ' + e.message };
    // A running helper denies replacing its own image. Windows usually allows
    // renaming it aside; the renamed copy IS a pristine original, so prefer the
    // backup name when it is still free.
    const candidates = [
      ...(fs.existsSync(backup) ? [] : [backup]),
      file + ASIDE_SUFFIX,
      file + ASIDE_SUFFIX + '-' + Date.now(),
    ];
    for (const target of candidates) {
      try { fs.renameSync(file, target); movedTo = target; break; } catch { /* try next */ }
    }
    if (!movedTo) {
      return {
        status: 'error',
        detail: `cannot write and cannot rename the image aside (${e.message}); if a Codex helper is running, quit Codex and re-run`,
      };
    }
    try {
      writeAtomic(file, out);
      wrote = true;
      note = movedTo === backup
        ? 'was locked by a running helper — the running image was renamed to the backup path, the patched copy now sits at the original path'
        : 'was locked by a running helper — pristine copy kept at ' + path.basename(backup) +
          ', running image renamed to ' + path.basename(movedTo) +
          '; delete the moved image once Codex is closed';
    } catch (e2) {
      // put the original back where it was
      let restored = false;
      try { if (!fs.existsSync(file)) { fs.renameSync(movedTo, file); restored = true; } } catch { /* ignore */ }
      return {
        status: 'error',
        detail: `cannot write even after moving the image aside: ${e2.message}` +
          (restored ? ' (original moved back)' : ` (original left at ${rel(movedTo)})`),
      };
    }
  }

  // Post-write verification: exact classification + bounded swap-diff vs backup.
  const patchedBuf = fs.readFileSync(file);
  const pchk = classify(patchedBuf);
  const bk = readPristineBackup(file);
  let diff = null;
  let failure = null;
  if (pchk.state !== 'patched') failure = `post-write classification is ${pchk.state}, not patched`;
  else if (bk.state === 'original') {
    diff = verifyAgainstBackup(patchedBuf, bk.buf, pchk.variant);
    if (!diff.ok) failure = 'post-write swap-diff failed: ' + diff.problems.join('; ');
  }

  if (failure) {
    const rb = bk.state === 'original'
      ? restoreBytes(file, bk.buf)
      : { ok: false, error: 'no validated backup available' };
    return {
      status: 'error',
      detail: failure + ' — ' + (rb.ok
        ? 'rolled back from ' + rel(bk.backup)
        : 'ROLLBACK FAILED (' + rb.error + '); pristine copy at ' + rel(bk.backup) + ', file left in an unknown state'),
      rollbackFailed: !rb.ok,
    };
  }

  return {
    status: 'patched',
    variant: variant.id,
    applied: variant.swaps.map((s) => s.old),
    positions,
    backup: bk.state === 'original' ? bk.backup : null,
    diff,
    note: note ?? (wasLocked ? 'was locked at probe time; patched in place' : null),
    locked: wasLocked,
  };
}

function restoreFile(file) {
  const bk = readPristineBackup(file);
  if (bk.state === 'missing') return { status: 'no-backup' };
  if (bk.state !== 'original') {
    return { status: 'backup-not-pristine', detail: `${bk.state}${bk.detail ? ' (' + bk.detail + ')' : ''} — refusing to restore from it` };
  }
  // Backup-driven: whatever transformation is in the file now (this tool's default
  // constant, another --url, or a partial edit) is replaced by the validated
  // pristine bytes, and only when the file actually differs from them.
  const current = fs.readFileSync(file);
  if (Buffer.compare(current, bk.buf) === 0) return { status: 'already-original' };
  const identity = verifyRestoreCandidate(current, bk.buf, bk.variant);
  if (!identity.ok) {
    return { status: 'backup-version-mismatch', detail: identity.problems.join('; ') };
  }
  try { fs.writeFileSync(file + PRE_RESTORE_SUFFIX, current); }
  catch (e) { return { status: 'pre-restore-copy-failed', detail: e.message }; }
  const rb = restoreBytes(file, bk.buf);
  if (!rb.ok) return { status: 'error', detail: 'cannot write backup into place: ' + rb.error + ' (if a helper is running, quit Codex and re-run)' };
  const now = fs.readFileSync(file);
  if (Buffer.compare(now, bk.buf) !== 0) return { status: 'restore-verify-failed', detail: 'restored bytes differ from the validated backup' };
  return { status: 'restored', state: classify(now).state };
}

// ---------------------------------------------------------------------------
// Running helper processes (observability only)
// ---------------------------------------------------------------------------
function normalizeDate(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/\/Date\((\d+)/);
    if (m) return new Date(Number(m[1])).toISOString();
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function runningHelpers() {
  if (opts.skipProc) return { skipped: true, processes: [] };
  const cmd =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'codex-computer-use*' } | " +
    'Select-Object ProcessId,Name,ExecutablePath,CreationDate | ConvertTo-Json -Compress';
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 25000, windowsHide: true });
    const t = out.trim();
    if (!t) return { skipped: false, processes: [] };
    const parsed = JSON.parse(t);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return {
      skipped: false,
      processes: arr.map((p) => ({
        pid: p.ProcessId,
        name: p.Name,
        path: p.ExecutablePath ? rel(p.ExecutablePath) : null,
        startedAt: normalizeDate(p.CreationDate),
      })),
    };
  } catch (e) {
    return { skipped: false, processes: [], error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function walkForHelpers(dir, out, depth = 0) {
  if (depth > 14) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkForHelpers(full, out, depth + 1);
    else if (e.isFile() && /^codex-computer-use(-arm64)?\.exe$|^codex-computer-use-swift\.exe$/.test(e.name)) out.add(full);
  }
}

function discoverAppResourceRoots(localAppData) {
  const out = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(localAppData, 'OpenAI', 'Codex', 'chrome-native-hosts-v2.json'), 'utf8'));
    for (const e of j.entries ?? []) {
      const rp = e && e.paths && e.paths.resourcesPath;
      if (typeof rp === 'string' && rp) out.add(path.join(rp, 'cua_node'));
    }
  } catch { /* no registry file */ }
  return [...out];
}

function discover(app) {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [
    path.join(localAppData, 'OpenAI', 'Codex', 'runtimes'),
    ...discoverAppResourceRoots(localAppData),
    ...(app?.resources ? [path.join(app.resources, 'cua_node')] : []),
  ];
  const out = new Set();
  for (const r of roots) walkForHelpers(r, out);
  return { files: [...out].sort() };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { files: discovered } = discover(storeApp);
const targets = opts.file ? [path.resolve(opts.file)] : discovered;
const mode = opts.restore ? 'restore' : opts.verify ? 'verify' : opts.dryRun ? 'dry-run' : 'patch';
const proc = runningHelpers();

say('Computer Use native URL-policy request falsification (constant site_url)');
say('Target: ' + (storeApp.ok ? storeTargetLabel(storeApp) + ' [verified]' : 'local backups only (Store package unavailable during restore)'));
say('Mode: ' + mode + '   |   constant: ' + opts.url + (TAIL.filler ? '   (filler ' + TAIL.filler + ')' : ''));
say('');
say(PRIVACY_NOTE);
if (mode === 'verify') say(VERIFY_NOTE);
say('');

if (proc.skipped) say('Running helpers: scan skipped (--skip-proc)');
else if (proc.error) say('Running helpers: scan failed (' + proc.error + ')');
else if (proc.processes.length === 0) say('Running helpers: none');
else {
  say('Running helpers:');
  for (const p of proc.processes) say('  - ' + (opts.includeFingerprints ? 'pid ' + p.pid + '  ' : '')
    + p.name + '  ' + (p.path ?? '?') + (opts.includeFingerprints && p.startedAt ? '  started ' + p.startedAt : ''));
}
say('');

if (targets.length === 0) say('No codex-computer-use*.exe found.');
else say('Found ' + targets.length + ' helper(s):');
for (const t of targets) say('  - ' + rel(t));
say('');

const records = [];
let failures = 0, patchedCount = 0, alreadyCount = 0, skippedCount = 0;
if (targets.length === 0) {
  say('✗ No Computer Use helper copies were discovered; this patch layer was not applied.');
  failures++;
}

for (const file of targets) {
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) {
    say('\u2717 ' + rel(file) + '\n    cannot read: ' + e.message);
    records.push({ path: show(file), readError: e.message });
    failures++;
    continue;
  }

  const info = classify(buf);
  const writable = probeWritable(file);
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  const running = proc.processes.filter((p) => p.path && p.path.toLowerCase() === rel(file).toLowerCase());
  const rec = {
    path: show(file),
    ...(opts.includeFingerprints ? { size: buf.length, sha256: sha256(buf) } : {}),
    variant: info.variant ? info.variant.id : null,
    state: info.state,
    detail: info.detail ?? null,
    writable,
    ...(opts.includeFingerprints ? { mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null } : {}),
    running: running.map((p) => opts.includeFingerprints ? p : ({ name: p.name, path: show(p.path ?? '?') })),
    diff: null,
    backup: null,
  };

  say('\u2022 ' + rel(file));
  say('  ' + (opts.includeFingerprints ? 'size ' + buf.length + ' | sha256 ' + sha256(buf).slice(0, 16) + ' | ' : '')
    + 'variant ' + (info.variant ? info.variant.id : 'unknown') + ' | ' + writable);
  for (const p of running) {
    const late = p.startedAt && mtimeMs ? (Date.parse(p.startedAt) < mtimeMs) : null;
    say('  running: ' + (opts.includeFingerprints ? 'pid ' + p.pid + (p.startedAt ? ' started ' + p.startedAt : '') : p.name) +
      (late === true ? '  -> started BEFORE the on-disk change; may still run the previous bytes'
        : late === false ? '  -> started after the on-disk change; likely runs the current bytes (not verified)' : ''));
  }

  if (opts.verify) {
    say('  state: ' + info.state + (info.detail ? ' (' + info.detail + ')' : ''));
    const bk = readPristineBackup(file);
    rec.backup = { path: show(bk.backup), state: bk.state };
    if (info.state === 'patched') {
      if (bk.state === 'original') {
        const diff = verifyAgainstBackup(buf, bk.buf, info.variant);
        rec.diff = { ok: diff.ok, diffBytes: diff.diffBytes, spans: diff.spans.length, problems: diff.problems };
        say('  swap-diff vs backup: ' + (diff.ok
          ? `${diff.diffBytes} byte(s) changed inside ${diff.spans.length} expected span(s) — bounds ok`
          : 'MISMATCH — ' + diff.problems.join('; ')));
        if (diff.ok) alreadyCount++; else failures++;
      } else {
        say('  ✗ restore readiness unavailable (backup ' + bk.state + ')');
        failures++;
      }
    } else if ((!writable || writable === 'read-only') && info.state === 'original') {
      say('  = read-only copy — skipped (app resources stay pristine; runtime copies are what Codex loads)');
      skippedCount++;
    } else if (info.state === 'patched-other-url') {
      say('  = patched with a different constant — re-run with that --url, or --restore then re-patch');
      failures++;
    } else {
      failures++;
    }
    say('');
    records.push(rec);
    continue;
  }

  if (writable === 'read-only' && info.state === 'original') {
    say('  = read-only file — skipped (app resources stay pristine; runtime copies are what Codex loads)');
    skippedCount++;
    say('');
    records.push(rec);
    continue;
  }
  if (writable === 'read-only') {
    say('  \u2717 read-only file is not pristine (' + info.state + ') — refusing to ignore malformed app resources');
    failures++;
    say('');
    records.push(rec);
    continue;
  }

  if (opts.restore) {
    const res = restoreFile(file);
    rec.restore = res;
    if (res.status === 'restored') say('  restored from validated backup (previous bytes saved as *' + PRE_RESTORE_SUFFIX + ')');
    else if (res.status === 'already-original') say('  file is already pristine — nothing to restore');
    else { say('  \u2717 restore: ' + res.status + (res.detail ? ' — ' + res.detail : '')); failures++; }
    say('');
    records.push(rec);
    continue;
  }

  say('  state: ' + info.state + (info.detail ? ' (' + info.detail + ')' : ''));
  const res = patchFile(file, writable === 'locked');
  switch (res.status) {
    case 'patched':
      patchedCount++;
      say('  \u2713 patched (' + res.variant + '): ' + res.applied.map((s) => JSON.stringify(s)).join(', '));
      for (const p of res.positions) say('    ' + p.old + ' -> ' + p.new + ' @' + p.offset);
      if (res.backup) say('    backup: ' + rel(res.backup));
      if (res.diff) say('    swap-diff vs backup: ' + res.diff.diffBytes + ' byte(s) inside ' + res.diff.spans.length + ' expected span(s)');
      if (res.note) say('    note: ' + res.note);
      rec.diff = res.diff ? { ok: res.diff.ok, diffBytes: res.diff.diffBytes, spans: res.diff.spans.length } : null;
      rec.positions = res.positions;
      break;
    case 'would-patch':
      say('  ~ would patch (' + res.variant + '): ' + res.positions.map((p) => JSON.stringify(p.old) + ' -> ' + JSON.stringify(p.new) + ' @' + p.offset).join(', '));
      rec.positions = res.positions;
      break;
    case 'already-patched': {
      alreadyCount++;
      say('  = already patched');
      if (res.diff) {
        say('    swap-diff vs backup: ' + (res.diff.ok ? res.diff.diffBytes + ' byte(s) inside ' + res.diff.spans.length + ' expected span(s) — bounds ok' : 'MISMATCH — ' + res.diff.problems.join('; ')));
        if (!res.diff.ok) failures++;
      } else {
        say('    ✗ restore readiness unavailable (backup ' + res.backupState + ')');
        failures++;
      }
      break;
    }
    case 'patched-other-url':
      say('  \u2717 patched with a different constant (' + (res.detail ?? '') + ') — use --url to match it, or --restore then re-patch');
      failures++;
      break;
    default:
      failures++;
      say('  \u2717 ' + res.status + (res.detail ? ': ' + res.detail : ''));
  }
  say('');
  records.push(rec);
}

const summary = { patched: patchedCount, alreadyPatched: alreadyCount, problems: failures, readOnlySkipped: skippedCount };
say('Summary: ' + patchedCount + ' patched, ' + alreadyCount + ' already patched, ' + failures + ' problem(s), ' + skippedCount + ' read-only skipped.');
say('Reminder: the real page URL still travels in the intended query, and a running helper keeps its old bytes until it respawns or Codex restarts.');
if (patchedCount || alreadyCount) say('Re-run this script after every Codex update (runtime copies are rebuilt from the read-only app resources).');

if (JSON_MODE) {
  console.log(JSON.stringify(maskDeep({
    ...(opts.includeFingerprints ? { generatedAt: new Date().toISOString() } : {}),
    tool: 'patch-computer-use-url-policy.mjs',
    mode,
    constant: opts.url,
    tail: TAIL.tail,
    swaps: VARIANTS.map((v) => ({ variant: v.id, swaps: v.swaps.map((s) => ({ old: s.old, new: s.new })) })),
    processes: { ...proc, processes: proc.processes.map((p) => opts.includeFingerprints
      ? p : ({ name: p.name, path: show(p.path ?? '?') })) },
    files: records,
    summary,
    notes: [PRIVACY_NOTE, VERIFY_NOTE],
  }), null, 2));
}

process.exit(failures ? 1 : 0);
