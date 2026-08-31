# omp-gui

An omp-native desktop app that wraps `omp --mode rpc-ui` (never forks it) and adds computer use and browser use as first-class visual surfaces the TUI cannot have.

## Language

**Session**:
One `omp --mode rpc-ui` subprocess and the single omp session it hosts. One process = one session; concurrency means multiple subprocesses.
_Avoid_: thread, conversation, tab
**Shell Bridge**:
The Tauri command/event channel between the app and the Rust shell (`omp_start`, `omp_send`, `omp_kill`; `omp:frame`, `omp:exit`). It carries rpc-ui frames opaquely — the shell never parses them. Typed via specta-generated bindings.
_Avoid_: IPC (overloaded — includes the rpc-ui protocol that rides through the bridge)

**Host Tool**:
A tool the app registers with a session via `set_host_tools`, executed by the app (not omp) when omp issues a `host_tool_call`. The mechanism behind computer use and browser use.

**Browser Use**:
Agent control of a web browser surfaced as a live pane in the app. The v1 computer-use story.

**Browser Pane**:
The app's live view of the agent-driven, app-owned Chromium, fed by CDP screencast frames. The user watches the agent work here and can take over.
_Avoid_: webview, embedded browser

**Takeover**:
User input forwarded through the pane into the agent-driven browser via CDP input dispatch, e.g. to clear an auth gate. A designed path, not an escape hatch.

**Relay**:
omp's mode for driving the user's real Chrome (with their existing logins) via the browser-relay extension. Exposed in the app as a per-task toggle for auth-heavy flows.

**Computer Use**:
Agent observation and control of the user's machine beyond the browser — screen capture and synthesized input. Broader than browser use; carries OS permission and security cost.

**Approval**:
A permission prompt surfaced from omp as an `extension_ui_request` frame and answered by the app with `extension_ui_response`.
_Avoid_: permission dialog, confirmation popup
