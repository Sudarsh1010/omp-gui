# Bundle a pinned omp binary, with user override

**Status:** accepted

The app bundles a specific, tested version of the omp binary (permitted by MIT with attribution) and runs it by default. A settings escape hatch lets power users point at their own omp install; that path is gated behind a launch-time protocol smoke test (negotiate via the `ready` frame, then a canned command round-trip) and carries an explicit compatibility-risk acknowledgement.

Requiring a user-installed omp was rejected: omp ships multiple patch releases per day and the rpc-ui wire surface is documented and version-negotiated but not frozen — an uncontrolled binary version means a Tuesday omp release can break the app Wednesday. Bundling without an override was rejected as too rigid for a tool whose audience lives on the omp CLI.

This also fixes the version strategy for multi-session support: the pin _is_ the version. CI runs a protocol smoke suite against each new omp release before the bundled pin is bumped.

**2026-09-04 update:** the pin (`omp-pin.json`) temporarily points `releaseBase` at a fork release, `Sudarsh1010/oh-my-pi@v18.1.10-ompgui.1`, rather than `can1357/oh-my-pi`. That release is 18.1.10 plus two commands the Settings page needs — `omp config schema --json` and `omp config unset <key>` — submitted upstream as [can1357/oh-my-pi#10847](https://github.com/can1357/oh-my-pi/pull/10847) (tracked by omp-gui#21). The version string is unchanged (`omp/18.1.10`), so nothing downstream that checks it needs to know the binary came from a fork. `scripts/bump-omp-pin.mjs` (ADR-0008) always resolves `can1357/oh-my-pi`'s latest release, never the fork, so it will move the pin back to an upstream release automatically the first time one ships with a version at or after this fork's base and carries both commands — the schema-coverage seam test added in omp-gui#26 is what would catch a bump that lands before the commands actually ship upstream.
