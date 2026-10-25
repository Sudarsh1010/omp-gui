# Context Map

## Contexts

- [GUI](./gui/CONTEXT.md): the Tauri desktop app that wraps `omp --mode rpc-ui` and surfaces computer use / browser use visually
- [Workflow engine](./crates/engine/CONTEXT.md): proteusd, the daemon that runs Workflows (ordered skills with Gates and Autopilot) over omp Sessions
- UI (`platform/ui`, `@omp-gui/ui`): the shared shadcn component library (`base-lyra` style, phosphor icons) — no glossary of its own; see `docs/agents/ui.md`
- IPC (`platform/ipc`, `@omp-gui/ipc`): owns both the Shell Bridge and the rpc-ui protocol that rides through it (see GUI glossary)
- Website (`platform/www`, CONTEXT.md created lazily): marketing and docs site

## Relationships

- **GUI → Workflow engine**: the app is a client of proteusd over a local socket (ADR-0013); Workflow Sessions' rpc-ui frames are relayed from proteusd, not spawned by the shell
- **Workflow engine → omp**: proteusd spawns `omp --mode rpc-ui` per Session with the app's pinned binary (ADR-0014)

- **GUI → omp**: drives `omp --mode rpc-ui` subprocesses over NDJSON/stdio (ADR-0001); imports `rpc-types.ts` from the pinned omp package (ADR-0004, ADR-0007)
- **GUI ← UI**: React components imported from `@omp-gui/ui` (workspace package); the mandated UI layer per `docs/agents/ui.md`
- **GUI ← IPC**: Shell Bridge commands/events and rpc-ui types, imported as a workspace package
- **Website → GUI**: presents and distributes the desktop app
