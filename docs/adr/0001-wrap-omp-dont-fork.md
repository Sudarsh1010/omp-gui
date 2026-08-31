# Wrap omp, don't fork it

**Status:** accepted

The app drives `omp --mode rpc-ui` as a subprocess over NDJSON/stdio; we never fork or patch the omp engine. Research (`docs/research/omp-gui-platform.md`) shows the rpc-ui surface carries everything the app needs: prompt/steer/abort, session events, subagent streams, host tools (`set_host_tools` / `host_tool_call` / `host_tool_result`), and `extension_ui_request` for approvals. omp is MIT-licensed, so subprocess driving and binary redistribution are both permitted.

Forking was rejected: omp releases multiple patch versions per day, and a fork would be perpetually stale; every engine improvement (models, tools, session format migrations) arrives for free when we wrap. The cost is that we are bound to the rpc-ui wire surface as-is — it is documented and version-negotiated but not frozen — so we pin and smoke-test specific omp versions rather than assume stability.
