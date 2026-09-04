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
  ChromiumInstallEvent,
  ChromiumInstallPhase,
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
export { createLoginController, EMPTY_LOGIN_SNAPSHOT } from "./session/login";
export type {
  LoginController,
  LoginProvider,
  LoginSnapshot,
  OAuthUrlElicitation,
} from "./session/login";

export {
  createAppPreferencesController,
  DEFAULT_APP_PREFERENCES,
  EMPTY_APP_PREFERENCES_SNAPSHOT,
} from "./preferences/app-preferences";
export type {
  AppPreferencesController,
  AppPreferencesSnapshot,
  AppPreferencesStatus,
} from "./preferences/app-preferences";
export type { AppPreferences, PreferencesError, Theme } from "./bindings/bindings.gen";

export { createSettingsController, EMPTY_SETTINGS_SNAPSHOT } from "./settings/settings-controller";
export type {
  SettingsController,
  SettingsSnapshot,
  SettingsStatus,
  RowState,
} from "./settings/settings-controller";
export { serializeConfigValue } from "./settings/serialize";
export type { ConfigEntry, ConfigSchema, SchemaTab, SchemaEntry, SchemaCondition, JsonValue, CliError, CliStage } from "./bindings/bindings.gen";
