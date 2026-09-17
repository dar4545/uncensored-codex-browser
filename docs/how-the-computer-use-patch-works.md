# How the Computer Use patch works — evidence and limits

Companion to `tools/patch-computer-use-url-policy.mjs`. The investigation used one Store/plugin
build; exact versions are intentionally omitted because they identify one machine state and become
stale quickly. The tool and this write-up were revised after a review of the claims, so the wording
here is deliberately narrower than in the first version.

Raw run records: `records/url-policy-tests.json` (kept locally, not published — see
`records/README.md`). That file holds the per-call JSON (parameters, `ok`, error text, response
keys, screenshot metadata). It is still **not** a network capture.

## 1. What the patch is — and is not

The honest name for the approach is **URL-policy request falsification**, not "always allow".

- It rewrites the address that gets sent for cloud classification.
- It does **not** replace the local decision with `true`, and it does **not** remove the cloud call.
- Whether the action is allowed still depends on the service being reachable, the account, the
  backend's parsing, caching, and the verdict it returns.

Intended request transformation (inferred from strings in the executable, not captured on the
wire):

```text
before: /backend-api/aura/site_status?site_url=<real-url>&url_request_source=codex_browser_use
after:  /backend-api/aura/site_status?junk_url=<real-url>&site_url=<CONSTANT>&f=1
```

**Privacy:** the intended query still carries the real page URL (under `junk_url`) and still
contacts the same endpoint. Even if the server ignores that parameter when deciding, it does not
remove it from logs or from any other processing. Nobody has captured the traffic here to check.

## 2. How the executables were examined (static analysis)

- All copies were listed under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\…` and the app resources.
  The resource roots had to be resolved through `chrome-native-hosts-v2.json`, because the
  `WindowsApps` folder cannot simply be listed.
- `sha256` and size comparison: runtime and resource copies are byte-identical per binary.
- Printable neighbourhood dumps (`data.find` ± 400–700 bytes) and occurrence counts for the
  policy strings: `site_status`, `feature_status`, `SiteStatusResponse`, `BrowserURLPolicy`,
  `BrowserURLPolicyTurnDenials`, the denial sentences, the WinHTTP error strings, the
  authentication/account header names, `SiteCheckFlight` / `CacheEntry` / `PolicyURL`, and the COM
  names `IShellWindows` / `IWebBrowser2` / `get_LocationURL`.
- Wrapper inspection: JSON-lines stdin/stdout transport, `--parent-pid`, the approval meta key
  `x-oai-cua-approved-app`, turn metadata, and `CODEX_CLI_PATH` for the auth token.

**A string being present in the binary is not the same as it running.** The COM names in
particular are *not* evidence that the Chrome case reads its URL through
`IWebBrowser2::get_LocationURL`; they could belong to another browser path or a fallback. Two
strings sitting next to each other also does not by itself tell you in what order they get
joined. Both remain static findings.

## 3. Code changes in this revision (verified in a lab)

Each item was exercised on throwaway copies in a scratch folder outside the Codex home (since
removed). Copies were always taken from the pristine `.codex-allowall.bak`, so tests could not
contaminate each other.

| # | Change | Why | Lab result |
|---|---|---|---|
| 1 | Strict state classification: `original`, `patched`, `patched-other-url`, `partial`, `unexpected-literals`, `unknown-variant` | A half-applied edit must never be reported as a finished patch | hand-applied single swap → `partial` with per-literal counts, exit 1 |
| 2 | Bounded **swap-diff** check (post-write and `--verify`) | "the pattern is there" is weaker than "only the intended bytes changed" | real files: plain `39 byte(s) changed inside 3 expected span(s)`; swift `39 byte(s) … 2 expected span(s)`; mismatch ⇒ problem |
| 3 | Backup validation + **backup-driven restore** | An unverified backup must not be reused, and restore must work whatever edit is present | clobbered backup → refusal; other-constant patch → restored; already-pristine → no-op |
| 4 | Rollback reported separately | The old code could claim "rolled back" after swallowing a failure | rollback success/failure now reported separately, with the preserved backup path |
| 5 | Locked running image: try in-place → rename aside (`.bak` if free, else `.old`) → write → verify | The app respawns its helper, which keeps the image locked | running copy: probe `locked` → patched → swap-diff ok → restore clean |
| 6 | Observability: running-helper list with **start time vs file mtime**, plus `--json` output | On-disk state is not the loaded image; keep a record | real run reported a swift helper started *after* the patch (`likely runs the current bytes (not verified)`) |
| 7 | Privacy/scope caveats printed on every run | Docs alone do not reach the person running it | shown in `--verify` output |

What this changes about earlier claims: `--verify` no longer just recognises patterns (it also
bounds the diff), a half-edited file is no longer quietly treated as patched, an unverified
backup is no longer reused, and a failed rollback is no longer hidden. The check is still
byte-level — it is not proof that the program behaves correctly at runtime.

## 4. Experiment log — standalone harness

Method: start one helper per call, write a single JSON line, read the first JSON response, kill
the process. `meta` = `{x-oai-cua-approved-app: "chrome.exe", x-oai-cua-request-budget-ms: 30000}`.
Builds: `pristine`; `const=<known-allowed-site>`; `const=<known-denied-site>` — the two patched
builds differed **only** in that constant. The same allowed and restricted browser windows were
used for every comparison; machine-local window identifiers are intentionally omitted.

| build | allowed test page | restricted test page |
|---|---|---|
| pristine | `ok:true` | `ok:false` — "Computer Use has been stopped for this turn because it is not allowed on the current browser URL…" |
| const=known-allowed-site | `ok:true` | `ok:true` |
| const=known-denied-site | `ok:false` (same denial) | `ok:false` |

Read narrowly: on the *same* allowed window, pristine allowed, the known-allowed-constant build
allowed, and the known-denied-constant build denied. Both patched builds drop `url_request_source` in
the same way and share the same query shape, so for these calls, on this account, at this time,
the verdict followed the substituted `site_url`. That is direct evidence that the substituted
address is what gets classified. It does not measure how much the dropped source field
contributes in general, and it is not a service contract.

More runs, all with the patched build on the restricted test window:

- **Screenshot** (`include_screenshot: true`): `ok:true`; `result.screenshots` contained a real
  `data:image/jpeg;base64,…` payload with dimensions and placement metadata, not just text. Exact
  geometry and payload size are machine-local and intentionally omitted.
- **Input**: `scroll` `{x:500, y:400, scrollX:0, scrollY:600}` → `ok:true`; a follow-up
  `get_window_state` → `ok:true`.
- **Non-browser control** (VS Code window, pristine build): the first call returned
  `approvalRequest {app: "code.exe", riskLevel: "low"}`; after approving as `code.exe` →
  `ok:true` with the editor's accessibility tree. So that first failure was the approval gate,
  not URL policy — and the policy does not engage for a non-browser target.

## 5. What the evidence supports — and what it does not

Supported (for these standalone calls, this account, this time):

- The substituted `site_url` drives the verdict: same window, same query shape, different
  constant → allow vs deny.
- On a page that was previously denied, the patched build returns window state, a real
  screenshot payload, and accepts an input operation.
- The policy path is browser-specific: a non-browser window succeeds with no URL check.

Not supported:

- That a normal Codex session loaded the patched bytes, or that a running helper is executing
  them (the tool can only compare a process start time with a file mtime).
- Anything at network level: no request or response was captured, the query shape stays
  inferred, and the alternative explanations (default parameter handling, cached state) are only
  made *less likely* by the constant-difference result — not eliminated.
- Generality: verdicts depend on account, time and site. The observed allowed/denied pair is not a
  contract for other users or future runs.
- Full Computer Use compatibility: clicks, typing, dragging, navigation, element-index targeting
  and multi-turn behaviour were never exercised here.

## 6. Recovery, locks, atomicity

`patchFile` keeps a pristine copy at `<file>.codex-allowall.bak`. If the image is locked, it
renames the running image aside (`.bak` if free, otherwise `.old`) and writes the patched copy at
the original path. Restore is backup-driven and byte-verified, and it refuses a backup that does
not classify as pristine.

`--restore` has **no** rename-aside fallback: if the target itself is locked, restore reports the
failure and tells you to quit Codex.

The sequence backup → rename → write → verify → (rollback) is **not** an atomic transaction. An
interruption, a permission change or a failing rollback can leave a partial state. The tool now
reports that condition instead of assuming success. A successful lab round trip — including one
against a genuinely running image — only establishes those cases.

## 7. Manifest, integrity, updates

A manifest size/hash mismatch was observed. That does **not** establish that integrity checking is
absent; the supportable claim is only that the modified executable launched in the tested
circumstances. Editing signed content can invalidate signatures, and signature/integrity handling
was not comprehensively established.

After a Codex update, re-run the tool: runtime copies are rebuilt from the read-only resources and
load paths can change. If classification reports `partial`, `unexpected-literals`,
`unknown-variant` or an anchor mismatch, treat the build as unrecognised and redo the diagnosis in
§2 rather than forcing the old swaps.

## 8. Evidence ledger and open gaps

| Evidence | Supported scope | Not established |
|---|---|---|
| Static strings / neighbourhoods | Literal and component presence | Executed path, URL reader, concatenation order |
| Classification + swap-diff (tool) | On-disk bytes bounded to the expected spans | Semantic correctness, loaded image |
| Constant-difference matrix | Substituted address drives the verdict (these calls) | Backend contract; source-field contribution in general |
| Screenshot / scroll / state runs | Those standalone operations on the denied page | Other operations, multi-turn behaviour |
| Non-browser control | Policy is browser-specific | Exact browser-detection mechanism |
| Process list + mtime | Whether a running helper started before/after the patch | Which bytes that process maps |
| Restore / locked-image tests | Those cases only | Atomic recovery under interruption |

Open items: no network capture (that would need TLS interception with a trusted CA — a much
bigger, system-level change); no normal-Codex-session test; restore's locked-target path has no
rename-aside fallback.

## 9. Validating without touching the Codex home (the notify-chain hazard)

Starting the native helpers directly (the harness in §4) has a side effect that has nothing to do
with the byte swaps. Every launch spawns `codex app-server` through `CODEX_CLI_PATH`, and that CLI
re-registers the `notify` hook in the Codex home config — nesting the previous hook as
`--previous-notify` and re-escaping it. Escaping compounds per level, so the line grows roughly
like 2^n: repeated launches grew one `notify` line to hundreds of megabytes and nearly the entire
file. The chain referenced the throwaway harness executables, so the launches themselves — patched
and unpatched alike — were the trigger. The native byte-patcher itself never writes `config.toml`.

Rules for any future validation:

- Treat launching a helper as a config-writing action, not a read-only diagnostic.
- Never launch the helpers repeatedly against the live Codex home: the growth is exponential in
  the number of launches.
- Prefer evidence that cannot touch the home: `--verify` / `--json` state plus the bounded
  swap-diff, and static inspection of the binary.
- For behavioural evidence, let one Computer Use action run inside Codex itself (also the only
  route to normal-session coverage), or use a disposable Windows profile / VM.
- If a harness is unavoidable: a scratch copy of the exe is not isolation, `CODEX_HOME` must be
  verified rather than assumed, and the home config hash must be compared before and after.
- Run `tools/check-codex-home.mjs` around any harness session: it hashes the home configs and
  flags `notify` chains. It is read-only and prints a machine-readable record.

Measured repair: the damaged backup shrank from hundreds of megabytes to a few kilobytes after the
nested `--previous-notify` chain was removed; exactly one line changed and the result remained valid
TOML. The live `config.toml` was not modified, confirmed by comparing its hash before and after.
