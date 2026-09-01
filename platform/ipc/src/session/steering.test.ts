/**
 * Seam 1 from the v1 spec (see `session.test.ts`/`smoke.test.ts`): drives
 * the T5 `SteeringController` against the REAL pinned omp binary over
 * stdin/stdout NDJSON via `nodeBridge` + `createIpcClient` — omp is never
 * mocked. Queue-mode get/set needs no model call and always runs; steer/
 * follow_up/abort_and_prompt need a live turn to act on, so — exactly like
 * `smoke.test.ts` — those cycles are skipped without a provider credential
 * in the environment (CI supplies `ANTHROPIC_API_KEY`; local runs pick up
 * whatever omp itself would use).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import { createIpcClient, type IpcSessionHandle } from "../client";
import type { RpcEventFrame } from "./session";
import { createSteeringController, type SteeringController } from "./steering";

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

// Inlined at its one call site below (`describe.skipIf`) rather than named:
// see that call for the specific env vars checked.

interface PendingWait {
  matches: (frame: RpcEventFrame) => boolean;
  settle: (frame: RpcEventFrame) => void;
  fail: (error: Error) => void;
}

/**
 * Records every frame `RpcSessionOptions.onEvent` delivers and lets a test
 * await the next one matching a predicate. Same shape as `smoke.test.ts`'s
 * `EventRecorder`, duplicated rather than imported so this seam test has no
 * cross-test-file coupling (see that file for the full reasoning).
 */
class EventRecorder {
  private readonly pending = new Set<PendingWait>();

  record(frame: RpcEventFrame): void {
    for (const wait of [...this.pending]) {
      if (wait.matches(frame)) wait.settle(frame);
    }
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
    // This bound is a *failure* bound on a live external system (a real
    // model turn or subprocess round trip), not a substitute for awaiting
    // the real event — the actual synchronization is `record` notifying the
    // `pending` waiters above. Without it, a genuine wire-protocol
    // regression would hang the suite forever instead of failing readably.
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

/**
 * True when `frame` is a `message_start` for a `role: "user"` message whose
 * text content includes `needle` — a landed steer/follow-up shows up on the
 * wire as exactly this (protocol.md §2.2: `attribution: "user"`, never
 * `synthetic`), so this is how the suite observes "a new user/steer entry"
 * independently of `agent_end`'s eventual reply.
 */
function isUserMessageContaining(frame: RpcEventFrame, needle: string): boolean {
  if (frame.type !== "message_start") return false;
  const message = frame.message;
  if (!message || typeof message !== "object") return false;
  if (!("role" in message) || message.role !== "user") return false;
  if (!("content" in message) || !Array.isArray(message.content)) return false;
  return message.content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      block.text.includes(needle),
  );
}

/** Resolves once `controller`'s snapshot is `ready` (hydrated from its
 * constructor's own `get_state` call), or immediately if it already is. */
function waitForReady(controller: SteeringController, timeoutMs = 15_000): Promise<void> {
  if (controller.getSnapshot().ready) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Failure bound on the live subprocess's own `get_state` round trip, not
  // a substitute for awaiting it — see `EventRecorder.waitFor` above for
  // the full reasoning.
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`timed out after ${timeoutMs}ms waiting for the controller to become ready`));
  }, timeoutMs);
  const unsubscribe = controller.subscribe(() => {
    if (!controller.getSnapshot().ready) return;
    clearTimeout(timer);
    unsubscribe();
    resolve();
  });
  return promise;
}

interface SteeringSession {
  handle: IpcSessionHandle;
  events: EventRecorder;
  controller: SteeringController;
}

/** Spawns a fresh pinned-binary session, wires an `EventRecorder` and a
 * `SteeringController` over it, and tears everything down afterward. */
async function withSteeringSession(
  run: (session: SteeringSession) => Promise<void>,
): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "omp-gui-steering-test-"));
  const bridge = nodeBridge(binary, sandbox);
  const events = new EventRecorder();
  const client = createIpcClient(bridge);
  let handle: IpcSessionHandle | undefined;
  let controller: SteeringController | undefined;
  try {
    handle = await client.startSession({ onEvent: (frame) => events.record(frame) });
    controller = createSteeringController(handle.session);
    await run({ handle, events, controller });
  } finally {
    controller?.dispose();
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

describe("SteeringController queue modes (no live model needed)", () => {
  it("hydrates ready + queueModes + queuedMessageCount from get_state on construction", async () => {
    await withSteeringSession(async ({ controller }) => {
      await waitForReady(controller);
      expect(controller.getSnapshot()).toMatchObject({
        ready: true,
        queueModes: {
          steeringMode: "all",
          followUpMode: "all",
          interruptMode: "immediate",
        },
        queuedMessageCount: 0,
      });
    });
  }, 30_000);

  it("setSteeringMode/setFollowUpMode/setInterruptMode update the snapshot and the server's own state", async () => {
    await withSteeringSession(async ({ handle, controller }) => {
      await controller.setSteeringMode("all");
      await controller.setFollowUpMode("all");
      await controller.setInterruptMode("wait");

      expect(controller.getSnapshot().queueModes).toEqual({
        steeringMode: "all",
        followUpMode: "all",
        interruptMode: "wait",
      });

      // Confirm the server agrees — not just this controller's optimistic copy.
      const response = await handle.session.command({ type: "get_state" });
      expect(response.data.steeringMode).toBe("all");
      expect(response.data.followUpMode).toBe("all");
      expect(response.data.interruptMode).toBe("wait");
    });
  }, 30_000);
});

describe.skipIf(!LIVE_MODEL_CREDENTIAL_ENV_VARS.some((name) => Boolean(process.env[name]?.trim())))(
  "SteeringController against a live model turn (needs ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY)",
  () => {
    it("steer lands mid-turn: a new user/steer entry appears and streaming continues to a steered reply", async () => {
      await withSteeringSession(async ({ handle, events, controller }) => {
        const turnStarted = events.waitFor(
          (frame) => frame.type === "turn_start",
          "turn_start for the long count",
        );
        void handle.session.command({
          type: "prompt",
          message:
            "Do not call any tools. Count from 1 to 60, one number per line, and do not stop until told otherwise.",
        });
        await turnStarted;

        const steerLanded = events.waitFor(
          (frame) => isUserMessageContaining(frame, "Stop counting immediately"),
          "message_start for the steer message",
        );
        const agentEnded = events.waitFor(
          (frame) => frame.type === "agent_end",
          "agent_end after steer",
        );

        await controller.steer(
          "Stop counting immediately. Your entire next reply must be exactly the single word STEERED.",
        );

        // "a new user/steer entry": the steer text itself shows up as its own
        // message on the wire, distinct from the original prompt.
        await steerLanded;
        // "...and the agent visibly reacts": streaming continues past that
        // point to a fresh, steered reply instead of stalling or the
        // original count finishing untouched.
        const finalMessages = (await agentEnded).messages;
        expect(extractAssistantText(finalMessages)).toContain("STEERED");
        expect(extractAssistantText(finalMessages)).not.toContain("60");
      });
    }, 120_000);

    it("followUp queues behind a running turn under the selected queue mode and lands once it completes", async () => {
      await withSteeringSession(async ({ handle, events, controller }) => {
        const turnStarted = events.waitFor(
          (frame) => frame.type === "turn_start",
          "turn_start for the first reply",
        );
        void handle.session.command({
          type: "prompt",
          message:
            "Do not call any tools. Reply with exactly the single word FIRST and nothing else.",
        });
        await turnStarted;

        const followUpLanded = events.waitFor(
          (frame) => isUserMessageContaining(frame, "exactly the single word SECOND"),
          "message_start for the queued follow-up",
        );
        const agentEnded = events.waitFor(
          (frame) => frame.type === "agent_end",
          "agent_end after the queued follow-up lands",
        );

        await controller.followUp(
          "Now reply with exactly the single word SECOND and nothing else.",
          "one-at-a-time",
        );
        expect(controller.getSnapshot().queueModes.followUpMode).toBe("one-at-a-time");

        // "lands when expected": only after the running turn (FIRST) is done,
        // never interrupting it the way steer would.
        await followUpLanded;
        const text = extractAssistantText((await agentEnded).messages);
        expect(text).toContain("FIRST");
        expect(text).toContain("SECOND");
      });
    }, 120_000);

    it("abortAndPrompt cancels the running turn and starts a fresh prompt in one action", async () => {
      await withSteeringSession(async ({ handle, events, controller }) => {
        const turnStarted = events.waitFor(
          (frame) => frame.type === "turn_start",
          "turn_start for the long count",
        );
        void handle.session.command({
          type: "prompt",
          message:
            "Do not call any tools. Count from 1 to 60, one number per line, and do not stop until told otherwise.",
        });
        await turnStarted;

        const newRunStarted = events.waitFor(
          (frame) => frame.type === "agent_start",
          "agent_start for the replacement prompt",
        );

        await controller.abortAndPrompt(
          "Ignore everything above. Reply with exactly the single word RESTARTED and nothing else.",
        );

        // "one action": a single controller call both tore down the old turn
        // and started the new one — no separate abort() call from the test.
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
  },
);
