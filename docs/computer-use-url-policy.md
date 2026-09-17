# Computer Use URL Policy: Full Trigger and Enforcement Picture

The complete picture is that Computer Use has two separate browser-policy layers. The existing patch disables the browser-service layer, but the native Computer Use executable has its own URL-policy layer. That second layer detected restricted test site and stopped `get_window_state`.

## In plain words

Codex checks whether a web page may be operated in two separate places:

1. **Inside its browser service** (JavaScript, used by the built-in browser). The patch in
   `tools/patch-codex-browser-allow-all.mjs` switches these checks off.
2. **Inside the native Computer Use helper** (the program that actually clicks and types). This
   layer is independent: it works out the page address from the window itself, then asks a cloud
   service about that address. The patch in `tools/patch-computer-use-url-policy.mjs` changes the
   address that gets asked about.

The rest of this document follows one real case — a page that was refused — step by step: which
part decides, what is sent to the cloud, what gets cached, and what each piece of the refusal
message tells you. Names in `code` are strings found inside the programs themselves, not
documentation.

*Status note:* this is the original investigation write-up. Some of its wording about what the
tests prove was narrowed afterwards; where the two disagree,
`how-the-computer-use-patch-works.md` is the current version.

## End-to-end architecture

```text
Codex
  decides the next concrete operation
  examples:
    get_window_state
    click element 42
    scroll by 600 pixels
    type "hello"
        ↓
Computer Use JavaScript wrapper
  validates the method parameters
  sends the method and parameters to the native helper
        ↓
Native Computer Use executable
  identifies the target Windows app and window
        ↓
  if the target is a supported browser:
    reads the actual browser URL locally
        ↓
  checks BrowserURLPolicy
    may obtain or reuse a cloud site-status verdict
        ↓
  ALLOWED:
    performs the Windows operation
    returns the real result
        ↓
  DENIED:
    performs no protected operation
    returns a URL-policy error
        ↓
Computer Use JavaScript wrapper
  converts the native response into:
    a successful Computer Use result
    or a rejected Computer Use call
        ↓
Codex
  continues after success
  or stops after the URL-policy denial
```

## Component responsibilities

| Component | Responsibility |
|---|---|
| Codex | Chooses the next operation and its parameters |
| Computer Use skill | Tells Codex how to use the Computer Use interface; it is not the primary URL-policy implementation |
| JavaScript wrapper | Validates, serializes, sends, and decodes Computer Use calls |
| Native executable | Reads Windows UI state, resolves elements, generates Windows input, and enforces URL policy |
| Cloud site-status service | Supplies the URL classification or feature-status verdict |
| Browser service | Controls its own browser session and has a separate URL-policy implementation |

The cloud does not appear to generate mouse or keyboard instructions. It supplies a policy result. Codex chooses the operation, and the native executable performs it.

## The two independent URL-policy paths

The investigation identified two different paths.

### Path A: browser-service policy

```text
Browser-service request
        ↓
browser-service.mjs
        ↓
fetchBlocked()
getOriginPolicyDecision()
assertBrowserUrlAllowed()
        ↓
Browser navigation or browser operation
```

The existing patch modifies this path by effectively making its checks allow the request:

```text
fetchBlocked()             → false
getOriginPolicyDecision()  → null
assertBrowserUrlAllowed()  → no operation
```

That patch worked for this path. The browser service successfully opened:

```text
<restricted-test-url>
```

It also returned the page's live browser accessibility content. Therefore, the browser-service policy did not cause the later Computer Use denial.

### Path B: native Computer Use policy

```text
Computer Use JavaScript call
        ↓
codex-computer-use executable
        ↓
BrowserURLPolicy
        ↓
actual URL read from Chrome
        ↓
cloud-backed site-status verdict
        ↓
native allow or deny
```

This path is independent of the patched `browser-service.mjs`.

The relevant local native components are:

- `codex-computer-use.exe`
- `codex-computer-use-swift.exe`

The JavaScript transport and result handling are implemented in:

- `computer_use_client.js`
- `computer_use_client_base.js`
- `helper_transport.js`

## What happened during the restricted test site test

The observed sequence was:

```text
1. Patched browser service:
     navigate to <restricted-test-url>
       → succeeded

2. Native Computer Use:
     list_apps()
       → succeeded

3. Native Computer Use:
     get_window()
       → succeeded

4. Native Computer Use:
     get_window_state(Chrome)
       → BrowserURLPolicy triggered
       → denied
```

This establishes an important boundary:

```text
Enumerating Chrome as an application or window
    does not require access to the page content
        ↓
get_window_state
    requests page screenshot or accessibility content
        ↓
URL policy activates
```

The native call returned:

> Computer Use has been stopped for this turn because it is not allowed on the current browser URL.

No usable native window state was returned.

## What triggers the URL policy

The policy does not appear to trigger merely because Chrome is running. It triggers when Computer Use asks the native executable to perform a policy-relevant browser operation.

At minimum, the test directly confirmed that it triggers for:

```text
get_window_state
```

That operation can expose:

- the current browser screenshot;
- the accessibility tree;
- focused and selected elements;
- selected text;
- document text;
- element identifiers used by later actions.

Input methods are also likely guarded because they act on browser content:

```text
click_element
click
scroll
type_text
press_key
set_value
perform_secondary_action
drag
```

However, the test directly observed the denial only on `get_window_state`. It did not independently execute every input method against the restricted page because the native denial instructed Computer Use to stop for that turn.

## Detailed trigger flow

For a browser-state request, the flow is approximately:

```text
Codex
  requests:
    get_window_state(Chrome)
        ↓
JavaScript wrapper
  sends:
    method = "get_window_state"
    window = { app: "chrome", id: ... }
    include_screenshot = true
    include_text = true or false
        ↓
Native executable
  confirms that the target is Chrome
        ↓
  determines the active Chrome URL
        ↓
  validates that it has enough confidence in the URL
        ↓
  validates that it is an applicable remote HTTP or HTTPS URL
        ↓
  checks for an existing turn-level denial or usable verdict
        ↓
  if necessary, obtains site status
        ↓
  interprets feature_status
        ↓
  allowed?
    ├─ yes:
    │    collect screenshots
    │    collect accessibility state
    │    return { window, screenshots, accessibility }
    │
    └─ no:
         collect or expose no usable protected page state
         return the URL-policy error
```

## The cloud request

The native executable contains the backend route:

```text
/backend-api/aura/site_status?site_url=
```

Static inspection also identified the request-source value associated with Codex browser use:

```text
url_request_source=codex_browser_use
```

The native executable contains these related identifiers:

```text
BrowserURLPolicy
browserURLPolicy
feature_status
x-codex-browser-use-security-mode
site status HTTP
browser URL policy check failed
```

This supports the following model:

```text
Actual Chrome URL
        ↓
GET /backend-api/aura/site_status?site_url=<actual-url>...
        ↓
response contains feature_status
        ↓
native BrowserURLPolicy interprets that status
```

The response is better described as a **policy verdict** than a certificate. There is no evidence that it is a cryptographically signed certificate that grants later operations. It may be an authenticated backend response containing the applicable feature status.

## Where the real URL comes from

The Computer Use JavaScript request contains the target window and action parameters. It does not appear to supply a trusted page URL.

For example:

```json
{
  "method": "click_element",
  "params": {
    "window": {
      "app": "chrome",
      "id": 123
    },
    "element_index": 42
  }
}
```

The URL is not present there.

Instead:

```text
JavaScript identifies:
    Chrome window 123

Native executable independently reads:
    the URL currently displayed by Chrome
```

That is why changing a URL inside the patched browser service would not change the native Computer Use verdict. The two components do not share the same policy-result path.

## Allowed operation flow

When the URL is allowed:

```text
Codex
  chooses:
    click element 42
        ↓
JavaScript wrapper
  sends:
    click_element(window, element_index=42)
        ↓
Native executable
  reads the browser URL
  checks or reuses the policy verdict
        ↓
  allowed
        ↓
  resolves element 42 from native browser state
  sends the real Windows input
        ↓
  returns success
        ↓
JavaScript wrapper
  resolves the Computer Use call
        ↓
Codex
  requests a new window state
  observes the changed page
  chooses the next action
```

## Denied operation flow

When the URL is denied:

```text
Codex
  requests:
    get_window_state
        ↓
JavaScript wrapper
  transports the request
        ↓
Native executable
  reads the actual URL
  checks or reuses the policy verdict
        ↓
  denied
        ↓
  does not return the protected page state
  emits:
    { ok: false, error: "Computer Use has been stopped..." }
        ↓
JavaScript wrapper
  rejects the request with that error
        ↓
Codex
  receives no screenshot or accessibility tree
  stops Computer Use for that turn
```

The JavaScript wrapper is not choosing to deny the URL. It is reporting the native denial.

## Why suppressing the JavaScript error is insufficient

At the JavaScript boundary, the native response is effectively one of these:

```json
{
  "ok": true,
  "result": {
    "window": {},
    "screenshots": [],
    "accessibility": {}
  }
}
```

or:

```json
{
  "ok": false,
  "error": "Computer Use has been stopped for this turn because..."
}
```

When the response is denied, there is no real successful result hidden behind the error. The native executable has withheld or not performed the requested operation.

If JavaScript changed the second response into a fake success, the next layer would still be missing required data:

```text
window
screenshots
accessibility tree
element identifiers
actual action result
```

That would either cause a validation error or produce a nonfunctional empty state.

## The exact denial branch provides useful evidence

The binary contains separate messages for different failure conditions:

```text
1. URL explicitly not allowed

2. Could not verify whether the URL is allowed

3. Could not determine the current browser URL confidently

4. URL-policy enforcement is unsupported for this browser

5. Browser URL policy request or check failed
```

The restricted test site call returned the first form:

```text
it is not allowed on the current browser URL
```

It did not return:

```text
could not verify
could not determine
unsupported browser
```

Therefore, the failure was not merely:

- a missing network connection;
- an unreadable Chrome address bar;
- an unsupported browser;
- a malformed URL;
- the native helper failing to obtain any policy information.

The native policy reached a definite denial state.

## Local enforcement versus cloud classification

The clean distinction is:

```text
Cloud:
  classifies the URL
  returns a site-status or feature-status verdict

Local native executable:
  observes the actual browser URL
  requests or reuses the verdict
  interprets it
  performs or rejects the operation

JavaScript wrapper:
  transports the request
  exposes success or failure to Codex

Codex:
  chooses the operation
  continues only when usable state is returned
```

Thus, the denial is both cloud-backed and locally enforced:

| Question | Answer |
|---|---|
| Where is the active Chrome URL observed? | Locally |
| Where is the domain classification maintained? | Apparently in the cloud |
| Where is the allow or deny result interpreted? | Native local executable |
| Where is the action physically executed or refused? | Native local executable |
| Where is the resulting error surfaced? | JavaScript wrapper |
| Does the patched browser service control this? | No |

## Caching and turn behavior

The available evidence suggests that the helper may reuse policy state:

```text
BrowserURLPolicyTurnDenials
browser URL policy request budget exhausted
```

The native process was also persistent across calls. This suggests a model such as:

```text
Read current URL
        ↓
Is there already an applicable turn or URL result?
    ├─ yes → reuse it
    └─ no  → contact site_status
```

A denial may be recorded for the remainder of the turn so that later calls fail immediately.

The following details remain unestablished:

- the exact cache duration;
- whether allowed and denied results use the same cache;
- whether the cache is only in memory;
- whether every new URL triggers a fresh request;
- whether the restricted test site test used a fresh network response or a response already cached in the running helper.

The investigation did not capture network traffic during the original denial. Afterward, the persistent helper had no open TCP connection, which is expected after a short HTTP request has completed.

## Local hardcoded and managed-policy findings

Static inspection did not find:

```text
<known-denied-site>
```

hardcoded in either native executable.

It also did not find a restricted test site-specific rule in the JavaScript Computer Use code.

The native binaries do contain evidence of additional policy systems, including:

```text
ComputerUseAllowForbiddenTargets
x-codex-browser-use-security-mode
disabled-for-local-testing
```

Those indicate that native Computer Use can have other controls, such as:

- target-application restrictions;
- managed or product policy;
- a browser-use security mode;
- app approval requirements.

However, no current `BROWSER_USE_SECURITY_MODE` override was found in the active Codex configuration, and the exact restricted test site message matched the URL-policy denial branch. Therefore, there is no evidence that an enterprise Windows policy caused this particular result.

## Current best model

This is the shortest complete representation:

```text
                         COMPUTER USE

Codex
  chooses one concrete operation
        ↓
JavaScript wrapper
  validates and transports it
        ↓
Native Computer Use executable
  identifies the Chrome window
  reads the actual URL locally
        ↓
BrowserURLPolicy
  checks cached or turn state
  or calls cloud site_status
        ↓
Cloud verdict
  allowed or denied
        ↓
Native enforcement
  ├─ allowed:
  │    read UI or generate Windows input
  │    return the real result
  │
  └─ denied:
       perform no protected operation
       return the denial error
        ↓
JavaScript wrapper
  returns result or throws error
        ↓
Codex
  continues or stops
```

Alongside it is a separate browser-service path:

```text
                         BROWSER SERVICE

Browser request
        ↓
patched browser-service.mjs
        ↓
its URL checks return allow or no decision
        ↓
navigation succeeds
```

The two paths converge on the same visible Chrome page, but they do not share the same URL-policy enforcement component.

## Conclusions and confidence

- **Confirmed:** The browser-service patch allowed restricted test site navigation.
- **Confirmed:** Native Computer Use independently denied `get_window_state`.
- **Confirmed:** The native executable contains `BrowserURLPolicy`, the `site_status` endpoint, and `feature_status`.
- **Confirmed:** The JavaScript wrapper transports the native result; it does not perform the real Windows action.
- **Confirmed:** The exact returned message represents an explicit denial, not an inability to inspect or verify the URL.
- **High confidence:** The URL classification is cloud-backed and enforced locally.
- **High confidence:** Changing only the browser-service JavaScript does not affect native Computer Use enforcement.
- **Likely but not directly measured:** The native helper caches or retains policy state for at least part of a turn.
- **Not yet proven:** Whether the restricted test site verdict came from a new HTTP request during that exact call or an existing in-memory result.
- **Not yet tested:** Whether every individual input method repeats the policy check or relies on the turn-level result established by `get_window_state`.

The central finding is:

> **Computer Use chooses and transports concrete operations locally, but a separate native `BrowserURLPolicy` gates browser-state access and Windows input. That native policy reads the real browser URL, obtains or reuses a cloud-backed site-status verdict, and locally decides whether the requested operation is performed.**
