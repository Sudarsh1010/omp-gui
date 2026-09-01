import { describe, expect, it } from "vite-plus/test";
import { createIpcClient } from "./client";
import {
  BridgeCommandError,
  type ShellBridge,
  type OmpStartInfo,
  type OmpFrameEvent,
  type OmpExitEvent,
} from "./bridge/shell-bridge";

class FakeShellBridge implements ShellBridge {
  private sessionCounter = 0;
  private frameHandlers = new Set<(e: OmpFrameEvent) => void>();
  private exitHandlers = new Set<(e: OmpExitEvent) => void>();
  readonly killed = new Set<string>();
  readonly sent = new Map<string, string[]>();

  start(): Promise<OmpStartInfo> {
    const sessionId = `fake-session-${++this.sessionCounter}`;
    const info: OmpStartInfo = {
      sessionId,
      version: "0.0.0",
      path: "/fake/omp",
      source: "override",
    };
    this.sent.set(sessionId, []);
    return new Promise((resolve) => {
      setImmediate(() => {
        resolve(info);
        queueMicrotask(() => {
          this.emitFrame(
            sessionId,
            JSON.stringify({
              type: "ready",
              supportedProtocolVersions: [1, 2],
              maxReassembledFrameBytes: 100_000,
            }),
          );
        });
      });
    });
  }

  async send(sessionId: string, line: string): Promise<void> {
    const lines = this.sent.get(sessionId);
    if (!lines) {
      throw new Error(`unknown session ${sessionId}`);
    }
    lines.push(line);
    const cmd = JSON.parse(line) as Record<string, unknown>;
    if (cmd.type === "negotiate_protocol") {
      this.emitFrame(
        sessionId,
        JSON.stringify({
          type: "response",
          id: cmd.id,
          success: true,
          command: "negotiate_protocol",
        }),
      );
    }
  }

  async kill(sessionId: string): Promise<void> {
    if (!this.sent.has(sessionId)) {
      throw new Error(`unknown session ${sessionId}`);
    }
    this.killed.add(sessionId);
    this.sent.delete(sessionId);
  }

  onFrame(handler: (e: OmpFrameEvent) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onExit(handler: (e: OmpExitEvent) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  emitFrame(sessionId: string, line: string): void {
    const event: OmpFrameEvent = { sessionId, line };
    for (const handler of this.frameHandlers) handler(event);
  }

  emitExit(sessionId: string, code: number): void {
    const event: OmpExitEvent = { sessionId, code };
    for (const handler of this.exitHandlers) handler(event);
  }
}

describe("createIpcClient", () => {
  it("demultiplexes frames to the correct session", async () => {
    const bridge = new FakeShellBridge();
    const client = createIpcClient(bridge);

    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];

    const handleA = await client.startSession({
      onEvent: (frame) => eventsA.push(frame),
    });
    const handleB = await client.startSession({
      onEvent: (frame) => eventsB.push(frame),
    });

    bridge.emitFrame(handleA.info.sessionId, JSON.stringify({ type: "test_event", side: "A" }));
    bridge.emitFrame(handleB.info.sessionId, JSON.stringify({ type: "test_event", side: "B" }));

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ type: "test_event", side: "A" });
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]).toMatchObject({ type: "test_event", side: "B" });

    await handleA.close();
    await handleB.close();
  });

  it("kills the subprocess and drops late frames on close", async () => {
    const bridge = new FakeShellBridge();
    const client = createIpcClient(bridge);

    const eventsA: unknown[] = [];
    const handleA = await client.startSession({
      onEvent: (frame) => eventsA.push(frame),
    });

    await handleA.close();

    expect(bridge.killed.has(handleA.info.sessionId)).toBe(true);

    bridge.emitFrame(handleA.info.sessionId, JSON.stringify({ type: "late_event" }));

    expect(eventsA).toHaveLength(0);
  });

  it("ignores frames for unknown session ids", async () => {
    const bridge = new FakeShellBridge();
    const client = createIpcClient(bridge);

    const eventsA: unknown[] = [];
    const handleA = await client.startSession({
      onEvent: (frame) => eventsA.push(frame),
    });

    bridge.emitFrame("unknown-session", JSON.stringify({ type: "ghost" }));
    bridge.emitFrame(handleA.info.sessionId, JSON.stringify({ type: "real_event" }));

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ type: "real_event" });

    await handleA.close();
  });
});

describe("BridgeCommandError", () => {
  it("carries the BridgeError payload", () => {
    const error = { type: "binaryNotFound", message: "missing" } as const;
    const err = new BridgeCommandError(error);
    expect(err.error).toEqual(error);
    expect(err.message).toContain("binaryNotFound");
  });
});
