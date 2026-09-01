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

export { ApprovalInbox, ApprovalRegistry, getApprovalRegistry } from "./session/approvals";
export type {
  ApprovalAnswer,
  ApprovalInboxSnapshot,
  ApprovalRequest,
  PendingApproval,
} from "./session/approvals";
export { createSteeringController } from "./session/steering";
export type {
  QueueDrainMode,
  QueueModes,
  SteeringController,
  SteeringInterruptMode,
  SteeringPending,
  SteeringSnapshot,
} from "./session/steering";

export type {
  OmpStartInfo,
  OmpBinarySource,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
  BrowserInfo,
  BrowserError,
  RelayInfo,
  SessionFileEntry,
  SessionsError,
  ForeignLockProbe,
  SessionPreview,
  SessionPreviewMessage,
} from "./bindings/bindings.gen";

export { createSessionDirectory } from "./session/session-directory";
export type { SessionDirectory, SessionOwnership, ResumeResult } from "./session/session-directory";
export {
  createModelSelection,
  EMPTY_MODEL_SELECTION_SNAPSHOT,
  THINKING_LEVELS,
} from "./session/models";
export type {
  ModelSelection,
  ModelSelectionSnapshot,
  SessionModel,
  SessionThinkingLevel,
} from "./session/models";
export { SubagentsStore, SubagentTracker, getSubagentTracker } from "./session/subagents";
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
