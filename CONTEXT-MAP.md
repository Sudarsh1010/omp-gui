# Context Map

## Contexts

- [GUI](./gui/CONTEXT.md): the Tauri desktop app that wraps `omp --mode rpc-ui` and surfaces computer use / browser use visually
- UI (`platform/ui`, `@omp-gui/ui`): the shared shadcn component library (`base-lyra` style, phosphor icons) — no glossary of its own; see `docs/agents/ui.md`
- IPC (`platform/ipc`, `@omp-gui/ipc`): owns both the Shell Bridge and the rpc-ui protocol that rides through it (see GUI glossary)
- Website (`platform/www`, CONTEXT.md created lazily): marketing and docs site

## Relationships

- **GUI → omp**: drives `omp --mode rpc-ui` subprocesses over NDJSON/stdio (ADR-0001); imports `rpc-types.ts` from the pinned omp package (ADR-0004, ADR-0007)
- **GUI ← UI**: React components imported from `@omp-gui/ui` (workspace package); the mandated UI layer per `docs/agents/ui.md`
- **GUI ← IPC**: Shell Bridge commands/events and rpc-ui types, imported as a workspace package
- **Website → GUI**: presents and distributes the desktop app
