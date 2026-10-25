# Orchestrate the Ticket Graph natively, not through an implement-spec Session

The proteus engine runs the Ticket Graph itself. Each Frontier Ticket becomes a gated Run in its own Session and worktree, branched off the Integration Branch and merged back when the Run completes. The Frontier advances as Runs land.

We do not run one Session that executes the `implement-spec` skill and lets it spawn its own subagents. Those subagents would be invisible to proteus, so the board could not show Runs, and per-Ticket Gates and Autopilot would be impossible. The `implement-spec` skill's steps become engine logic:

- the Integration Branch
- per-Ticket worktrees
- merge discipline
- advancing the Frontier
- the review tail

## Considered Options

- **One wrapper Session running implement-spec.** Rejected. Its subagents are invisible to proteus, so the Ticket Graph board would be a guess.
