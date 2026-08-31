import { RpcSession, type RpcTransport, type RpcSessionOptions } from "./session/session";
import type { OmpStartInfo } from "./bindings/bindings.gen";
import type { ShellBridge } from "./bridge/shell-bridge";

export interface IpcClient {
  startSession(): Promise<IpcSessionHandle>;
}

interface IpcClientImpl extends IpcClient {
  startSession(options?: RpcSessionOptions): Promise<IpcSessionHandle>;
}

export interface IpcSessionHandle {
  info: OmpStartInfo;
  session: RpcSession;
  close(): Promise<void>;
}

export function createIpcClient(bridge: ShellBridge): IpcClientImpl {
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
    async startSession(options?: RpcSessionOptions): Promise<IpcSessionHandle> {
      const info = await bridge.start();

      const transport: RpcTransport = {
        send: (line) => {
          void bridge.send(info.sessionId, line);
        },
        onLine: (handler) => {
          let handlers = sessions.get(info.sessionId);
          if (!handlers) {
            handlers = { lines: new Set(), exits: new Set() };
            sessions.set(info.sessionId, handlers);
          }
          handlers.lines.add(handler);
          return () => {
            handlers?.lines.delete(handler);
          };
        },
        onExit: (handler) => {
          let handlers = sessions.get(info.sessionId);
          if (!handlers) {
            handlers = { lines: new Set(), exits: new Set() };
            sessions.set(info.sessionId, handlers);
          }
          handlers.exits.add(handler);
          return () => {
            handlers?.exits.delete(handler);
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
