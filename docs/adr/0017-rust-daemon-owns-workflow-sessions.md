# Rust daemon owns Workflow Sessions; state is an event log

proteusd is written in Rust, alongside the Tauri shell, and they share protocol types. Each Workflow Session is its own `omp --mode rpc-ui` process using the app's pinned omp (ADR-0004), spawned by proteusd rather than the shell, so a crashing Session cannot take the engine down.

WorkOrder state is an append-only event log in SQLite with projected tables. A daemon restart replays the log and resumes Autopilot, the GUI subscribes to the same event stream, and Stage-duration history (used for ETAs) falls out of the log.

## Considered Options

- **A Bun/TS daemon hosting SDK sessions in-process.** Rejected: it needs a Rust↔TS protocol with codegen, and one Session crash could kill every WorkOrder.
- **Mutable SQLite state tables.** Rejected: recovery logic becomes ad hoc, and the GUI would need a second change feed.
