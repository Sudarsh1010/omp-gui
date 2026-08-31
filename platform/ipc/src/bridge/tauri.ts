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
    onFrame: (handler) => {
      const pending = events.ompFrame.listen((event) => handler(event.payload));
      return () => {
        pending
          .then((unlisten) => {
            unlisten();
          })
          .catch(() => {});
      };
    },
    onExit: (handler) => {
      const pending = events.ompExit.listen((event) => handler(event.payload));
      return () => {
        pending
          .then((unlisten) => {
            unlisten();
          })
          .catch(() => {});
      };
    },
  };
}
