/**
 * Node stdio transport: spawns an omp binary directly. Used by the seam tests
 * (and future smoke suites, ADR-0008) to drive the session core against the
 * real pinned binary — never imported by the app bundle.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ShellBridge, OmpStartInfo } from "./shell-bridge";
import type { OmpFrameEvent, OmpExitEvent } from "../bindings/bindings.gen";

interface Session {
  child: ChildProcess;
  cleanup: () => void;
}

export function nodeBridge(binaryPath: string, cwd: string): ShellBridge {
  const sessions = new Map<string, Session>();
  const frameHandlers = new Set<(e: OmpFrameEvent) => void>();
  const exitHandlers = new Set<(e: OmpExitEvent) => void>();

  const emitFrame = (sessionId: string, line: string) => {
    const event: OmpFrameEvent = { sessionId, line };
    for (const handler of frameHandlers) handler(event);
  };

  const emitExit = (sessionId: string, code: number) => {
    const event: OmpExitEvent = { sessionId, code };
    for (const handler of exitHandlers) handler(event);
  };

  return {
    start(): Promise<OmpStartInfo> {
      const sessionId = randomUUID();
      const version = execFileSync(binaryPath, ["--version"], {
        encoding: "utf8",
      }).trim();
      const child = spawn(binaryPath, ["--mode", "rpc-ui"], {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
      });

      if (!child.stdin || !child.stdout) {
        throw new Error("failed to pipe omp stdio");
      }

      const reader = createInterface({ input: child.stdout });
      const onLine = (line: string) => emitFrame(sessionId, line);
      reader.on("line", onLine);

      const onExit = (code: number | null) => {
        emitExit(sessionId, code ?? 0);
        sessions.delete(sessionId);
      };
      child.on("exit", onExit);

      const cleanup = () => {
        reader.off("line", onLine);
        child.off("exit", onExit);
      };

      sessions.set(sessionId, { child, cleanup });

      return Promise.resolve({
        sessionId,
        version,
        path: binaryPath,
        source: "override",
      });
    },

    send(sessionId, line): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        return Promise.reject(new Error(`unknown session ${sessionId}`));
      }
      if (!session.child.stdin) {
        return Promise.reject(new Error(`stdin closed for session ${sessionId}`));
      }
      session.child.stdin.write(`${line}\n`);
      return Promise.resolve();
    },

    kill(sessionId): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        return Promise.reject(new Error(`unknown session ${sessionId}`));
      }
      session.cleanup();
      session.child.kill();
      sessions.delete(sessionId);
      return Promise.resolve();
    },

    onFrame(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },

    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
}
