import { commands, events } from "../bindings/bindings.gen";
import { BridgeCommandError, type BrowserShellBridge } from "./shell-bridge";

function unwrap<T, E>(result: { status: "ok"; data: T } | { status: "error"; error: E }): T {
  if (result.status === "error") {
    throw new BridgeCommandError(result.error);
  }
  return result.data;
}

export function tauriBridge(): BrowserShellBridge {
  return {
    start: (cwd) => commands.ompStart(cwd ?? null).then(unwrap),
    send: async (sessionId, line) => {
      await commands.ompSend(sessionId, line).then(unwrap);
    },
    kill: async (sessionId) => {
      await commands.ompKill(sessionId).then(unwrap);
    },
    onFrame: (handler) => subscribe(events.ompFrame, handler),
    onExit: (handler) => subscribe(events.ompExit, handler),
    browserLaunch: (projectPath) => commands.browserLaunch(projectPath).then(unwrap),
    browserStop: async (projectPath) => {
      await commands.browserStop(projectPath).then(unwrap);
    },
    browserSetRelay: (sessionId, enabled) =>
      commands.browserSetRelay(sessionId, enabled).then(unwrap),
    browserSetTakeover: async (projectPath, enabled) => {
      await commands.browserSetTakeover(projectPath, enabled).then(unwrap);
    },
    browserInstallChromium: () => commands.browserInstallChromium().then(unwrap),
    onChromiumInstallProgress: (handler) => subscribe(events.chromiumInstallProgress, handler),
    listSessionFiles: () => commands.listSessionFiles().then(unwrap),
    probeForeignSessionLock: (path) => commands.probeForeignSessionLock(path).then(unwrap),
    readSessionPreview: (path) => commands.readSessionPreview(path).then(unwrap),
  };
}
/** Events expose listen() as Promise<unlisten>; bridge handlers need a sync unsubscribe. */
function subscribe<T>(
  event: { listen: (cb: (e: { payload: T }) => void) => Promise<() => void> },
  handler: (payload: T) => void,
): () => void {
  const pending = event.listen((e) => handler(e.payload));
  return () => {
    pending
      .then((unlisten) => {
        unlisten();
      })
      .catch(() => {});
  };
}
