# Unbounded concurrent sessions, app-enforced single-writer on session files

**Status:** accepted

The app imposes no concurrency ceiling on sessions: N sessions = N `omp --mode rpc-ui` subprocesses, bounded only by the user's hardware. Real-world evidence (many concurrent omp sessions via herdr, typically spread across git worktrees rather than one repo) shows SQLite `busy_timeout` contention is a non-issue in practice, so no app-level prompt serialization is added.

The one guard the app does enforce is session-file ownership: omp's "single-writer" convention on session JSONL has no OS-level lock behind it (research §5.2, UNVERIFIED item 4), so the app keeps a registry of which live process owns which session file and refuses to drive a file owned by another live process (e.g. the user's terminal omp on the same project), offering read-only replay instead. This is a corruption guard, not a contention guard — silent JSONL corruption is the one unforgivable failure mode of a multi-process wrapper.

The product north star is full parity with the omp TUI's session surface; v1 ships the subset recorded in the v1 scope discussion (transcript with inline diffs, steering composer, approval inbox, session switcher, subagent panel, model/thinking pickers), with branch navigation, cost dashboards, and export/handoff landing after v1 on the road to parity.
