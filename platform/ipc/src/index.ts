export { createIpcClient } from "./client";
export type { IpcClient, IpcSessionHandle } from "./client";

export { tauriBridge } from "./bridge/tauri";
export { BridgeCommandError } from "./bridge/shell-bridge";
export type { ShellBridge } from "./bridge/shell-bridge";

export * from "./session/session";

export type {
  OmpStartInfo,
  OmpBinarySource,
  BridgeError,
  OmpFrameEvent,
  OmpExitEvent,
} from "./bindings/bindings.gen";
