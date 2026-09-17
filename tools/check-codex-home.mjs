#!/usr/bin/env node
/**
 * check-codex-home.mjs — read-only audit of the Codex home configuration.
 *
 * Purpose: detect the `notify`-chain hazard. Every launch of a native Computer Use helper can
 * make the Codex CLI re-register the `notify` hook, nesting the previous value as
 * `--previous-notify`; the escaping compounds, so the hook grows ~2^n with the number of
 * launches (a 23-level chain produced a 192 MiB config). This script never writes anything.
 *
 * Usage:
 *   node check-codex-home.mjs              audit $CODEX_HOME or %USERPROFILE%\.codex
 *   node check-codex-home.mjs --json       machine-readable record (fingerprints omitted)
 *   node check-codex-home.mjs --include-fingerprints  include mtimes + full file hashes
 *   node check-codex-home.mjs --dir <path> audit another home
 *
 * Exit codes: 0 = clean, 1 = chain detected or an oversized/invalid-looking config,
 *             2 = usage/environment error.
 *
 * Safe usage around a test harness:
 *   node check-codex-home.mjs --json > before.json    # then run the harness
 *   node check-codex-home.mjs --json > after.json     # diff the two
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

const CHAIN_MARKER = '--previous-notify';
const SIZE_WARN = 64 * 1024;        // a healthy config.toml is a few KB
const MAX_LINE_WARN = 4 * 1024;     // one giant line is the signature of the hazard
const READ_LIMIT = 32 * 1024 * 1024; // don't read absurd files

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const includeFingerprints = argv.includes('--include-fingerprints');
const dirArg = argv.indexOf('--dir');
const home = dirArg >= 0 ? argv[dirArg + 1] : (process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));

if (!home || !fs.existsSync(home)) {
  console.error('Codex home not found: ' + mask(home || '(none)'));
  process.exit(2);
}

function audit(file) {
  const st = fs.statSync(file);
  const rec = { file: mask(file), bytes: st.size, oversized: st.size > SIZE_WARN };
  try {
    if (includeFingerprints) {
      rec.mtime = st.mtime.toISOString();
      rec.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  } catch (e) {
    rec.read_error = e.message;
    return rec;
  }
  if (st.size > READ_LIMIT) {
    rec.note = 'not decoded: larger than ' + READ_LIMIT + ' bytes';
    rec.chain_detected = true; // treat as unsafe until proven otherwise
    return rec;
  }
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  let longest = 0, longestNo = 0;
  lines.forEach((l, i) => { if (l.length > longest) { longest = l.length; longestNo = i + 1; } });
  const notifyNo = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
  const notifyLine = notifyNo >= 0 ? lines[notifyNo] : '';
  rec.lines = lines.length;
  rec.longest_line = { chars: longest, line: longestNo, over_warn: longest > MAX_LINE_WARN };
  rec.notify = {
    line: notifyNo + 1,
    chars: notifyLine.length,
    chain_marker_count: notifyLine.split(CHAIN_MARKER).length - 1,
    levels_estimated: notifyLine.split(CHAIN_MARKER).length - 1,
  };
  rec.chain_detected = rec.notify.chain_marker_count > 0 || rec.longest_line.over_warn;
  rec.toml_looks_intact = /^\s*(model|approval_policy|sandbox_mode|\[)/m.test(text);
  return rec;
}

const files = fs.readdirSync(home)
  .filter((n) => n.startsWith('config.toml'))
  .map((n) => path.join(home, n))
  .sort();

if (files.length === 0) {
  const summary = { home: mask(home), files: 0, flagged: 1, clean: false,
    fingerprintsIncluded: includeFingerprints, error: 'no config.toml files found' };
  if (json) console.log(JSON.stringify(maskDeep({ tool: 'check-codex-home.mjs', summary, records: [] }), null, 2));
  else {
    console.log('Codex home: ' + mask(home));
    console.log('');
    console.log('✗ No config.toml files found; this is not a valid clean audit.');
    console.log('Summary: 0 config file(s), 1 flagged.');
  }
  process.exit(2);
}

const records = files.map((f) => {
  try { return audit(f); } catch (e) { return { file: mask(f), error: e.message, chain_detected: true }; }
});

const dirty = records.filter((r) => r.chain_detected || r.oversized || r.error || r.read_error || r.toml_looks_intact === false);
const summary = { home: mask(home), files: records.length, flagged: dirty.length,
  clean: dirty.length === 0, fingerprintsIncluded: includeFingerprints };

if (json) {
  console.log(JSON.stringify(maskDeep({ tool: 'check-codex-home.mjs', summary, records,
    ...(includeFingerprints ? { at: new Date().toISOString() } : {}) }), null, 2));
} else {
  console.log('Codex home: ' + mask(home));
  console.log('');
  for (const r of records) {
    const flags = [r.oversized ? 'OVERSIZED' : null, r.chain_detected ? 'NOTIFY-CHAIN' : null,
      r.toml_looks_intact === false ? 'INVALID-LOOKING' : null, (r.error || r.read_error) ? 'ERROR' : null]
      .filter(Boolean).join(' ');
    console.log('\u2022 ' + r.file);
    console.log('  bytes ' + r.bytes + (r.sha256 ? ' | sha256 ' + r.sha256.slice(0, 16) : '') +
      ' | lines ' + (r.lines ?? '?') + ' | longest line ' + (r.longest_line ? r.longest_line.chars + ' (#' + r.longest_line.line + ')' : '?'));
    if (r.notify) console.log('  notify: line ' + r.notify.line + ', ' + r.notify.chars + ' chars, chain markers ' + r.notify.chain_marker_count);
    if (flags) console.log('  ' + (r.chain_detected ? '\u2717' : '!') + ' ' + flags);
  }
  console.log('');
  console.log('Summary: ' + summary.files + ' config file(s), ' + summary.flagged + ' flagged. ' +
    (summary.clean ? 'No notify chain, oversized, unreadable, or invalid-looking config detected.' : 'Inspect the flagged files; a growing notify chain means helper launches are re-registering the hook.'));
  if (dirty.length) console.log('Reminder: this script only reports. Do not launch more helpers before the home is clean.');
}

process.exit(dirty.length ? 1 : 0);
