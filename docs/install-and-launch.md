# How the desktop app is installed and launched (Windows, Microsoft Store)

Reference notes for this repository: what the patches assume about the install they are aimed at,
and how that was verified. The observations came from one x64 Store build; versions and paths
change with every update, so the scripts verify the current package instead of trusting a recorded
version.

## The package

The Store app is published as **`OpenAI.Codex`**, but it presents itself — and appears in the
Start menu — as **ChatGPT**. That mismatch is the main reason this document exists: "Codex" and
"ChatGPT" are the same install here.

| | |
|---|---|
| Store package name | `OpenAI.Codex` |
| Full package name | `OpenAI.Codex_<version>_<architecture>__<publisher-id>` |
| Architecture | x64 |
| Install folder | `%PROGRAMFILES%\WindowsApps\OpenAI.Codex_<version>_<architecture>__<publisher-id>\` |
| Application id | `App` |
| Executable | `app\ChatGPT.exe` |
| Entry point | `Windows.FullTrustApplication` (a normal desktop program, not a sandboxed UWP app) |
| Display name | `ChatGPT` (`uap:VisualElements DebugName/Description` also "ChatGPT") |
| Start-menu identity | Displayed as **ChatGPT** |
| Protocol handler | `codex:` |
| Target device family | `Windows.Desktop` |

Check it on a machine with:

```powershell
Get-AppxPackage -Name OpenAI.Codex | Select-Object Name, Version, InstallLocation
Get-StartApps | Where-Object Name -match 'ChatGPT|Codex'
```

Notes from that:

- The package carries **no launch arguments** in its manifest — a Store launch passes no extra
  parameters of its own.
- There is no `desktop:ExecutionAlias` and nothing named `codex`/`ChatGPT` in
  `%LOCALAPPDATA%\Microsoft\WindowsApps`, so `codex` on the command line does **not** come from an
  app-execution alias. The app launches its own CLI from a private, versioned folder instead.
- `app\` is a Chromium-based shell: `ChatGPT.exe` sits next to `chrome.dll` and a versioned
  Chromium manifest. That bundled Chromium is the "in-app browser" the domain patch is about.

## How it starts, and what it runs by default

Launching the Start-menu entry runs `app\ChatGPT.exe` with no arguments (full trust). A live
process snapshot showed the app then spawning this set — the arguments here are the app's defaults,
not something a user chose:

```
ChatGPT.exe                                  (app, pid <app>)
├── ChatGPT.exe --type=crashpad-handler --user-data-dir=%APPDATA%\Codex\web\Codex …
├── ChatGPT.exe --type=gpu-process  --start-stack-profiler …
├── ChatGPT.exe --type=utility --utility-sub-type=network.mojom.NetworkService
│      --standard-schemes=app,codex-sandbox --secure-schemes=app,codex-sandbox
│      --owl-scoped-user-agent-prefix=CodexBrowser
│      --owl-scoped-user-agent-additional-hosts=openai.com,chatgpt.com,chatgpt.site,chatgpt-team.site
├── ChatGPT.exe --type=renderer … (several, one per view)
├── codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled
│             -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true
└── codex-computer-use-swift.exe --parent-pid <app pid>
```

Useful consequences for this repository:

- **The CLI is spawned by the app**, from `%LOCALAPPDATA%\OpenAI\Codex\bin\<build hash>\codex.exe`,
  with `app-server` and a few `-c` config overrides. Those `-c` values are defaults supplied by the
  app; nothing in this repository changes them.
- **Computer Use runs as a child process** of the app (`codex-computer-use-swift.exe --parent-pid
  <app pid>`), which is why the native patch edits helper programs on disk and the app respawns
  them instead of reloading anything.
- The app's own web content uses the `codex-sandbox` scheme and a `CodexBrowser` user-agent prefix —
  that is the shell's UI, separate from the pages the in-app browser visits.

## Where the files the patches care about live

| What | Where | Mutable? |
|---|---|---|
| App programs and the bundled Chromium | `%PROGRAMFILES%\WindowsApps\OpenAI.Codex_<version>_<architecture>__…\app\` | No — the Store updates and ACL-protect this |
| Read-only resource originals (runtime payloads) | `…\app\resources\` | No — and not listable from a normal shell, which is why the native patch resolves resource roots through the verified Store package and `chrome-native-hosts-v2.json` |
| CLI launchers and helper binaries | `%LOCALAPPDATA%\OpenAI\Codex\bin\` (`codex.exe`, `node.exe`, `node_repl.exe`, `rg.exe`, `codex-command-runner.exe`, `codex-windows-sandbox-setup.exe`, plus per-build hash folders) | Yes |
| Runtime copies that Codex actually loads | `%LOCALAPPDATA%\OpenAI\Codex\runtimes\<family>\<hash>\…`, including the `@oai/sky` and `@oai/cua` helper executables | Yes |
| Plugin cache and staging | `%USERPROFILE%\.codex\plugins\cache\openai-bundled\…` and `%USERPROFILE%\.codex\.tmp\bundled-marketplaces\…` | Yes |
| Configuration | `%USERPROFILE%\.codex\config.toml` | Yes |
| App data (Chromium profile) | `%APPDATA%\Codex\web\Codex\` | Yes |

The split matters: a Store update replaces everything under `WindowsApps` and rebuilds the
user-local copies from `app\resources`. That is why the patches edit the user-local copies, leave
the Store copies alone, and have to be re-run after an update.

## Why this is Windows-only in this repository

- The two helper programs one patch edits (`codex-computer-use.exe`, `codex-computer-use-swift.exe`)
  are Windows binaries shipped under `…\bin\windows\`. The macOS and Linux builds have different
  helpers, different paths and a different config layout, so the same anchors would not exist.
- Before patching or verifying, the three patchers query `Get-AppxPackage -Name OpenAI.Codex`,
  verify the package manifest says `Windows.Desktop` + `Windows.FullTrustApplication`, verify its
  visual display name is `ChatGPT`, and check that `app\ChatGPT.exe` exists. The native helper patch
  also uses the verified package's
  `app\resources\cua_node` as a discovery source, so it no longer relies only on
  `chrome-native-hosts-v2.json`.
- Restore is the deliberate exception: validated local backups remain usable if the Store package
  has since been removed or its manifest can no longer be queried.
- Each patcher therefore checks the platform before doing anything and stops with exit code 2:
  `Windows only: this patch targets the Microsoft Store desktop app (package "OpenAI.Codex", shown
  as "ChatGPT" in the Start menu). The Linux and macOS builds of Codex are not supported …`
- `tools/check-codex-home.mjs` is the exception — it only reads `config.toml` and runs on any
  platform, but the `notify`-chain problem it looks for comes from this Windows app.
