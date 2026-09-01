/**
 * ADR-0008 protocol smoke suite: drives the REAL pinned omp binary over
 * stdin/stdout NDJSON via `nodeBridge` + `createIpcClient` + the raw
 * `RpcSession` API (`session.command(...)` / `options.onEvent`), exactly like
 * `session/session.test.ts`'s seam test -- never a mock, never a higher-level
 * helper. This is the gate docs/adr/0008-weekly-pin-bump-smoke-gate.md wires
 * into CI: green here (plus a clean `tsc`) is what makes a weekly pin-bump PR
 * auto-mergeable.
 *
 * Checklist covered, one `it` per item (see ADR-0008 and issue #4):
 *   1. framing + protocol-v2 negotiation
 *   2. a prompt round trip from `agent_start` to `agent_end`
 *   3. a mid-turn `steer`
 *   4. `abort`
 *   5. `abort_and_prompt`
 *   6. host-tool registration -> `host_tool_call` -> `host_tool_result`
 *   7. `extension_ui_request` -> `extension_ui_response` (via the built-in
 *      `ask` tool -- the same "ask-tool picker" the v1 spec's user story #16
 *      asks the app to render natively)
 *   8. subagent frame subscription (`set_subagent_subscription`)
 *
 * Items 2-8 need a live model turn. omp itself is never mocked, but there is
 * no way to make the *model* deterministic without one, so those cycles are
 * skipped when no provider credential is present in the environment. CI
 * supplies `ANTHROPIC_API_KEY` as a secret; local runs pick up whatever omp
 * itself would use (the same env-var fallback omp's own auth layer checks).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type {
  RpcExtensionUIResponse,
  RpcHostToolResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { nodeBridge } from "../bridge/node";
import type { ShellBridge } from "../bridge/shell-bridge";
import { createIpcClient, type IpcSessionHandle } from "../client";
import type { RpcEventFrame } from "./session";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/** Env vars omp's own auth layer resolves a provider from with zero config. */
const LIVE_MODEL_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

function hasLiveModelCredential(): boolean {
  return LIVE_MODEL_CREDENTIAL_ENV_VARS.some((name) => Boolean(process.env[name]?.trim()));
}

interface PendingWait {
  matches: (frame: RpcEventFrame) => boolean;
  settle: (frame: RpcEventFrame) => void;
  fail: (error: Error) => void;
}

/**
 * Records every frame `RpcSessionOptions.onEvent` delivers and lets a test
 * await the next one matching a predicate. `waitFor` only ever looks at
 * frames recorded *after* it is called -- never history -- so two sequential
 * waits for the same predicate (e.g. two turns each ending in `agent_end`)
 * can never both resolve off the same earlier frame. Callers register a
 * wait, then send the command that causes it, exactly like `RpcSession`
 * itself registers its `ready`/response listeners before acting.
 *
 * `waitFor`'s `timeoutMs` is a failure bound on a live external system (a
 * real model turn), not a substitute for awaiting the real event: the actual
 * synchronization is `record` notifying the `pending` waiters below. Without
 * the bound, a genuine wire-protocol regression would hang the suite forever
 * instead of failing with a readable message.
 */
class EventRecorder {
  private readonly seen: RpcEventFrame[] = [];
  private readonly pending = new Set<PendingWait>();

  record(frame: RpcEventFrame): void {
    this.seen.push(frame);
    for (const wait of [...this.pending]) {
      if (wait.matches(frame)) wait.settle(frame);
    }
  }

  all(predicate: (frame: RpcEventFrame) => boolean): RpcEventFrame[] {
    return this.seen.filter(predicate);
  }

  waitFor(
    predicate: (frame: RpcEventFrame) => boolean,
    description: string,
    timeoutMs = 60_000,
  ): Promise<RpcEventFrame> {
    const { promise, resolve, reject } = Promise.withResolvers<RpcEventFrame>();
    const wait: PendingWait = {
      matches: predicate,
      settle: (frame) => {
        this.pending.delete(wait);
        clearTimeout(timer);
        resolve(frame);
      },
      fail: (error) => {
        this.pending.delete(wait);
        clearTimeout(timer);
        reject(error);
      },
    };
    const timer = setTimeout(
      () => wait.fail(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)),
      timeoutMs,
    );
    this.pending.add(wait);
    return promise;
  }

  /** Fails every still-pending `waitFor` call. Used once a session tears down. */
  dispose(reason: string): void {
    for (const wait of [...this.pending]) wait.fail(new Error(reason));
  }
}

/** Concatenates every `text` block from every assistant message in a run. */
function extractAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (!("role" in message) || message.role !== "assistant") continue;
    if (!("content" in message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (!("type" in block) || block.type !== "text") continue;
      if (!("text" in block) || typeof block.text !== "string") continue;
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

interface HostToolCall {
  id: string;
  toolName: string;
  echo: unknown;
}

/** Narrows a `host_tool_call` frame to the fields this suite reads, or `undefined` if it doesn't match. */
function asHostToolCall(frame: RpcEventFrame): HostToolCall | undefined {
  if (frame.type !== "host_tool_call") return undefined;
  if (typeof frame.id !== "string" || typeof frame.toolName !== "string") return undefined;
  const args = frame.arguments;
  if (!args || typeof args !== "object" || !("echo" in args)) return undefined;
  return { id: frame.id, toolName: frame.toolName, echo: args.echo };
}

interface SelectRequest {
  id: string;
  options: unknown[];
}

/** Narrows a `select`-method `extension_ui_request` frame, or `undefined` if it doesn't match. */
function asSelectRequest(frame: RpcEventFrame): SelectRequest | undefined {
  if (frame.type !== "extension_ui_request" || frame.method !== "select") return undefined;
  if (typeof frame.id !== "string" || !Array.isArray(frame.options)) return undefined;
  return { id: frame.id, options: frame.options };
}

interface SubagentLifecycle {
  id: string;
  status: string;
}

/** Narrows a `subagent_lifecycle` frame's payload, or `undefined` if it doesn't match. */
function asSubagentLifecycle(frame: RpcEventFrame): SubagentLifecycle | undefined {
  if (frame.type !== "subagent_lifecycle") return undefined;
  const payload = frame.payload;
  if (!payload || typeof payload !== "object") return undefined;
  if (!("id" in payload) || typeof payload.id !== "string") return undefined;
  if (!("status" in payload) || typeof payload.status !== "string") return undefined;
  return { id: payload.id, status: payload.status };
}

/** True when a `subagent_event` frame's payload id matches the given subagent. */
function isSubagentEventFor(frame: RpcEventFrame, subagentId: string): boolean {
  if (frame.type !== "subagent_event") return false;
  const payload = frame.payload;
  return Boolean(
    payload && typeof payload === "object" && "id" in payload && payload.id === subagentId,
  );
}

interface SmokeSession {
  handle: IpcSessionHandle;
  bridge: ShellBridge;
  events: EventRecorder;
}

/** Spawns a fresh pinned-binary session, wires an `EventRecorder`, and tears everything down afterward. */
async function withSession(run: (session: SmokeSession) => Promise<void>): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "omp-gui-smoke-"));
  const bridge = nodeBridge(binary, sandbox);
  const events = new EventRecorder();
  const client = createIpcClient(bridge);
  let handle: IpcSessionHandle | undefined;
  try {
    handle = await client.startSession({ onEvent: (frame) => events.record(frame) });
    await run({ handle, bridge, events });
  } finally {
    events.dispose("the session was torn down before this event arrived");
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore cleanup failures
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("protocol smoke suite (ADR-0008)", () => {
  // Checklist item 1: framing + protocol-v2 negotiation. No model involved.
  it("negotiates protocol v2 from the ready frame and answers a canned command", async () => {
    await withSession(async ({ handle }) => {
      expect(handle.session.ready.type).toBe("ready");
      expect(handle.session.ready.supportedProtocolVersions).toContain(2);
      expect(handle.session.protocolVersion).toBe(2);

      const response = await handle.session.command({ type: "get_state" });
      expect(response.type).toBe("response");
      expect(response.command).toBe("get_state");
      expect(response.success).toBe(true);
    });
  }, 30_000);

  describe.skipIf(!hasLiveModelCredential())(
    "live-model cycles (needs ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY)",
    () => {
      // Checklist item 2.
      it("completes a prompt round trip from agent_start to agent_end", async () => {
        await withSession(async ({ handle, events }) => {
          const agentEnded = events.waitFor(
            (frame) => frame.type === "agent_end",
            "agent_end after prompt",
          );
          await handle.session.command({
            type: "prompt",
            message:
              "Do not call any tools. Reply with exactly the single word PONG and nothing else.",
          });

          expect(extractAssistantText((await agentEnded).messages)).toContain("PONG");
        });
      }, 90_000);

      // Checklist item 3.
      it("delivers a mid-turn steer message into the running turn", async () => {
        await withSession(async ({ handle, events }) => {
          const turnStarted = events.waitFor(
            (frame) => frame.type === "turn_start",
            "turn_start for the long count",
          );
          await handle.session.command({
            type: "prompt",
            message:
              "Do not call any tools. Count from 1 to 60, one number per line, and do not stop until told otherwise.",
          });
          await turnStarted;

          const agentEnded = events.waitFor(
            (frame) => frame.type === "agent_end",
            "agent_end after steer",
          );
          await handle.session.command({
            type: "steer",
            message:
              "Stop counting immediately. Your entire next reply must be exactly the single word STEERED.",
          });

          expect(extractAssistantText((await agentEnded).messages)).toContain("STEERED");
        });
      }, 120_000);

      // Checklist item 4.
      it("aborts an in-flight turn before it runs to completion", async () => {
        await withSession(async ({ handle, events }) => {
          const turnStarted = events.waitFor(
            (frame) => frame.type === "turn_start",
            "turn_start for the long count",
          );
          await handle.session.command({
            type: "prompt",
            message:
              "Do not call any tools. Count from 1 to 60, one number per line, and do not stop until told otherwise.",
          });
          await turnStarted;

          const agentEnded = events.waitFor(
            (frame) => frame.type === "agent_end",
            "agent_end after abort",
          );
          await handle.session.command({ type: "abort" });

          expect(extractAssistantText((await agentEnded).messages)).not.toContain("60");
        });
      }, 90_000);

      // Checklist item 5.
      it("aborts an in-flight turn and immediately starts a fresh prompt", async () => {
        await withSession(async ({ handle, events }) => {
          const turnStarted = events.waitFor(
            (frame) => frame.type === "turn_start",
            "turn_start for the long count",
          );
          await handle.session.command({
            type: "prompt",
            message:
              "Do not call any tools. Count from 1 to 60, one number per line, and do not stop until told otherwise.",
          });
          await turnStarted;

          const newRunStarted = events.waitFor(
            (frame) => frame.type === "agent_start",
            "agent_start for the replacement prompt",
          );
          await handle.session.command({
            type: "abort_and_prompt",
            message:
              "Ignore everything above. Reply with exactly the single word RESTARTED and nothing else.",
          });
          await newRunStarted;

          const newRunEnded = await events.waitFor(
            (frame) => frame.type === "agent_end",
            "agent_end for the replacement prompt",
          );
          const text = extractAssistantText(newRunEnded.messages);
          expect(text).toContain("RESTARTED");
          expect(text).not.toContain("60");
        });
      }, 120_000);

      // Checklist item 6.
      it("registers a host tool and completes a call/result cycle", async () => {
        await withSession(async ({ handle, bridge, events }) => {
          await handle.session.command({
            type: "set_host_tools",
            tools: [
              {
                name: "omp_gui_smoke_probe",
                description:
                  "Test-only host tool for the omp-gui protocol smoke suite. Returns the `echo` argument " +
                  "prefixed with 'ack:'.",
                parameters: {
                  type: "object",
                  properties: {
                    echo: { type: "string", description: "Text for the host to echo back." },
                  },
                  required: ["echo"],
                  additionalProperties: false,
                },
                loadMode: "essential",
              },
            ],
          });

          const called = events.waitFor(
            (frame) => asHostToolCall(frame) !== undefined,
            "host_tool_call for omp_gui_smoke_probe",
          );
          await handle.session.command({
            type: "prompt",
            message:
              'Call the tool named "omp_gui_smoke_probe" exactly once, right now, with {"echo": "ping"}. Do not ' +
              "call any other tool first. After you get its result, reply with exactly the text it returned and " +
              "nothing else.",
          });

          const call = asHostToolCall(await called);
          if (!call) throw new Error("expected a host_tool_call frame");
          expect(call.toolName).toBe("omp_gui_smoke_probe");
          expect(call.echo).toBe("ping");

          const agentEnded = events.waitFor(
            (frame) => frame.type === "agent_end",
            "agent_end after host tool cycle",
          );
          const result: RpcHostToolResult = {
            type: "host_tool_result",
            id: call.id,
            result: { content: [{ type: "text", text: "ack:ping" }] },
          };
          await bridge.send(handle.info.sessionId, JSON.stringify(result));

          expect(extractAssistantText((await agentEnded).messages)).toContain("ack:ping");
        });
      }, 120_000);

      // Checklist item 7.
      it("resolves an extension-ui select request raised by the ask tool", async () => {
        await withSession(async ({ handle, bridge, events }) => {
          const asked = events.waitFor(
            (frame) => asSelectRequest(frame) !== undefined,
            "extension_ui_request from the ask tool",
          );
          await handle.session.command({
            type: "prompt",
            message:
              "Before doing anything else, ask the user a multiple-choice question using your interactive ask " +
              'tool (tool name "ask"; if it is not directly callable, look it up via tool search or invoke it ' +
              'through "write" with path "xd://ask"). Ask exactly one question titled "Continue?" with exactly ' +
              'two options, in order: "Yes" and "No". Wait for the answer. If the answer is "Yes", reply with ' +
              "exactly the single word CONTINUED and nothing else. Otherwise reply with exactly the single word " +
              "STOPPED and nothing else.",
          });

          const request = asSelectRequest(await asked);
          if (!request) throw new Error("expected a select extension_ui_request frame");
          expect(request.options).toContain("Yes");
          expect(request.options).toContain("No");

          const agentEnded = events.waitFor(
            (frame) => frame.type === "agent_end",
            "agent_end after extension-ui cycle",
          );
          const response: RpcExtensionUIResponse = {
            type: "extension_ui_response",
            id: request.id,
            value: "Yes",
          };
          await bridge.send(handle.info.sessionId, JSON.stringify(response));

          expect(extractAssistantText((await agentEnded).messages)).toContain("CONTINUED");
        });
      }, 120_000);

      // Checklist item 8.
      it("streams subagent lifecycle frames for a spawned task", async () => {
        await withSession(async ({ handle, events }) => {
          await handle.session.command({ type: "set_subagent_subscription", level: "events" });

          const started = events.waitFor(
            (frame) => asSubagentLifecycle(frame) !== undefined,
            "subagent_lifecycle started",
          );
          await handle.session.command({
            type: "prompt",
            message:
              'Use your task tool to spawn exactly one subagent (agent: "task") with the assignment "Reply with ' +
              'the single word done and stop.". Wait for it to finish, then reply with exactly the single word ' +
              "FINISHED and nothing else.",
          });

          const startPayload = asSubagentLifecycle(await started);
          if (!startPayload) throw new Error("expected a subagent_lifecycle frame");
          expect(startPayload.status).toBe("started");
          const subagentId = startPayload.id;

          const finished = await events.waitFor(
            (frame) => {
              const payload = asSubagentLifecycle(frame);
              return (
                payload !== undefined && payload.id === subagentId && payload.status !== "started"
              );
            },
            "terminal subagent_lifecycle",
            90_000,
          );
          const finishedPayload = asSubagentLifecycle(finished);
          if (!finishedPayload) throw new Error("expected a subagent_lifecycle frame");
          expect(finishedPayload.status).not.toBe("started");

          const sawChildEvent =
            events.all((frame) => isSubagentEventFor(frame, subagentId)).length > 0;
          expect(sawChildEvent).toBe(true);
        });
      }, 150_000);
    },
  );
});
