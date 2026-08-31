import { commands, events, type BridgeError } from "../bindings/bindings.gen";
import { BridgeCommandError, type ShellBridge } from "./shell-bridge";

function unwrap<T>(result: { status: "ok"; data: T } | { status: "error"; error: BridgeError }): T {
  if (result.status === "error") {
    throw new BridgeCommandError(result.error);
  }
  return result.data;
}

export function tauriBridge(): ShellBridge {
  return {
    start: () => commands.ompStart().then(unwrap),
    send: async (sessionId, line) => {
      await commands.ompSend(sessionId, line).then(unwrap);
    },
    kill: async (sessionId) => {
      await commands.ompKill(sessionId).then(unwrap);
    },
    onFrame: (handler) => subscribe(events.ompFrame, handler),
    onExit: (handler) => subscribe(events.ompExit, handler),
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
