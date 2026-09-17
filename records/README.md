# records/ — run receipts (kept local, not published)

The JSON files in this folder are **receipts** written on the machine where the patches were
applied. They are deliberately excluded from the repository — see `../.gitignore`.

| File | Written by | What it holds |
|---|---|---|
| `docs-patch-report.json` | `tools/patch-computer-use-docs.mjs`, on patch/restore runs | one entry per run: per-rule status (`applied`, `pending`, `anchor-missing`, `anchor-ambiguous`, `partial`, `drift`), a clue when a rule moved, and a *changed since previous run* list; hashes/times require `--include-fingerprints` |
| `url-policy-tests.json` | the standalone experiment harness | per-call results: parameters sent, `ok`/error, response keys, screenshot metadata |

## Why they are not published

They can contain machine-specific information: absolute paths below `%USERPROFILE%`, live page URLs,
window identifiers, and details of the installed app. They only make sense for one machine,
account and day, and publishing them would leak local details for no benefit.

## Why they are still useful locally

- **Spotting rule drift.** Run `node tools/patch-computer-use-docs.mjs --verify` and read the last
  entry. The *changed since previous run* list is how you notice that a Codex update rewrote,
  moved or deleted one of the rules the patch expects.
- **History.** The file is the only record of which rules were applied when, and of the runs that
  failed on the way.

## Reproducing instead of publishing

Delete the files and re-run the tools: you get fresh receipts for your own machine. Nothing else
depends on them.

Default console/JSON output replaces personal roots and volatile install IDs with placeholders.
Some tools accept `--include-fingerprints` for exact hashes, mtimes, process IDs and timestamps;
those opt-in records are private diagnostics and should not be published.
