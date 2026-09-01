/**
 * Seam test (v1 spec "two seams... 1. the pinned-binary stdio seam"): drives
 * `SubagentsStore`/`SubagentTracker` against the REAL pinned omp binary via
 * `nodeBridge`, never mocked, same discipline as `session.test.ts`/
 * `sessions-store.test.ts`/`smoke.test.ts` — omp is a fixed, local, fast
 * dependency, so mocking it would only test assumptions about the protocol
 * rather than the protocol itself.
 *
 * Two suites:
 *  - `SubagentTracker over a SessionsStore` needs no live model: it only
 *    exercises the eager-attach/singleton/cleanup wiring around session
 *    lifecycle, so it always runs.
 *  - `SubagentsStore against a spawned subagent` needs an actual model turn
 *    to decide to call the `task` tool, so it's gated behind a live model
 *    credential exactly like `smoke.test.ts`'s live-model cycles — skipped
 *    (not failed) when none is configured, in CI or locally.
 *
 * Per the assignment, this file is not run as part of completing the
 * ticket.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import { createIpcClient, type IpcSessionHandle } from "../client";
import { createSessionsStore, type SessionsStore } from "./sessions-store";
import { getSubagentTracker, SubagentsStore } from "./subagents";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/** Env vars omp's own auth layer resolves a provider from with zero config —
 * same list `smoke.test.ts` gates its live-model cycles behind. */
const LIVE_MODEL_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
] as const;

function hasLiveModelCredential(): boolean {
  return LIVE_MODEL_CREDENTIAL_ENV_VARS.some((name) => Boolean(process.env[name]?.trim()));
}

/**
 * Resolves once `predicate()` is true, re-checking on every notification
 * from `subscribe` (works for both a store's roster `subscribe` and its
 * per-subagent `subscribeStream`) — updates are event-driven, not polled on
 * a fixed interval. Rejects after `timeoutMs`, a wall-clock bound (not a
 * fake timer) because this drives a real subprocess and, in the live-model
 * suite, a real model turn.
 */
function waitForCondition(
  subscribe: (listener: () => void) => () => void,
  predicate: () => boolean,
  description: string,
  timeoutMs = 60_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const unsubscribe = subscribe(() => {
    if (!predicate()) return;
    clearTimeout(timer);
    unsubscribe();
    resolve();
  });
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`));
  }, timeoutMs);
  return promise;
}

describe("SubagentTracker over a SessionsStore", () => {
  let sandbox: string | undefined;
  let store: SessionsStore | undefined;

  afterEach(async () => {
    if (store) {
      const current = store;
      await Promise.all(current.list().map((session) => current.closeSession(session.id)));
      store = undefined;
    }
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  it("eagerly attaches a SubagentsStore once a session's RpcSession is ready, without the panel asking first, and tears it down on close", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-subagent-tracker-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const s = createSessionsStore(createIpcClient(bridge));
    store = s;
    const id = s.createSession();

    const tracker = getSubagentTracker(s);
    expect(getSubagentTracker(s)).toBe(tracker); // singleton per SessionsStore

    // Not asked for yet, and the subprocess hasn't reached ready: the
    // eager reconcile has had nothing to attach to.
    expect(tracker.getSubagents(id)).toBeUndefined();

    await waitForCondition(
      s.subscribe,
      () => tracker.getSubagents(id) !== undefined,
      "the tracker to eagerly attach a SubagentsStore once the session is ready",
    );

    const attached = tracker.getSubagents(id);
    expect(tracker.getSubagents(id)).toBe(attached); // stable reference

    await s.closeSession(id);
    expect(tracker.getSubagents(id)).toBeUndefined();
  }, 30_000);
});

describe.skipIf(!hasLiveModelCredential())(
  "SubagentsStore against a spawned subagent (needs ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY)",
  () => {
    let sandbox: string | undefined;
    let handle: IpcSessionHandle | undefined;

    afterEach(async () => {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // ignore cleanup failures
        }
        handle = undefined;
      }
      if (sandbox) rmSync(sandbox, { recursive: true, force: true });
      sandbox = undefined;
    });

    it("tracks a spawned subagent's lifecycle/progress live and exposes its message stream", async () => {
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-subagents-test-"));
      const bridge = nodeBridge(binary, sandbox);
      const client = createIpcClient(bridge);
      handle = await client.startSession();

      const store = new SubagentsStore(handle.session);
      await store.ready;
      expect(store.list()).toEqual([]);

      await handle.session.command({
        type: "prompt",
        message:
          'Use your task tool to spawn exactly one subagent (agent: "task") with the assignment "Reply with ' +
          'the single word done and stop.". Wait for it to finish, then reply with exactly the single word ' +
          "FINISHED and nothing else.",
      });

      // Acceptance: "Subagents appear in the panel as they spawn."
      await waitForCondition(
        store.subscribe.bind(store),
        () => store.list().length > 0,
        "the spawned subagent to appear in the roster",
      );
      const subagentId = store.list()[0].id;
      expect(store.list()[0].agent).toBe("task");
      expect(store.list()[0].status).toBe("running");

      // Acceptance: "Lifecycle and progress update live."
      await waitForCondition(
        store.subscribe.bind(store),
        () => store.list().find((subagent) => subagent.id === subagentId)?.progress !== undefined,
        "progress to arrive for the spawned subagent",
      );

      // Acceptance: "Drill-in shows the subagent's stream." — its own
      // rendered task prompt is the first thing to land.
      await waitForCondition(
        (listener) => store.subscribeStream(subagentId, listener),
        () => (store.getStream(subagentId)?.length ?? 0) > 0,
        "the subagent's message stream to receive its first entry",
      );
      const stream = store.getStream(subagentId);
      expect(stream).toBeDefined();
      expect(stream!.length).toBeGreaterThan(0);
      expect(stream![0]).toMatchObject({ kind: "message", role: "user" });

      await waitForCondition(
        store.subscribe.bind(store),
        () => store.list().find((subagent) => subagent.id === subagentId)?.status !== "running",
        "the spawned subagent to reach a terminal lifecycle status",
        90_000,
      );
      expect(store.list().find((subagent) => subagent.id === subagentId)?.status).toBe("completed");

      store.dispose();
    }, 150_000);
  },
);
