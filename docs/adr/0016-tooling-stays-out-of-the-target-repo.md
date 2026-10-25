# proteus's tooling stays out of the target repo

The Tracker, Workflow Packs and their skills live in proteus, not in the target repo. Repo history only ever gains code plus the repo's own domain docs (GLOSSARY, ADRs). Committing domain docs to the Integration Branch can be switched off per project. proteus may *read* committed Workflows and config from `<repo>/.proteus/`, but it never writes there.

## Tracker backend

The Tracker backend is chosen by a global preference with per-project overrides, held in proteus config. This replaces the repo docs that `setup-matt-pocock-skills` would write. proteus injects the matching issue-tracker instructions into each Session.

- **Local.** Agents write the skills' local-markdown tracker files (Specs, Tickets with `Status:` and `Blocked by:` lines) to `~/.proteus/workorders/<id>/tracker/`, an absolute path outside the repo. proteus parses them: the H1 is the title and the rest is the body. All of a WorkOrder's Run worktrees see the same Tracker.
- **GitHub.** Skills use `gh` against the project's GitHub Issues, and proteus reads the issues back through `gh`.

## Completion signal

Stages and Runs signal completion by calling the `stage_complete` and `run_complete` Host Tools, which proteusd registers on each Session via `set_host_tools`. Sessions do not print a sentinel line. A turn that settles without the call means the Session needs input: on Autopilot the Answerer supplies it, otherwise the user does.

## Considered Options

- **Tracker files in a self-ignoring `.proteus/` inside the worktree.** Rejected: that path collides with committed repo Workflows, and other Run worktrees cannot see it.
- **Vendored skills and `.scratch/` on the Integration Branch.** Rejected: it puts tooling into the target repo's PR.
- **Tracker tools (`tracker_publish_spec` …) instead of files.** Rejected: the skills already speak local markdown and `gh`, so parsing their own output keeps them unmodified.
