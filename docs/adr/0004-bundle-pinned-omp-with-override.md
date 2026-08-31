# Bundle a pinned omp binary, with user override

**Status:** accepted

The app bundles a specific, tested version of the omp binary (permitted by MIT with attribution) and runs it by default. A settings escape hatch lets power users point at their own omp install; that path is gated behind a launch-time protocol smoke test (negotiate via the `ready` frame, then a canned command round-trip) and carries an explicit compatibility-risk acknowledgement.

Requiring a user-installed omp was rejected: omp ships multiple patch releases per day and the rpc-ui wire surface is documented and version-negotiated but not frozen — an uncontrolled binary version means a Tuesday omp release can break the app Wednesday. Bundling without an override was rejected as too rigid for a tool whose audience lives on the omp CLI.

This also fixes the version strategy for multi-session support: the pin _is_ the version. CI runs a protocol smoke suite against each new omp release before the bundled pin is bumped.
