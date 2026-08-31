# Weekly automated pin-bump with protocol smoke gate

**Status:** accepted

The bundled omp pin (ADR-0004) rides a **weekly automated bump PR**: update the pinned package, then gate on (1) `tsc` — free, since the frontend imports `rpc-types.ts` from the pin (ADR-0007) — and (2) a protocol smoke suite run against the real binary: `ready`-frame version negotiation, a prompt round-trip, mid-turn `steer`, `abort`, a host-tool call/result cycle, an `extension_ui_request`/`response` cycle, and subagent-frame subscription. Green is auto-mergeable; red sends a human to the changelog.

Daily chasing was rejected (omp ships multiple patches per day; pure churn). Long cadences were rejected because the session JSONL format is versioned-migrated only upward — a pin too far behind the user's terminal omp risks encountering session files written by a newer schema it cannot read. Weekly keeps the bundled binary and the user's CLI within migration reach of each other. In-app, pin updates ride the normal app updater.
