/**
 * Node stdio transport: spawns an omp binary directly. Used by the seam tests
 * (and future smoke suites, ADR-0008) to drive the session core against the
 * real pinned binary — never imported by the app bundle.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RpcTransport } from "./session-core";

export interface NodeOmpProcess {
  transport: RpcTransport;
  child: ChildProcess;
}

export function spawnOmp(binaryPath: string, cwd: string): NodeOmpProcess {
  const child = spawn(binaryPath, ["--mode", "rpc-ui"], {
    cwd,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { stdin, stdout } = child;
  if (!stdin || !stdout) {
    throw new Error("failed to pipe omp stdio");
  }

  const lineHandlers = new Set<(line: string) => void>();
  const exitHandlers = new Set<() => void>();

  createInterface({ input: stdout }).on("line", (line) => {
    for (const handler of lineHandlers) handler(line);
  });
  child.on("exit", () => {
    for (const handler of exitHandlers) handler();
  });

  const transport: RpcTransport = {
    send: (line) => {
      stdin.write(`${line}\n`);
    },
    onLine: (handler) => {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
  return { transport, child };
}
