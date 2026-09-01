/**
 * Real-binary seam test for the approval inbox (T4, issue #5): drives the
 * REAL pinned omp binary (never mocked, same discipline as `session.test.
 * ts`/`sessions-store.test.ts`/`smoke.test.ts`) through a prompt that makes
 * it call its built-in `ask` tool, which raises a `select`-method
 * `extension_ui_request` (protocol.md §4.4) — the same trigger `smoke.
 * test.ts`'s checklist item 7 already relies on for the raw protocol round
 * trip. This suite instead exercises this ticket's own layers on top of
 * it: `ApprovalInbox` queuing/answering directly, and `ApprovalRegistry`/
 * `SessionsStore.setPendingApprovals` for the sidebar-badge wiring.
 *
 * Skipped without a live model credential, exactly like `smoke.test.ts` —
 * triggering `ask` depends on the model actually deciding to call it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient } from "../client";
import { nodeBridge } from "../bridge/node";
import { createSessionsStore } from "./sessions-store";
import { ApprovalInbox, getApprovalRegistry } from "./approvals";
import type { RpcEventFrame } from "./session";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/** Env vars omp's own auth layer resolves a provider from with zero
 * config — the same list `smoke.test.ts` gates its live-model suite on. */
const LIVE_MODEL_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

function hasLiveModelCredential(): boolean {
  return LIVE_MODEL_CREDENTIAL_ENV_VARS.some((name) => Boolean(process.env[name]?.trim()));
}

/** The exact prompt `smoke.test.ts` checklist item 7 already verified
 * reliably makes the model call `ask` with a two-option question. */
const ASK_PROMPT =
  "Before doing anything else, ask the user a multiple-choice question using your interactive ask " +
  'tool (tool name "ask"; if it is not directly callable, look it up via tool search or invoke it ' +
  'through "write" with path "xd://ask"). Ask exactly one question titled "Continue?" with exactly ' +
  'two options, in order: "Yes" and "No". Wait for the answer. If the answer is "Yes", reply with ' +
  "exactly the single word CONTINUED and nothing else. Otherwise reply with exactly the single word " +
  "STOPPED and nothing else.";

/** Concatenates every `text` block from every assistant message in a run —
 * same narrowing `smoke.test.ts` uses to read back the model's reply. */
function extractAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || !("role" in message)) continue;
    if (message.role !== "assistant" || !("content" in message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text")
        continue;
      if ("text" in block && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Resolves once `predicate(snapshot())` is true, re-checking on every
 * `subscribe` notification rather than polling on a fixed interval — same
 * event-driven shape as `sessions-store.test.ts`'s `waitForStore`,
 * generalized over any `subscribe`/`snapshot` pair (an `ApprovalInbox`, a
 * `SessionsStore`, or the small frame recorder below). The timeout is a
 * real `setTimeout`: this drives a real subprocess over real stdio, so a
 * genuinely hung wait can only be caught by a wall-clock bound.
 */
function waitFor<T>(
  subscribe: (listener: () => void) => () => void,
  snapshot: () => T,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 60_000,
): Promise<T> {
  const initial = snapshot();
  if (predicate(initial)) return Promise.resolve(initial);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`));
  }, timeoutMs);
  const unsubscribe = subscribe(() => {
    const value = snapshot();
    if (!predicate(value)) return;
    clearTimeout(timer);
    unsubscribe();
    resolve(value);
  });
  return promise;
}

/** Records every frame `RpcSession.onEvent` delivers and lets a test await
 * a predicate over the accumulated list — the minimal piece of `smoke.
 * test.ts`'s `EventRecorder` this suite needs. */
function recordEvents(session: {
  onEvent: (handler: (frame: RpcEventFrame) => void) => () => void;
}): {
  seen: RpcEventFrame[];
  subscribe: (listener: () => void) => () => void;
} {
  const seen: RpcEventFrame[] = [];
  const listeners = new Set<() => void>();
  session.onEvent((frame) => {
    seen.push(frame);
    for (const listener of listeners) listener();
  });
  return {
    seen,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe.skipIf(!hasLiveModelCredential())(
  "approval inbox against the pinned omp binary (needs ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, " +
    "OPENAI_API_KEY, or GEMINI_API_KEY)",
  () => {
    let sandbox: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;

    afterEach(async () => {
      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // ignore cleanup failures
        }
        cleanup = undefined;
      }
      if (sandbox) rmSync(sandbox, { recursive: true, force: true });
      sandbox = undefined;
    });

    it("queues the ask tool's extension_ui_request and resumes the agent once answered", async () => {
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-approvals-test-"));
      const bridge = nodeBridge(binary, sandbox);
      const client = createIpcClient(bridge);
      const handle = await client.startSession();
      cleanup = () => handle.close();

      const inbox = new ApprovalInbox(handle.session);
      const recorder = recordEvents(handle.session);

      await handle.session.command({ type: "prompt", message: ASK_PROMPT });

      const queued = await waitFor(
        inbox.subscribe,
        inbox.getSnapshot,
        (snapshot) => snapshot.length > 0,
        "the ask tool's extension_ui_request to queue",
      );
      const pending = queued[0];
      if (!pending || pending.request.method !== "select") {
        throw new Error(`expected a queued select request, got ${JSON.stringify(pending)}`);
      }
      expect(pending.request.title).toBe("Continue?");
      expect(pending.request.options).toEqual(["Yes", "No"]);
      expect(inbox.getCount()).toBe(1);

      inbox.answer(pending.request.id, { method: "select", value: "Yes" });

      // The queue drops the answered request immediately — it does not
      // wait for the agent to actually resume before updating.
      expect(inbox.getSnapshot()).toEqual([]);
      expect(inbox.getCount()).toBe(0);

      await waitFor(
        recorder.subscribe,
        () => recorder.seen.filter((frame) => frame.type === "agent_end"),
        (ends) => ends.length > 0,
        "agent_end after the extension-ui cycle",
      );
      const lastEnd = recorder.seen.filter((frame) => frame.type === "agent_end").at(-1) as
        | { messages: unknown }
        | undefined;
      if (!lastEnd) throw new Error("expected an agent_end frame");
      expect(extractAssistantText(lastEnd.messages)).toContain("CONTINUED");
    }, 120_000);

    it("badges the session in SessionsStore.list() while the request is pending, via ApprovalRegistry", async () => {
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-approvals-test-"));
      const bridge = nodeBridge(binary, sandbox);
      const client = createIpcClient(bridge);
      const store = createSessionsStore(client);
      const id = store.createSession();
      cleanup = () => store.closeSession(id);

      await waitFor(
        store.subscribe,
        () => store.getSession(id),
        (session) => session !== undefined,
        "the session's RpcSession to become available",
      );

      const registry = getApprovalRegistry(store);
      const session = store.getSession(id);
      if (!session) throw new Error("expected a live RpcSession");
      await session.command({ type: "prompt", message: ASK_PROMPT });

      await waitFor(
        store.subscribe,
        () => store.list().find((summary) => summary.id === id)?.pendingApprovals ?? 0,
        (count) => count === 1,
        "SessionsStore to badge the pending approval",
      );

      const inbox = registry.getInbox(id);
      if (!inbox) throw new Error("expected ApprovalRegistry to have adopted the session's inbox");
      const [pending] = inbox.getSnapshot();
      if (!pending) throw new Error("expected a queued request");
      inbox.answer(pending.request.id, { method: "select", value: "No" });

      await waitFor(
        store.subscribe,
        () => store.list().find((summary) => summary.id === id)?.pendingApprovals ?? 0,
        (count) => count === 0,
        "SessionsStore to clear the badge after answering",
      );
    }, 120_000);
  },
);
