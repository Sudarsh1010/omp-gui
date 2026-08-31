# Browser architecture: app-owned Chromium, dual CDP attach

**Status:** accepted

The agent drives an **app-owned Chromium** (Chrome for Testing, one persistent profile per project, run headed behind the pane), launched with `--remote-debugging-port`. omp's builtin browser tool attaches to it through its existing connected-CDP path (`puppeteer.connect({ browserURL })`, disconnect-only on close). The app attaches a **second CDP client** (flatten-mode multi-client) that runs `Page.startScreencast` to feed the live browser pane and forwards user input via `Input.dispatch*` for takeover.

Rejected alternatives:

- **Pane-is-the-browser (Electron embedded webcontents driven via CDP)**: requires opening a remote-debugging port on the running app — any local process could then drive the entire UI — and driving Electron webcontents over CDP is the quirky path. Disqualified on security alone.
- **omp's broker-shared per-project Chromium**: tabs are shared with the user's terminal omp sessions; no per-session pane affinity; lifecycle not ours.
- **Overlaying `browser` as a host tool**: discards omp's stealth injection and a11y-observation pipeline, violating wrap-not-fork (ADR-0001).

Human-in-the-loop at auth gates is a designed path, not an escape hatch: (1) pane takeover via input forwarding while the blocked agent waits (with a "user is driving" affordance suppressing agent input), (2) the persistent per-project profile makes logins once-ever across sessions, (3) omp's `browser.relay` mode (driving the user's real Chrome via the relay extension) ships as a per-task toggle for flows that need the user's real sessions — SSO hardware keys, password-manager-only sites, payment flows where synthetic input behaves differently.

Known costs accepted: ~50–150 ms pane latency from frame streaming; takeover input is CDP-synthesized; headed-behind-the-pane is required because headless fingerprints trip bot detection more readily (omp's stealth scripts mitigate, not eliminate).
