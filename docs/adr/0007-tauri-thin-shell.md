# Tauri thin shell: Rust pipes bytes, TypeScript owns the protocols

**Status:** accepted

The app is **Tauri**, split by protocol velocity:

- **Rust core**: spawns/reaps the `omp --mode rpc-ui` subprocesses (unbounded per ADR-0005) and pipes raw NDJSON bytes; owns the pane's CDP connection and serves screencast frames over a localhost endpoint (never through Tauri events — base64/JSON overhead at frame rate is real); hosts post-v1 native screen capture/input APIs (ADR-0003's reserved `screen.*`/`input.*` tier).
- **TypeScript frontend**: all rpc-ui protocol logic — parsing, session state machines, `extension_ui_request` approval handling — importing `rpc-types.ts` directly from the pinned omp package, so the TypeScript compiler is the wire-compat checker every time the pin bumps (ADR-0004).

The placement rule that falls out: **fast-moving protocol with a canonical TS contract → TypeScript with imported types; slow-moving byte-pump with a tiny surface → Rust.** rpc-ui is the former (daily omp releases, unfrozen wire format); the pane's CDP usage is the latter (`Page.startScreencast`, `Input.dispatch*`, target attachment — a handful of messages stable for a decade). This is why the CDP client belongs in Rust rather than the renderer: the frames already terminate Rust-side, a single CDP connection avoids splitting screencast and input across two clients, and the drift risk that pushed rpc-ui into TypeScript doesn't exist for this surface.

Electron was rejected: its decisive advantage (embedded Chromium the agent drives directly) was disqualified with the pane-is-the-browser architecture (ADR-0006), after which Tauri wins on bundle size, process-supervision fit, and the v2 native-API foundation, at the cost of building the frame-serving endpoint and routing disk access through Rust commands.
