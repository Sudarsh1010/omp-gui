# omp Browser Machinery — Source-Verified Facts

**Date:** 2026-08-30
**Question:** How does omp's native browser tool work, and what can a desktop GUI wrapping `omp --mode rpc-ui` reuse for a live browser pane?
**Method:** Primary source reads of `github.com/can1357/oh-my-pi` (main; `@oh-my-pi/pi-coding-agent` 18.0.11) by a research subagent; every claim cited to file:line. Complements `docs/research/omp-gui-platform.md`.

## Control protocol

- omp drives Chromium/Chrome/Edge via **puppeteer-core 25.3.0** (Bun-patched: `patches/puppeteer-core@25.3.0.patch`), raw CDP over HTTP/WebSocket. Not Playwright. [root `package.json`; `launch.ts` 1–140]
- The agent observes pages primarily through **accessibility-tree snapshots** (`tab.observe()` → `page.accessibility.snapshot()` + element geometry) and **one-shot PNG screenshots** (resized to ≤1024×1024, ≤150 KB). [`tab-worker.ts` 1830–1875, 1881–1960]
- **No continuous screencast**: no `Page.startScreencast` anywhere in the browser machinery. The browser is the agent's eyes; there is no built-in frame stream for a user-facing surface.

## How the browser is obtained

`acquireBrowser(kind)` supports four kinds [`registry.ts` 1–300, 227–459]:

1. **Headless spawn (default; `browser.headless: true`)** [`settings-schema.ts` 4532–4541]. Binary resolution: `PUPPETEER_EXECUTABLE_PATH` → system Chrome/Edge/Chromium candidates → downloaded Chrome for Testing into the puppeteer cache. [`launch.ts` 143–238, 301–370]
2. **Broker-shared per project**: compiled-binary/CLI-worker hosts launch one Chromium per project as broker daemon `omp.browser.headless` / `omp.browser.headed`; concurrent omp sessions **share tabs in a single browser**. Broker stops it when the last omp client exits. [`shared-daemon.ts` 1–120; `registry.ts` 227–300]
3. **Connected**: attach to an existing CDP endpoint (`waitForCdp` → `puppeteer.connect({ browserURL })`). Close = disconnect only; never killed. [`registry.ts` 227–300, 380–420]
4. **Spawned app**: spawn an arbitrary binary with `--remote-debugging-port=<ephemeral>`; reusable if a live CDP port is found. Prompt forbids stealth-tampering with real desktop apps. [`attach.ts` 1–300; `prompts/tools/browser.md`]

Plus two special surfaces:

- **Relay**: drive the user's own Chrome via the `omp browser-relay` endpoint (`http://127.0.0.1:9224`) + OMP Browser Relay extension, gated by `browser.relay` / `PI_BROWSER_RELAY`. [`relay/kind.ts` 1–45; `settings-schema.ts` 4509–4530]
- **cmux**: when `CMUX_SOCKET_PATH` is set and `browser.cmux` enabled (default), browser automation surfaces open as cmux WKWebView splits via request/response (`browser.open_split`, `surface.close`, …) — precedent for "browser surface rendered in an external UI," but not a frame stream. [`cmux/rpc.ts` 1–120; `tab-supervisor.ts` 450–500; `cmux-tab.ts` 1–300]

## Stealth and security

- 14 stealth scripts injected via `page.evaluateOnNewDocument` (tampering, activity, webgl, screen, fonts, audio, locale, plugins, hardware, codecs, worker, …), UA/brands/platform overridden, automation-tell default args suppressed. [`launch.ts` 704–1033, 412–452]
- Approval: browser tool declares `approval = "exec"` — under `tools.approvalMode: "write"` it requires user confirmation; only `yolo` auto-approves. Per-tool overrides honored. [`browser.ts` 70–80; `tools/approval.ts` 1–150; `settings-schema.ts` 4070–4095]
- **No domain/URL allowlist** for the browser tool found.

## Lifecycle

- Shared browser outlives individual omp processes (broker-owned, per project).
- Tabs carry `ownerSessionId`; released on `AgentSession.dispose()` with a 3s timeout. [`tab-supervisor.ts` 749–775; `agent-session.ts` 4242–4246]
- On-disk **orphan registry** records which OS process owns each shared-browser page target, so later omp processes can reap targets of dead owners. [`orphan-registry.ts` 1–120]

## Interaction with rpc-ui host tools

- Browser is a **builtin tool** (`BUILTIN_TOOL_NAMES`), enabled by default; it works out of the box in RPC mode. [`builtin-names.ts` 1–30; `tools/index.ts` 477, 570–580]
- A host can **overlay its own tool named `browser`** via `set_host_tools`; `refreshRpcHostTools` replaces host-owned tools before the next model call. [`rpc-mode.ts` 1162–1166; `host-tools.ts` 1–120; `agent-session.ts` 5060–5063]

## Implications for the app's browser pane

1. omp gives the agent eyes (a11y tree + screenshots) but **no video surface** — any live pane must be produced by the app speaking CDP itself (e.g. `Page.startScreencast` + `Input.dispatch*`), attached to the same Chromium omp drives. CDP supports multiple concurrent clients (flatten mode).
2. The **connected-CDP kind is the seam**: the app can own a Chromium instance (launched with `--remote-debugging-port`), point omp's browser tool at it, and attach its own second CDP client for screencast and input forwarding — reusing omp's stealth/observation/approval machinery unchanged.
3. The broker-shared browser means tab affinity is shared per project; an app that wants a clean per-session pane should prefer app-owned Chromium over the shared broker browser.
4. Overlaying `browser` as a host tool would discard omp's stealth and observation pipeline — not recommended.

## UNVERIFIED

- The research subagent did not locate a distinct `--mode rpc-ui` string in the investigated source (only `src/modes/rpc/`); the platform research doc cites `cli/args.ts` line 23 and `main.ts` 1508/1819 for `rpc-ui`. Treat existence as established by the platform doc, exact wiring as UNVERIFIED by this pass.
- Whether stealth patches are applied in connected-CDP mode (injection happens per-page via `evaluateOnNewDocument`; applicability to attached browsers not traced).
- Where a headed broker-spawned Chromium window appears (screen/geometry unspecified in source).
