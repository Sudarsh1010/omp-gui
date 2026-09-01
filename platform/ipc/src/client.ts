import { RpcSession, type RpcTransport, type RpcSessionOptions } from "./session/session";
import type { OmpStartInfo } from "./bindings/bindings.gen";
import type { ShellBridge } from "./bridge/shell-bridge";

export interface IpcClient {
  /** Start a session's subprocess. `options` attaches an event sink; `cwd`
   * sets the subprocess working directory (a resume passes the target
   * session's recorded cwd so omp's `switch_session` cwd guard accepts it).
   * Both default: no sink, bridge-default directory. */
  startSession(options?: RpcSessionOptions, cwd?: string): Promise<IpcSessionHandle>;
}

export interface IpcSessionHandle {
  info: OmpStartInfo;
  session: RpcSession;
  close(): Promise<void>;
}

export function createIpcClient(bridge: ShellBridge): IpcClient {
  const sessions = new Map<
    string,
    {
      lines: Set<(line: string) => void>;
      exits: Set<() => void>;
    }
  >();

  bridge.onFrame((event) => {
    const handlers = sessions.get(event.sessionId);
    if (!handlers) return;
    for (const handler of handlers.lines) handler(event.line);
  });

  bridge.onExit((event) => {
    const handlers = sessions.get(event.sessionId);
    if (!handlers) return;
    for (const handler of handlers.exits) handler();
  });

  return {
    async startSession(options?: RpcSessionOptions, cwd?: string): Promise<IpcSessionHandle> {
      const info = await bridge.start(cwd);
      const handlersFor = (sessionId: string) => {
        let handlers = sessions.get(sessionId);
        if (!handlers) {
          handlers = { lines: new Set(), exits: new Set() };
          sessions.set(sessionId, handlers);
        }
        return handlers;
      };

      const transport: RpcTransport = {
        send: (line) => {
          void bridge.send(info.sessionId, line);
        },
        onLine: (handler) => {
          const handlers = handlersFor(info.sessionId);
          handlers.lines.add(handler);
          return () => {
            handlers.lines.delete(handler);
          };
        },
        onExit: (handler) => {
          const handlers = handlersFor(info.sessionId);
          handlers.exits.add(handler);
          return () => {
            handlers.exits.delete(handler);
          };
        },
      };

      const session = await RpcSession.start(transport, options);

      return {
        info,
        session,
        async close() {
          session.close();
          sessions.delete(info.sessionId);
          await bridge.kill(info.sessionId);
        },
      };
    },
  };
}
