# Workflow Sessions run on the app's pinned omp, not upstream pi

Workflow Sessions use the same pinned omp binary, weekly bump and smoke gate as the rest of the app (ADR-0001, ADR-0004, ADR-0008). omp already provides what the Workflow engine needs beyond stock pi: Host Tools for `stage_complete`/`run_complete`, subagents (which `code-review` and `research` spawn), multi-account pooling, and per-run config overlays and profiles for loading exactly a Stage's skills.

## Considered Options

- **Upstream pi, pinned, plus a proteus extension.** Rejected: we would rebuild subagents and account pooling, and lose this app's existing omp session layer.
- **Forking omp or pi.** Rejected for the reasons in ADR-0001.
