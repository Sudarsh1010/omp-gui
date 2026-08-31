# omp as a Platform for a Third-Party Desktop GUI Client

**Date:** 2026-08-30
**Question:** Can omp (Oh My Pi, the coding-agent CLI, omp.sh, v18.x) serve as a platform for a third-party desktop GUI client, the way T3 Code wraps Claude Code?
**Method:** Primary sources only — the omp source repo (`github.com/can1357/oh-my-pi`), official docs (omp.sh / in-repo `docs/`), the Agent Client Protocol spec (agentclientprotocol.com), and the T3 Code repo (`github.com/pingdotgg/t3code`). Anything not verifiable from those sources is flagged **UNVERIFIED**.

## Verdict (short version)

Feasible, with two viable integration surfaces:

1. **`--mode acp`** — standards-based ACP **v1** over JSON-RPC 2.0/stdio. Full baseline plus several optional methods (`session/load`, `session/resume`, `session/list`, `session/close`, fork, set-mode, config options). Best if the GUI wants to be agent-agnostic.
2. **`--mode rpc` / `--mode rpc-ui`** — omp-native NDJSON protocol over stdio. Substantially richer than ACP: mid-turn steering, queue modes, model/thinking control, compaction/retry control, branching, subagent streams, host tools, and (with `rpc-ui`) extension UI/permission prompts. Best if the GUI is omp-specific.

Both are documented; the RPC docs name `docs/rpc.md` + `rpc-types.ts` "the canonical wire contract" and the protocol has version negotiation — but neither surface is explicitly marketed as a frozen public API, and the release cadence is very fast (multiple patch releases per day in the v18.0.x series), so a wrapper should pin and test against specific versions. License is MIT: driving as a subprocess and bundling the binary are both permitted with attribution.

The T3 Code pattern transfers cleanly: provider driver/adapter split, native-event normalization into one canonical event stream, deferred-based permission bridge, one session-context per thread. With omp the vendor-SDK shim disappears — you spawn `omp` and speak ACP or the NDJSON RPC directly.

---

## 1. RPC modes

### 1.1 Transport and wire format

`omp --mode rpc` runs the coding agent as a **newline-delimited JSON (NDJSON / JSONL)** server over stdio: commands and extension UI responses go in on `stdin`; a `ready` frame, command responses, session events, extension UI requests, host-tool/URI requests, and subagent frames come out on `stdout` [`docs/rpc.md` lines 1–8; `packages/coding-agent/src/modes/rpc/rpc-mode.ts` lines 1–12]. `omp --mode rpc-ui` is the same transport with the additional `ExtensionUIContext` enabled, so the host must answer `extension_ui_request` frames [`docs/rpc.md` line 199; `packages/coding-agent/src/cli/args.ts` line 23; `packages/coding-agent/src/main.ts` lines 1508, 1819].

The wire envelope is plain JSON objects, **not** JSON-RPC 2.0:

- **Inbound command**: `{ id?: string, type: "<command>", … }` [`packages/coding-agent/src/modes/rpc/rpc-types.ts` lines 19–131].
- **Outbound response**: `{ id?: string, type: "response", command: "<command>", success: boolean, data?: … }` or `{ … success: false, error: string, code?: string }` [`rpc-types.ts` lines 183–292].
- **Outbound event**: `AgentSessionEvent` objects emitted as-is; they carry a top-level `type` field [`rpc-mode.ts` lines 977–980].

### 1.2 Protocol versions and framing

The startup `ready` frame advertises protocol `1` but supports `[1, 2]`:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

[`rpc-types.ts` lines 137–143; `packages/coding-agent/src/modes/rpc/rpc-frame.ts` lines 1–21; `rpc-mode.ts` lines 734–744].

A client can opt into **v2** by sending `{ type: "negotiate_protocol", protocolVersion: 2 }`. After the success response, oversized stdout frames are split into a sequence of `rpc_chunk` frames carrying base64 segments of the original UTF-8 JSON object; clients reassemble by `chunkId`, `index`, `count`, and `byteLength` [`docs/rpc.md` lines 33–65; `rpc-frame.ts` lines 23–90; `rpc-types.ts` lines 145–149]. V1 keeps a 1 MiB per-frame ceiling and a bounded fallback for oversized output [`rpc-frame.ts` lines 1–21].

### 1.3 Commands the client can send

The full `RpcCommand` union is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts` lines 19–131. Exact command type names:

- Protocol: `negotiate_protocol`
- Prompting / turn control: `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session`
- State: `get_state`, `set_fast_mode`, `get_available_commands`, `set_todos`, `set_host_tools`, `set_host_uri_schemes`, `set_subagent_subscription`, `get_subagents`, `get_subagent_messages`
- Model: `set_model`, `cycle_model`, `get_available_models`
- Thinking: `set_thinking_level`, `cycle_thinking_level`
- Queue modes: `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`
- Compaction: `compact`, `set_auto_compaction`
- Retry: `set_auto_retry`, `abort_retry`
- Bash: `bash`, `abort_bash`
- Session: `get_session_stats`, `export_html`, `switch_session`, `branch`, `get_branch_messages`, `get_last_assistant_text`, `set_session_name`, `handoff`
- Messages: `get_messages`, `get_messages_page`
- Login: `get_login_providers`, `login`

Key semantics from the dispatch in `rpc-mode.ts`:

- `prompt` may invoke a slash command, skill, or agent turn; returns immediately and streams events [lines 1042–1088].
- `steer` and `follow_up` queue mid-turn user messages [lines 1089–1100].
- `abort` calls `session.abort({ reason: USER_INTERRUPT_LABEL })` [lines 1101–1104].
- `new_session`, `switch_session`, `branch` are handled by `handleRpcSessionChange` and return `{ cancelled: boolean }`; `branch` also returns `text` [lines 1105–1112; `rpc-types.ts` lines 231–234].
- `set_model` takes `{ provider, modelId }`; `cycle_model` rotates through scoped models [lines 1231–1260].
- `get_messages_page` returns a stable cursor-paginated snapshot when the session is not streaming/compacting [lines 1455–1482; `rpc-messages.ts`].
- `handoff` compacts and exports a handoff document; refused while streaming [lines 1436–1449].

So: **yes** — the client can send prompts, steer mid-turn (`steer`/`follow_up` with configurable queue modes), interrupt (`abort`, `abort_and_prompt`), and answer approval/permission prompts via `extension_ui_response` (see 1.5).

### 1.4 Events streamed to the client

RPC mode emits every `AgentSessionEvent` produced by `AgentSession.subscribe` plus protocol-specific side channels [`rpc-mode.ts` lines 977–980]. Event names come from two layers:

1. Core `AgentEvent` union, `packages/agent/src/types.ts` lines 864–880:
   - `agent_start`, `agent_end` (with `messages`, optional `telemetry`/`coverage`, and in `AgentSessionEvent` an extra optional `isTerminal`)
   - `turn_start`, `turn_end`
   - `message_start`, `message_update`, `message_end`
   - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`

2. Session-specific additions, `packages/coding-agent/src/session/agent-session-events.ts` lines 19–80:
   - `auto_compaction_start`, `auto_compaction_end`
   - `auto_retry_start`, `auto_retry_end`, `retry_fallback_applied`, `retry_fallback_succeeded`
   - `model_changed`, `config_warnings_changed`, `advisor_cost_changed`
   - `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`
   - `irc_message`, `notice`, `thinking_level_changed`, `goal_updated`

Additional RPC-only outbound frame categories [`docs/rpc.md` lines 67–82]:

- `extension_ui_request` — selectors, confirmations, inputs, editors, notifications, status/widgets/title/editor text [`rpc-types.ts` lines 301–352].
- `host_tool_call` / `host_tool_cancel` / `host_tool_update` / `host_tool_result` [`rpc-types.ts` lines 370–398].
- `host_uri_request` / `host_uri_cancel` / `host_uri_result` [`rpc-types.ts` lines 410–448].
- `available_commands_update` [`rpc-types.ts` lines 119–126].
- `prompt_result` [`rpc-mode.ts` lines 174–198].
- `extension_error` [`rpc-mode.ts` lines 966–970].
- `subagent_lifecycle`, `subagent_progress`, `subagent_event` (gated by `set_subagent_subscription`) [`rpc-types.ts` lines 189–201].
- Builtin side channels: `command_output`, `session_info_update`, `config_update` [`docs/rpc.md` lines 78–82; `rpc-mode.ts` lines 1053–1068].

Messages, tool calls, and thinking stream via the `message_*` / `tool_execution_*` events. **Diffs:** tool execution updates carry tool results (which for edit tools include diff information inside the tool result payloads) — but no dedicated standalone "diff" event type exists in the event union; diff presentation is a UI concern built on `tool_execution_update`/`tool_execution_end` payloads. **Usage:** token/cost data arrives via `agent_end` telemetry and `advisor_cost_changed`; in ACP mode a dedicated `usage_update` exists (§2.4).

### 1.5 Extension UI and permission handling in `rpc-ui`

With `--mode rpc-ui`, the `RpcExtensionUIContext` is installed and tool/UI requests such as `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` are emitted as `extension_ui_request` frames the host must answer with `extension_ui_response` [`rpc-types.ts` lines 301–352; `rpc-mode.ts` lines 834–955]. This is how a GUI client presents `ask`-tool pickers, permission prompts, and OAuth login flows over RPC.

### 1.6 Resume and fork over RPC

- `new_session` with optional `parentSession` (starts fresh, optionally linked) [`rpc-types.ts` line 30].
- `switch_session` (load an existing session file) [`rpc-types.ts` line 97; `rpc-mode.ts` line 1105].
- `branch` (create a branch from a prior user message entry) [`rpc-types.ts` line 98; `rpc-mode.ts` line 1105].
- `get_branch_messages`, `get_messages`, `get_messages_page` for retrieving history [`rpc-mode.ts` lines 1462–1482].

There is no single explicit "resume" command; the equivalent is `switch_session` plus the CLI's `--continue` flag at startup [`docs/rpc.md`; `docs/user-facing-packages.md` line 19].

---

## 2. ACP mode

### 2.1 Existence and version

`--mode acp` exists and is equivalent to the `acp` subcommand. Accepted CLI modes are `text | json | rpc | acp | rpc-ui` [`packages/coding-agent/src/cli/args.ts` line 23; `packages/coding-agent/src/cli/flag-tables.ts` line 124; `docs/cli-reference.md` lines 154, 200, 210]. `omp acp` speaks JSON-RPC 2.0 over stdio [`README.md` lines 494–551; `packages/coding-agent/src/modes/acp/acp-mode.ts` lines 1–58].

The implementation declares `PROTOCOL_VERSION = 1` in `packages/utils/src/acp/protocol.ts` line 13. The ACP website documents **v1 (stable)** and **v2 (draft)**; omp reports `protocolVersion: 1` in its `initialize` response and therefore targets ACP v1 [`agentclientprotocol.com/llms.txt`; `packages/coding-agent/src/modes/acp/acp-agent.ts` lines 650–651].

### 2.2 Implemented ACP methods

`AcpAgent` in `packages/coding-agent/src/modes/acp/acp-agent.ts` implements the `Agent` interface from `packages/utils/src/acp/protocol.ts`:

- `initialize` — advertises `protocolVersion: 1`, `agentInfo: { name: "oh-my-pi", title: "Oh My Pi", version: VERSION }`, auth methods (`agent`, plus `terminal` if the client advertises `auth.terminal`), and `agentCapabilities` including `loadSession: true`, `mcpCapabilities: { http, sse }`, `promptCapabilities: { embeddedContext, image }`, `sessionCapabilities: { list, fork, resume, close }` [lines 631–676].
- `authenticate` — validates `methodId` against advertised methods, returns `{}` [lines 678–688].
- `newSession` [lines 690–699], `loadSession` [702–711], `resumeSession` [731–739], `listSessions` [714–730], `closeSession` [754–761].
- `unstable_forkSession` [lines 742–752] — fork exists behind ACP's `unstable_` prefix.
- `prompt` — sends a user turn, subscribes to `AgentSessionEvent`s, resolves with `stopReason` and per-turn `Usage` [lines 820–892].
- `cancel` — aborts the in-flight turn with a bounded cleanup timeout [lines 1069–1082].
- `setSessionMode` [lines 763–771].
- `setSessionConfigOption` — currently rejects boolean config options; handles `mode`/`model`/`thinking` IDs [lines 774–816].
- `extMethod` — currently handles `speech.models.list` only [lines 1124–1127].
- `extNotification` — no-op [line 1204].

This is more than the ACP baseline: `session/load`, `session/resume`, `session/list`, `session/close`, and (unstable) fork are all optional per the spec, and omp implements them.

### 2.3 Client capabilities and routed tool I/O

The ACP client bridge in `packages/coding-agent/src/modes/acp/acp-client-bridge.ts` gates routing on capabilities advertised during `initialize`:

- `fs.readTextFile` → routes the agent's `read` tool to `fs/read_text_file` [lines 30–40].
- `fs.writeTextFile` → routes the agent's `write` tool to `fs/write_text_file` [lines 42–51].
- `terminal` → routes the agent's `bash` tool to `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` [lines 53–71].
- Permission requests are always usable and map to ACP `session/request_permission` with `allow_once` / `allow_always` / `reject_once` / `reject_always` options [lines 73–119; `packages/utils/src/acp/protocol.ts` lines 121–131].
- Form elicitation when the client advertises `elicitation.form`; URL elicitation when it advertises `elicitation.url` [`acp-agent.ts` lines 1228–1232; `docs/approval-mode.md` lines 150–152].

README mapping of omp tools to ACP routes [`README.md` lines 549–557]:

| omp tool       | ACP route                             |
| -------------- | ------------------------------------- |
| `bash`         | `terminal/create` + `terminal/output` |
| `read`         | `fs/read_text_file`                   |
| `write`        | `fs/write_text_file`                  |
| `edit`, `bash` | `session/request_permission`          |

### 2.4 Session update notifications

During a `session/prompt` turn, `AcpAgent` maps `AgentSessionEvent`s to ACP `session/update` notifications via `acp-event-mapper.ts`. Emitted `SessionUpdate` discriminators [`packages/utils/src/acp/protocol.ts` lines 321–340; `packages/coding-agent/src/modes/acp/acp-event-mapper.ts` lines 200–290]:

- `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`
- `tool_call`, `tool_call_update`
- `plan`
- `current_mode_update`
- `config_option_update`
- `available_commands_update`
- `session_info_update`
- `usage_update`

Tool-call kinds are classified as `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, or `other` [`acp-event-mapper.ts` lines 110–140].

### 2.5 Known ACP clients that work with omp

The omp README states `omp acp` is meant to be spawned by an ACP client such as **Zed**'s `"agent_servers"` config [`README.md` lines 217–219, 549]. The ACP community client list includes Zed, VS Code extensions, Neovim plugins, JetBrains, and others [agentclientprotocol.com/get-started/clients]. Whether any specific client has been _tested_ against omp is **UNVERIFIED** from primary sources beyond the Zed mention in the README.

---

## 3. Extension/hook system

omp v18.x exposes two closely related surfaces: **extensions** (`-e`/`--extension`) and **hooks** (`--hook`). They share the same Bun-based module loader; `--hook` paths load through the same pipeline as extension-capability entries [`docs/extension-loading.md` lines 65, 47–49].

### 3.1 What extensions can observe

The canonical list is the `ExtensionAPI.on(...)` overloads in `packages/coding-agent/src/extensibility/extensions/types.ts` lines 1184–1276:

- **Session lifecycle**: `session_start`, `session_before_switch`, `session_switch`, `session_before_branch`, `session_branch`, `session_before_compact`, `session.compacting`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`.
- **Agent turn lifecycle**: `before_agent_start`, `agent_start`, `agent_end`, `session_stop`, `turn_start`, `turn_end`.
- **Messages**: `message_start`, `message_update`, `message_end`.
- **Tool execution**: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call`, `tool_result`, `tool_approval_requested`, `tool_approval_resolved`.
- **Provider/model**: `before_provider_request`, `after_provider_response`, `credential_disabled`.
- **User input**: `input`, `user_bash`, `user_python`.
- **Resources/MCP**: `resources_discover`, `mcp_notification`.
- **Misc**: `auto_compaction_start/end`, `auto_retry_start/end`, `retry_fallback_applied/succeeded`, `todo_reminder`, `ttsr_triggered`, `goal_updated`.

Hook modules observe a deliberately narrower subset; hook event handlers do not get model-registry mutation, system-prompt mutation, or shutdown [`packages/coding-agent/src/extensibility/hooks/types.ts` lines 61–110, 136–143].

### 3.2 What extensions can do

The `ExtensionAPI` interface [`types.ts` lines 1299–1503] lets extensions:

- **Register tools**: `registerTool(tool)` — tools become LLM-callable.
- **Register slash commands**: `registerCommand(name, { handler })` — these are `/command` prompts, not RPC wire commands.
- **Register CLI flags**: `registerFlag(name, { type: "boolean" | "string", default? })`; read via `getFlag(name)`.
- **Register keyboard shortcuts**: `registerShortcut(...)`.
- **Register model providers**: `registerProvider(...)` including custom `streamSimple` handlers.
- **Register UI renderers/composer shapes**: `registerMessageRenderer`, `registerAssistantThinkingRenderer`, `registerComposerShape`.
- **Register file-write/delete fallbacks**: `registerFileWriteFallback`, `registerFileDeleteFallback` for sandboxed hosts.
- **Send messages/entries**: `sendMessage`, `sendUserMessage`, `appendEntry`.
- **Control session state**: `setActiveTools`, `setModel`, `setThinkingLevel`, `setServiceTier`, `setSessionName`, `compact`, `shutdown`, etc.
- **Read state**: `getActiveTools`, `getAllTools`, `getCommands`, `getSessionName`, `getContextUsage`, etc.
- **Intercept tool I/O**: `tool_call` handlers return `ToolCallEventResult` and can block/replace execution; `tool_result` handlers can modify the result [`packages/coding-agent/src/extensibility/shared-events.ts`, via the event types].

### 3.3 Can an extension add new RPC surface?

**No.** The RPC command surface is a closed union type in `packages/coding-agent/src/modes/rpc/rpc-types.ts` lines 18–82. There is no `registerRpcMethod`-style API on `ExtensionAPI`; `registerCommand` registers slash commands, not RPC wire commands. Extensions can add tools, slash commands, and host tools (via `set_host_tools` from the RPC client side), but cannot extend the fixed `RpcCommand` union. An extension needing new host-facing behavior must register a tool or slash command and have the RPC client invoke it through `prompt`/`bash` or the custom tool call path.

### 3.4 API surface locations

- Type definitions: `packages/coding-agent/src/extensibility/extensions/types.ts` (`ExtensionAPI` lines 1299–1503, `ExtensionContext` lines 455–538).
- Loader/discovery: `packages/coding-agent/src/extensibility/extensions/loader.ts`, `packages/coding-agent/src/discovery/builtin.ts`.
- CLI flag wiring: `packages/coding-agent/src/cli/flag-tables.ts` lines 209–217.
- Docs: `docs/extension-loading.md`, `docs/extensions.md`.

---

## 4. Session files

### 4.1 Format and on-disk location

Session files are **JSONL** (one JSON object per line), described as "the source of truth for how coding-agent sessions are represented, persisted, migrated, and reconstructed at runtime" [`docs/session.md` lines 1–10].

Default layout:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

[`docs/session.md` line 30; `packages/coding-agent/src/session/session-paths.ts` lines 185–194; `packages/utils/src/dirs.ts` lines 567–572]

- With `XDG_DATA_HOME` set and an existing `omp` directory, the path flattens to `$XDG_DATA_HOME/omp/sessions/...` [`dirs.ts` lines 367–372].
- `encoded-cwd` derives from the canonicalized working directory [`session-paths.ts` lines 51–89].
- Blob store (image payloads): `~/.omp/agent/blobs/<sha256>` [`docs/session.md` line 40].
- Terminal breadcrumb files: `~/.omp/agent/terminal-sessions/<terminal-id>` [`docs/session.md` lines 42–44].

### 4.2 File structure and schema

- Current files begin with a fixed-width 256-byte `type: "title"` slot, then a header, then entries [`docs/session.md` lines 58–62].
- The logical first entry is the session header (`type: "session"`, `version: 3`) [`docs/session.md` lines 65–84; `packages/coding-agent/src/session/session-entries.ts` line 8].
- Remaining entries are append-only `SessionEntry` values; branch navigation moves a `leafId` pointer rather than mutating entries [`docs/session.md` lines 86–88].

`SessionEntry` union [`session-entries.ts` lines 120–145; `docs/session.md` lines 90–303]:

- `message` — stores an `AgentMessage` directly.
- `thinking_level_change`, `model_change`, `service_tier_change`
- `compaction`, `branch_summary`, `reset_boundary`
- `custom` — opaque extension/core records (e.g. `tool_execution_start`, `session_exit`, `user_todo_edit`, `vibe-session-lifecycle`, `autoresearch-control`).
- `custom_message` — extension-provided message that participates in LLM context.
- `label`, `title_change`, `ttsr_injection`, `credential_pin`, `session_init`, `mode_change`.

Header fields include `id`, `timestamp`, `cwd`, `title`, `titleSource`, `additionalDirectories`, `previousSessionFiles`, `providerPromptCacheKey`, `parentSession` [`docs/session.md` lines 70–84].

### 4.3 Direct reading by third-party apps

**Yes** — a third-party app can read/list sessions directly without running omp:

- `SessionManager.list(cwd)` and `SessionManager.continueRecent(cwd)` are public SDK helpers [`docs/sdk.md` lines 130–134].
- Session files are ordinary JSONL; docs explicitly say "Use session files for conversation graph/state replay" [`docs/session.md` line 304].
- Listing helpers cache parsed headers keyed on file stat identity (`mtime` + `size`), so repeated reads are efficient [`packages/coding-agent/CHANGELOG.md` line 1484].

### 4.4 Stability guarantees

- `CURRENT_SESSION_VERSION = 3` in `session-entries.ts` line 8; migrations for older versions live in `packages/coding-agent/src/session/session-migrations.ts` [`docs/session.md` line 19].
- The format is documented in detail, but **no explicit long-term freeze or semver stability guarantee** for the JSONL schema was found. It is a versioned, migrated internal format that is documented — treat direct parsing as compatible-until-bumped, and prefer `SessionManager` helpers or RPC `get_messages*` where possible.

---

## 5. Multi-instance behavior

### 5.1 No central broker for sessions

omp is one engine behind four independent entry points — TUI, one-shot (`-p`), RPC, ACP [`README.md` lines 494–497]. Each `omp` process is a standalone agent session. There is **no** central broker multiplexing processes into shared sessions; concurrent processes coordinate through shared on-disk resources.

### 5.2 Shared state and coordination mechanisms

1. **SQLite databases with busy timeouts.** `agent.db`, `history.db`, `stats.db` are session-critical. "Headless hosts (print/RPC/ACP/eval/SDK) now use a 1s SQLite `busy_timeout` for the session-critical databases … so lock contention no longer freezes the protocol loop" [`packages/coding-agent/CHANGELOG.md` lines 1231–1232]. Concurrent processes in the same project do contend on these databases; the busy timeout is the coordination mechanism.

2. **Session-file "single-writer" convention.** Comments in `render-cli.ts` and `session-loader.ts` refer to "takes the single-writer lock" / "does NOT create a writer or take the session lock" [`packages/coding-agent/src/cli/render-cli.ts` lines 11–12; `packages/coding-agent/src/session/session-loader.ts` line 426]. However, `FileSessionStorageWriter.openWriter()` just opens the JSONL with `fs.openSync(fpath, "a" | "w")` [`packages/coding-agent/src/session/session-storage.ts` lines 99–118]; no OS-level lock (e.g. `flock`) on the session JSONL was found. **UNVERIFIED**: whether "single-writer lock" refers to an OS lock or a process-local in-memory guarantee. Practical implication: avoid driving the same `session.jsonl` from two processes at once — one RPC process per session.

3. **Git repo lock.** `packages/coding-agent/src/utils/repo-lock.ts` serializes git mutations per repository root via an in-process write chain — protects VCS mutations within a process, not session data, and not across processes.

4. **`hub` tool process supervision.** The `hub` tool's process supervision _is_ shared across omp instances in a project: "the first process op starts a detached broker over a private socket under `~/.omp/run/daemons/<project-hash>/`; every omp instance in the project shares names, logs, and state. After the last omp process exits, the broker stops non-persistent processes and exits" [`docs/tools/hub.md` lines 140–146]. This covers `hub start`/`stop`/`logs`-supervised processes only, not omp sessions themselves.

5. **Agent registry (intra-process only).** "For multiple concurrent top-level sessions in one process, pass a private `AgentRegistry` to each session. The default process-global registry admits only one `"Main"` identity per generation" [`docs/sdk.md` lines 120–123]. Per-process restriction; a GUI spawning one child process per session is unaffected.

### 5.3 Port usage

RPC/ACP modes use **stdio**, not TCP [`docs/rpc.md` lines 1–3; `README.md` lines 537–538, 549–551]. The optional auth broker/gateway expose HTTP ports but are credential-vault services, not the session runtime [`docs/auth-broker-gateway.md` lines 7–10].

### 5.4 Implications for a desktop app managing many sessions

- Model each concurrent session as a separate `omp --mode rpc` / `omp acp` subprocess. They are independent except for shared SQLite databases and the shared `hub` daemon.
- Never drive the same session file from two processes concurrently (no OS-level lock found).
- SQLite contention is mitigated by `busy_timeout` but heavy concurrency can still stall.
- `~/.omp/run/daemons/<project-hash>/` and `~/.omp/agent/sessions/` are shared per user/project; session listing can be done straight from disk.

---

## 6. Stability and license

### 6.1 License

The monorepo is **MIT** [`LICENSE` lines 1–21]: "Permission is hereby granted, free of charge, to any person obtaining a copy … to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software." Copyright: Mario Zechner (2025), Can Bölük (2025–2026), Stencil Labs, Inc. (2026).

Implications: driving omp as a subprocess is permitted; bundling/redistributing the binary is permitted with the MIT notice; no trademark rights granted.

### 6.2 Are rpc/acp public, stable surfaces?

- The CLI reference lists `--mode <mode>` with values `text`, `json`, `rpc`, `acp`, `rpc-ui` as "Output/transport mode" [`docs/cli-reference.md` lines 153–154].
- The README presents them as one of four documented entry points: "Same engine, four wrappers … `omp --mode rpc` and `omp acp` hand the wheel to another program over stdio" [`README.md` lines 494–497].
- RPC: "this document and `rpc-types.ts` remain the canonical wire contract" [`docs/rpc.md` line 879], with version negotiation (v1 default, v2 opt-in chunked transport) [`docs/rpc.md` lines 22–49].
- ACP: implements the external Agent Client Protocol standard over JSON-RPC [`README.md` lines 549–551; `github.com/agentclientprotocol/agent-client-protocol`].
- **But** the docs never use "stable" or "public API" for these modes. Version negotiation + a named canonical contract is stronger than a purely internal surface, short of a guarantee.

### 6.3 Release cadence and breaking-change history

- Current version `18.0.11` [`packages/coding-agent/package.json` line 4]; SemVer-like numbering.
- Cadence is very fast: e.g. 18.0.11 (2026-08-29), 18.0.10 (2026-08-28), 18.0.9 (2026-08-28), 18.0.8 (2026-08-27) — often multiple patch releases per day [`packages/coding-agent/CHANGELOG.md`].
- v18.0.0 breaking changes include removal of `git`/`github` CLI helpers in favor of `@oh-my-pi/pi-natives/vcs` [`CHANGELOG.md` lines 823–835]; a session-directory bucket-format change in 17.2.5–17.2.8 was reverted in 17.2.9 [`docs/session.md` lines 34–38]; auth-broker SQLite snapshot schema has versioned changes [`docs/auth-broker-gateway.md` lines 114–118].
- The CHANGELOG contains many RPC/ACP **fixes/additions** (ACP `session_busy` JSON-RPC error, ACP `read` tool-call locations, RPC subagent frames, RPC UI select descriptions) but no breaking-change entry dedicated to the RPC/ACP wire protocol.

### 6.4 Bottom line

Documented and usable, versioned at the wire level, not explicitly frozen. A wrapper should pin to a tested omp version and gate upgrades behind protocol smoke tests.

---

## 7. The T3 Code wrapping pattern

### 7.1 How T3 Code controls Claude Code

T3 Code wraps Claude Code **in-process through Anthropic's `@anthropic-ai/claude-agent-sdk` package** — not via ACP, not by hand-spawning the `claude` CLI.

Evidence:

- `apps/server/package.json` depends on `"@anthropic-ai/claude-agent-sdk": "^0.3.170"` as a runtime dependency ([`apps/server/package.json` L25](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/package.json#L25)).
- The workspace strips the SDK's bundled platform binaries because T3 always resolves the user's own Claude executable ([`pnpm-workspace.yaml` L91–L98](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/pnpm-workspace.yaml#L91-L98)).
- The Claude driver is registered as `claudeAgent`, managing the npm package `@anthropic-ai/claude-code` ([`apps/server/src/provider/Drivers/ClaudeDriver.ts` L74–L78](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Drivers/ClaudeDriver.ts#L74-L78)).
- `ClaudeExecutable.ts` resolves `binaryPath` into a value the SDK can spawn directly: _"The SDK spawns the given path without a shell"_ ([`apps/server/src/provider/Drivers/ClaudeExecutable.ts` L17–L27](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Drivers/ClaudeExecutable.ts#L17-L27)).
- `ClaudeAdapter.ts` imports `query` and SDK message types; its doc comment: _"wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic provider adapter contract"_ ([`apps/server/src/provider/Layers/ClaudeAdapter.ts` L3–L7, L20–L21](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3-L21)).

Layering: **T3 server → Claude Agent SDK → spawned `claude` executable**. The exact byte protocol between SDK and binary is **UNVERIFIED** from the T3 repo; the SDK hides it behind `query(...)` and `SDKMessage` types.

### 7.2 Sessions, streaming, tool calls, permissions

- Every provider sits behind a common `ProviderAdapterShape`: `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `stopSession`, `listSessions`, `hasSession`, `readThread`, `rollbackThread`, `stopAll`, plus a `streamEvents` output ([`apps/server/src/provider/Services/ProviderAdapter.ts` L47–L110](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Services/ProviderAdapter.ts#L47-L110)).
- `makeClaudeAdapter` keeps a `sessions: Map<ThreadId, ClaudeSessionContext>` and a runtime event queue; each session gets its own `ClaudeQueryRuntime` from `createQuery(...)` ([`ClaudeAdapter.ts` L1680–L1700, L4349–L4363](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1680-L1700)).
- `runSdkStream` pulls from `context.query` (the SDK's `AsyncIterable<SDKMessage>`) and converts native messages into canonical runtime events via `handleSdkMessage` ([`ClaudeAdapter.ts` L3299–L3613](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3299-L3612)). Handled native types: `stream_event`, `user`, `assistant`, `result`, `system`, `tool_progress`, `tool_use_summary`, `auth_status`, `rate_limit_event`.
- Tool permissions surface through the SDK's `CanUseTool` callback: `canUseToolEffect` emits a `request.opened` runtime event with a generated `requestId`, stores a pending `Deferred`, and awaits the UI decision via `respondToRequest`, translating back into `PermissionResult` of `allow`/`deny`/`cancelled` ([`ClaudeAdapter.ts` L4074–L4233](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4074-L4233)). The same path handles `AskUserQuestion` via `user-input.requested` + `respondToUserInput` ([L3806–L3992](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3806-L3992)).
- Per the architecture docs, clients never call a provider directly; they dispatch orchestration commands, and a server-side reactor invokes the provider ([`docs/internals/providers.md`](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/docs/internals/providers.md)).

### 7.3 Multiple concurrent Claude instances

Two levels:

1. `ProviderInstanceRegistry` builds a `Map<ProviderInstanceId, ProviderInstance>` from settings; settings changes tear down and rebuild the affected scope ([`apps/server/src/provider/Services/ProviderInstanceRegistry.ts` L1–L30](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Services/ProviderInstanceRegistry.ts#L1-L30)).
2. `ProviderAdapterRegistry` resolves `instanceId` → live adapter; inside `ClaudeAdapter.ts` each `threadId` owns one `ClaudeSessionContext` with its own `ClaudeQueryRuntime` created in `startSession` ([`apps/server/src/provider/Services/ProviderAdapterRegistry.ts` L1–L40](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Services/ProviderAdapterRegistry.ts#L1-L40); [`ClaudeAdapter.ts` startSession L3806–L4495](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3806-L4495)).

**UNVERIFIED**: whether the Claude Agent SDK spawns one OS process per `query()` or multiplexes over a long-lived process. T3 closes each query runtime independently (`context.query.close()`), consistent with one runtime per session, but SDK internals aren't visible in the repo.

### 7.4 Transferred lessons for wrapping omp

Applies essentially unchanged:

- **Provider driver/adapter split** — driver kind registration, separate instance/adapter registries, threads routed through a provider-agnostic `ProviderAdapterShape`. The orchestration/event-sourced layer is not Claude-specific.
- **Native-event normalization** — translating the wrapped agent's wire events into one canonical event stream is the same problem for Claude SDK messages, ACP `session/update`, or omp RPC frames.
- **Permission bridge pattern** — suspend tool execution via callback/deferred → emit UI event → resume with the user's decision; independent of whether the trigger is `CanUseTool` or ACP `session/request_permission`.
- **One session context per thread** — `Map<ThreadId, SessionContext>` with per-thread prompt queues, pending approvals, in-flight tool maps.

Differs with omp:

- **No vendor-SDK shim.** Spawn `omp` as a subprocess and speak ACP or the NDJSON RPC directly — similar to T3's own `effect-acp` package, which wraps an ACP agent over stdio with JSON-RPC ([`packages/effect-acp/src/client.ts` L1–L83](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/packages/effect-acp/src/client.ts#L1-L83); [`packages/effect-acp/src/protocol.ts` L1–L123](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/packages/effect-acp/src/protocol.ts#L1-L123)). Claude-specific executable resolution and SDK message-mapping code is unnecessary.
- **Lifecycle methods differ.** ACP: `session/new`, `session/prompt`, `session/update` notifications; v1 returns `stopReason` in the `session/prompt` response, v2 (draft) acks immediately and reports completion via `state_update`. omp RPC: `prompt` returns immediately and completion arrives via `agent_end`/`turn_end` events and `prompt_result`.
- **Permission wire shape differs.** ACP: agent-initiated `session/request_permission` with `options` (`allow_once`/`allow_always`/…), client returns an `outcome`. omp RPC: `extension_ui_request`/`extension_ui_response` frames. T3's `request.opened`/`request.resolved` runtime events remain a useful UI abstraction over either.
- **Process/session model.** With ACP stdio, one agent subprocess can host multiple sessions (omp advertises `loadSession`, `list`, `resume`, `fork`, `close` capabilities — consistent with multi-session per process). Confirm per-process session limits before copying T3's one-runtime-per-thread model. With omp's RPC mode, one process = one session (switchable via `switch_session`), so a GUI would spawn one process per concurrent session.
- **Richer mid-turn control than Claude SDK.** omp RPC's `steer`/`follow_up`/queue-mode commands have no direct analog in T3's Claude adapter (`sendTurn`/`interruptTurn` only); a GUI wrapping omp can expose steering UX that T3 cannot with Claude.

Note: T3 Code currently wraps Codex, Claude Code, Cursor, Grok Build, and OpenCode ([`t3code/README.md` L1–L20](https://github.com/pingdotgg/t3code/blob/2daff8c25adf701fddd062ae93b94cc57d420ec2/README.md)) — omp is not a supported backend there.

---

## Appendix: ACP wire format

### Transport

JSON-RPC 2.0 over stdio by default. The client launches the agent as a subprocess; agent reads JSON-RPC from `stdin`, writes to `stdout`. Messages are newline-delimited and **MUST NOT** contain embedded newlines; `stderr` is reserved for logging; agents must not write non-ACP data to `stdout` ([v1 transports](https://agentclientprotocol.com/protocol/v1/transports), [v2 transports](https://agentclientprotocol.com/protocol/v2/transports)). V2 additionally follows JSON-RPC 2.0 batch rules, though lifecycle-sensitive messages (`initialize`, `auth/login`, `session/new`, `session/resume`, `session/prompt`) should not be batched ([v2 transports#json-rpc-batch-messages](https://agentclientprotocol.com/protocol/v2/transports#json-rpc-batch-messages)).

### Core agent methods

- `initialize` — negotiate protocol version and capabilities ([v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization)).
- `authenticate` (v1) / `auth/login` (v2).
- `session/new`, `session/prompt`, `session/cancel` (notification).
- Optional: `session/load` (v1), `session/resume` (v2), `session/list`, `session/close`, `session/delete`, `session/set_mode`, `session/set_config_option`, `logout` ([v1 overview](https://agentclientprotocol.com/protocol/v1/overview), [v2 overview](https://agentclientprotocol.com/protocol/v2/overview)).

### Core client methods

- `session/request_permission` — authorize a tool call.
- `fs/read_text_file`, `fs/write_text_file` (v1 only; removed in v2).
- `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`, `terminal/kill` (v1 only; removed in v2).
- `elicitation/create`, `elicitation/complete` notification.
- `session/update` notification — the main agent→client streaming channel ([v1 overview](https://agentclientprotocol.com/protocol/v1/overview), [v2 overview](https://agentclientprotocol.com/protocol/v2/overview)).

### `session/update` shapes

Tagged union discriminated by `sessionUpdate`. Common v1 variants: `agent_message_chunk`, `user_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` (statuses `pending`/`in_progress`/`completed`/`failed`), `plan`, `available_commands_update`, `config_option_update`, `session_info_update`, `usage_update` ([v1 prompt-turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)).

V2 changes: `tool_call` removed (first `tool_call_update` creates the call), `plan` → `plan_update`, `state_update` added (foreground state `running`/`idle`/`requires_action` + stop reasons), whole-message upserts (`user_message`, `agent_message`, `agent_thought`) added alongside chunk variants ([v2 migration#sessionupdate-variant-changes](https://agentclientprotocol.com/protocol/v2/migration#sessionupdate-variant-changes)).

### Permission-request flow

1. Agent sends `session/request_permission` with `sessionId`, a `toolCall` update object, and `options` (`allow_once`, `allow_always`, `reject_once`, `reject_always`).
2. Client returns a `RequestPermissionOutcome`: `{ "outcome": "cancelled" }` or `{ "outcome": "selected", "optionId": "allow-once" }`.
3. If the turn is cancelled while pending, the client **MUST** respond `{ "outcome": "cancelled" }` ([v1 tool-calls#requesting-permission](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)).

### Versioning

Single integer `protocolVersion` negotiated during `initialize`; incremented only for breaking changes, non-breaking additions go through capabilities. Client sends its latest supported version; agent responds with that or its own latest; mismatch → disconnect ([v1 initialization#protocol-version](https://agentclientprotocol.com/protocol/v1/initialization#protocol-version), [v2 migration#version-negotiation](https://agentclientprotocol.com/protocol/v2/migration#version-negotiation)). Current stable spec is **ACP v1**; **v2 is draft** as of the July 20, 2026 announcement and should be feature-gated ([updates](https://agentclientprotocol.com/updates), [acp-v2-draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)).

---

## Source list

### omp (`github.com/can1357/oh-my-pi`, docs at omp.sh; cloned locally for source reads)

- `README.md` — four entry points (L494–497), RPC/ACP summaries and tool-route table (L494–557), Zed mention (L217–219).
- `LICENSE` — MIT.
- `docs/rpc.md` — RPC wire protocol, framing, version negotiation, canonical-contract statement (L879).
- `docs/cli-reference.md` — mode table and `acp` subcommand (L153–210).
- `docs/approval-mode.md` — ACP approval/elicitation (L127–153).
- `docs/session.md` — session JSONL format, layout, entry taxonomy, migrations.
- `docs/sdk.md` — in-process SDK, `AgentRegistry` (L120–123), `SessionManager.list/continueRecent` (L130–134).
- `docs/extension-loading.md`, `docs/extensions.md` — extension/hook loading.
- `docs/tools/hub.md` — shared process-supervision broker (L140–146).
- `docs/auth-broker-gateway.md` — optional credential services (L7–10, 114–118).
- `packages/coding-agent/package.json` (v18.0.11), `packages/coding-agent/CHANGELOG.md` (cadence, breaking changes, busy_timeout fix L1231–1232, header-cache note L1484).
- `packages/coding-agent/src/modes/rpc/` — `rpc-mode.ts` (dispatch, event subscription), `rpc-types.ts` (`RpcCommand`/`RpcResponse`/UI/host/URI/subagent frames), `rpc-frame.ts` (v1/v2 framing), `rpc-messages.ts` (pagination).
- `packages/coding-agent/src/modes/acp/` — `acp-mode.ts`, `acp-agent.ts` (`AcpAgent` methods, initialize response), `acp-client-bridge.ts` (capability-gated fs/terminal/permission routing), `acp-event-mapper.ts` (event → `session/update` mapping).
- `packages/utils/src/acp/protocol.ts` — ACP v1 types, `PROTOCOL_VERSION = 1` (L13).
- `packages/coding-agent/src/extensibility/extensions/types.ts` — `ExtensionAPI` (L1299–1503), event overloads (L1184–1276), `ExtensionContext` (L455–538); `packages/coding-agent/src/extensibility/hooks/types.ts` (L61–110, 136–143); `packages/coding-agent/src/extensibility/shared-events.ts`.
- `packages/coding-agent/src/session/` — `session-entries.ts` (`CURRENT_SESSION_VERSION = 3`), `session-paths.ts`, `session-storage.ts`, `session-loader.ts`, `session-migrations.ts`; `packages/utils/src/dirs.ts`.
- `packages/agent/src/types.ts` L864–880 — core `AgentEvent` union.
- `packages/coding-agent/src/session/agent-session-events.ts` L19–80 — session-level event additions.
- `packages/coding-agent/src/cli/` — `args.ts` L23 (Mode union), `flag-tables.ts` L124, L209–217, `render-cli.ts` L11–12; `packages/coding-agent/src/main.ts` (mode routing).
- `packages/coding-agent/src/utils/repo-lock.ts` — per-repo git write chain.

### Agent Client Protocol

- `agentclientprotocol.com` — `/protocol/v1/overview`, `/protocol/v1/transports`, `/protocol/v1/initialization`, `/protocol/v1/prompt-turn`, `/protocol/v1/tool-calls`, `/protocol/v2/overview`, `/protocol/v2/transports`, `/protocol/v2/migration`, `/updates`, `/announcements/acp-v2-draft`, `/get-started/clients`, `/llms.txt`.
- JSON schema release: `github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json` (`ProtocolVersion` uint16).

### T3 Code (`github.com/pingdotgg/t3code`, commit `2daff8c25adf701fddd062ae93b94cc57d420ec2`)

- `apps/server/package.json`, `pnpm-workspace.yaml`, `README.md`.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`, `ClaudeExecutable.ts`.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`.
- `apps/server/src/provider/Services/ProviderAdapter.ts`, `ProviderInstanceRegistry.ts`, `ProviderAdapterRegistry.ts`.
- `docs/internals/providers.md`.
- `packages/effect-acp/src/client.ts`, `packages/effect-acp/src/protocol.ts`.

## UNVERIFIED items (could not be confirmed from primary sources)

1. The exact byte protocol between Anthropic's Claude Agent SDK and the `claude` binary (hidden inside the SDK; not visible in the T3 repo).
2. Whether the Claude Agent SDK spawns one OS process per `query()` or multiplexes sessions over one long-lived process.
3. Whether any specific ACP client (beyond the omp README's Zed configuration mention) has been tested against `omp acp`.
4. Whether omp's session-file "single-writer lock" comments refer to an OS-level lock or a process-local guarantee — no `flock`-style locking was found in session storage code.
5. Any explicit long-term stability/freeze guarantee for the session JSONL schema or the rpc/acp wire surfaces (docs call `rpc-types.ts` canonical and provide version negotiation, but never say "stable public API").
