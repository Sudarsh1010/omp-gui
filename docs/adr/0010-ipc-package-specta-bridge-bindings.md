# Single IPC package with specta-generated Shell Bridge bindings

**Status:** accepted

All communication between gui and the Rust shell lives in one workspace package, `platform/ipc` (`@omp-gui/ipc`), covering both channels behind a single entry point: the Shell Bridge (Tauri commands/events) and the rpc-ui session layer that rides through it. The package is thin: it exports typed client functions and transports, never TanStack Query hooks — query/mutation options and loaders stay in gui, next to the routes that use them. gui constructs the client once via `createIpcClient(transport)` in its router context; the Tauri and node transports both live in the package. `gui/src/rpc/` is deleted wholesale, no re-export shim.

Shell Bridge signatures are type-generated with **tauri-specta** (specta derives + `collect_commands!` + `specta::Event`), exported by a Rust test into `platform/ipc/src/bindings.gen.ts`, which is **checked into git**; CI diffs it to catch drift. Bridge commands return `Result<T, BridgeError>` with a typegen'd error enum, not strings. Commands are **session-id-parameterized from day one** (`omp_send(sessionId, line)`, event payloads as `{ sessionId, line }` envelopes; the client demultiplexes frames to per-session handlers) — this implements ADR-0005's unbounded-sessions mandate and resolves its contradiction with the single-child `OmpState` in `crates/shell/src/omp.rs`.

The rpc-ui protocol types are deliberately _not_ generated: they continue to flow from the pinned omp package's `rpc-types.ts` (ADR-0007), which is a strictly better drift-checker than anything we could generate.

Hand-written bindings plus a payload snapshot test were rejected: they cannot catch command-name/signature drift, and the Rust surface is planned to grow (CDP pane endpoint, post-v1 `screen.*`/`input.*` native APIs per ADR-0003/0007) — specta is marginal at 3 commands but obviously right at 10+, and cheapest to adopt while the surface is tiny. Writing our own typegen script was rejected: its only possible scope is what specta already generates. Auto-detected transports and module-level singletons were rejected in favor of an explicit factory.
