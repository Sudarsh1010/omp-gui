# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary (wedge audience): developers already running omp in the terminal — TUI power users who routinely run many concurrent omp sessions, typically spread across git worktrees. They come for the surfaces the TUI cannot have.

Secondary (confirmed, follows once polished): developers new to omp who would never adopt a TUI agent; the GUI is their on-ramp to omp itself.

## Product Purpose

A cross-platform desktop app (Tauri) that wraps `omp --mode rpc-ui` and gives it the visual surfaces a terminal cannot: mission control over many concurrent agent sessions, a live browser-use pane with user takeover, and a visual approval surface. Success means TUI users reach for it for multi-session work. North star: full parity with the omp TUI's session surface (ADR-0005).

## Positioning

**Mission control for many sessions.** Running and monitoring N concurrent omp agents visually is the core value; the browser pane and approval UX are surfaces within that, not the headline. The uncopyable mechanism: omp-native rpc-ui wrapping — the app never forks omp (ADR-0001), so every engine improvement (models, tools, session formats) arrives for free, with pinned and smoke-tested omp versions (ADR-0004, ADR-0008) instead of a perpetually stale fork.

## Operating Context

- N sessions = N `omp --mode rpc-ui` subprocesses over NDJSON/stdio; no app-imposed concurrency ceiling — bounded only by hardware (ADR-0005).
- The app coexists with terminal omp on the same projects. An app-enforced single-writer guard refuses to drive a session file owned by another live process and offers read-only replay instead; silent JSONL corruption is the one unforgivable failure mode.
- Browser use: the agent drives app-owned Chromium via CDP; the user watches screencast frames in the Browser Pane and can take over input (e.g. to clear an auth gate). Takeover is a designed path, not an escape hatch. Relay mode drives the user's real Chrome (existing logins) via the browser-relay extension, exposed as a per-task toggle.
- Approvals surface from omp as `extension_ui_request` frames and are answered by the app.

## Capabilities and Constraints

- v1 session surface: transcript with inline diffs, steering composer, approval inbox, session switcher, subagent panel, model/thinking pickers. Post-v1 on the parity road: branch navigation, cost dashboards, export/handoff.
- Computer use v1 is browser-only (ADR-0003). `screen.*` and `input.*` host tools are reserved as a security-gated tier requiring their own security design doc before implementation.
- Bound to the rpc-ui wire surface as-is (documented, version-negotiated, not frozen); omp is pinned and bumped weekly behind a smoke gate.
- Tauri thin shell (ADR-0007): the Rust shell carries rpc-ui frames opaquely and never parses them; Shell Bridge typed via specta-generated bindings (ADR-0010).
- Terminology is binding — Session (never thread/conversation/tab), Shell Bridge, Host Tool, Browser Pane (never webview/embedded browser), Takeover, Relay, Approval (never permission dialog). See `gui/CONTEXT.md`.
- Ships cross-platform in v1: macOS, Windows, Linux.

## Brand Commitments

- "omp-gui" is a working title; the shipping name is **undecided** (open decision — do not treat the working name as final in user-facing surfaces).
- All React UI is built from `@omp-gui/ui` (shadcn `base-lyra` style, Phosphor icons) per `docs/agents/ui.md` — a binding constraint with identity consequences.

## Evidence on Hand

- Ten accepted ADRs in `docs/adr/` and platform research in `docs/research/omp-gui-platform.md`.
- Real-world usage evidence: many concurrent omp sessions (via herdr) across git worktrees informing the no-ceiling decision.
- No testimonials, benchmarks, pricing, or distribution claims exist yet; future work must not fabricate them.

## Product Principles

1. **Wrap, never fork.** The differentiator is the visual surface and approval UX, not the engine; omp's velocity is inherited, not reimplemented.
2. **Concurrency is the product.** Every surface assumes many live sessions, not one; mission control framing wins over single-chat framing.
3. **Show the agent working.** The agent's activity is observable, interruptible, and takeover-able — never a black box.
4. **Corruption is unforgivable.** Session-file ownership guards outrank convenience.
5. **Parity is the north star.** The omp TUI's session surface defines "complete"; v1 ships a deliberate subset of it.
