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

export type {
  OmpStartInfo,
  OmpBinarySource,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
  BrowserInfo,
  BrowserError,
} from "./bindings/bindings.gen";
