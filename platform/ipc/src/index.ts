export { createIpcClient } from "./client";
export type { IpcClient, IpcSessionHandle } from "./client";

export { tauriBridge } from "./bridge/tauri";
export { BridgeCommandError } from "./bridge/shell-bridge";
export type { ShellBridge, BrowserShellBridge } from "./bridge/shell-bridge";

export * from "./session/session";

export { Transcript } from "./session/transcript";
export type {
  TranscriptEntry,
  TranscriptSnapshot,
  UserMessageEntry,
  AssistantMessageEntry,
  ThinkingEntry,
  ToolExecutionEntry,
  ToolExecutionStatus,
  NoticeEntry,
  NoticeLevel,
  TranscriptImage,
  DiffLine,
  DiffLineKind,
  FileDiff,
} from "./session/transcript";

export { createSessionsStore } from "./session/sessions-store";
export type { SessionsStore, SessionStatus, SessionSummary } from "./session/sessions-store";

export type {
  OmpStartInfo,
  OmpBinarySource,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
  BrowserInfo,
  BrowserError,
  RelayInfo,
} from "./bindings/bindings.gen";

export {
  SubagentsStore,
  SubagentTracker,
  getSubagentTracker,
} from "./session/subagents";
export type {
  SubagentSummary,
  SubagentStatus,
  SubagentProgress,
  SubagentStreamEntry,
  SubagentMessageEntry,
  SubagentThinkingEntry,
  SubagentToolEntry,
  SubagentToolStatus,
  SubagentNoticeEntry,
} from "./session/subagents";
