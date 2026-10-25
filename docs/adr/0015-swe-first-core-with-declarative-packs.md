# SWE-first core; Workflow Packs are declarative only

The engine hardcodes the software-delivery machinery:

- git worktrees
- the Integration Branch
- the Ticket Graph scheduler
- merging
- PR publishing

Workflow Packs contain only a manifest and pinned skills. They choose among the engine's built-in Stage behaviours and never ship executable code.

GTM-style Workflows are an explicit goal, but there is no second domain yet to generalize from. We will extract domain-agnostic abstractions when that domain arrives, not guess at them now.

## Considered Options

- **Domain-agnostic core with built-in Capabilities.** Deferred: abstractions designed from one domain.
- **Code executors inside packs.** Rejected for v1: it needs a stable plugin ABI and sandboxing.

## Consequences

- A non-SWE Workflow cannot ship until the core is generalized. Packs written now are not guaranteed to survive that refactor unchanged.
