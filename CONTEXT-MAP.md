# Context Map

## Contexts

- [GUI](./gui/CONTEXT.md): the Tauri desktop app that wraps `omp --mode rpc-ui` and surfaces computer use / browser use visually
- Website (`apps/website/CONTEXT.md`, created lazily): marketing and docs site
- Utils (`packages/utils/CONTEXT.md`, created lazily): shared TypeScript utilities

## Relationships

- **GUI → omp**: drives `omp --mode rpc-ui` subprocesses over NDJSON/stdio (ADR-0001); imports `rpc-types.ts` from the pinned omp package (ADR-0004, ADR-0007)
- **GUI ← Utils**: shared TypeScript helpers, imported as a workspace package
- **Website → GUI**: presents and distributes the desktop app
