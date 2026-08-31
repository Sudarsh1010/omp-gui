# Speak omp's native rpc-ui protocol, not ACP

**Status:** accepted

The app speaks omp's native NDJSON RPC (`--mode rpc-ui`), not the Agent Client Protocol (`--mode acp`). ACP v1 is designed for generic Zed-style clients and caps the feature set at prompt/cancel/permission plus optional session methods; omp's rpc-ui additionally exposes mid-turn steering (`steer`/`follow_up` with queue modes), subagent streams (`set_subagent_subscription`), branching (`branch`/`get_branch_messages`), model/thinking control, compaction/retry control, and — critically for this app's reason to exist — the host-tool surface (`set_host_tools`, `host_tool_call`, `host_tool_result`) that computer use and browser use are built on, plus `extension_ui_request` for permission UX.

Being agent-agnostic was rejected: the app's differentiator is omp-specific depth, and every hour spent abstracting over ACP's lowest common denominator is an hour not spent on the computer-use core. The cost is hard coupling to one agent; if a second agent is ever supported, it goes behind a new adapter rather than retro-fitting ACP semantics onto rpc-ui.
