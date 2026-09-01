/**
 * Seam test (v1 spec's real-binary seam, ADR-0008-style): drives
 * `createModelSelection` against the real pinned omp binary over stdin/
 * stdout NDJSON via `nodeBridge` + `createIpcClient` + the raw `RpcSession`
 * (`session/session.test.ts`'s pattern) — omp's model registry and
 * settings layer are never mocked.
 *
 * Covers T13's three acceptance criteria:
 *   1. available models list per session comes from live `get_available_models`
 *   2. a model switch applies to the session (verified via an independent
 *      `get_state` re-fetch, not just the module's own optimistic echo)
 *   3. a thinking-level switch applies to the session (same independent
 *      verification)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient, type IpcSessionHandle } from "../client";
import { nodeBridge } from "../bridge/node";
import { createModelSelection, type ModelSelection, type ModelSelectionSnapshot } from "./models";

/** Await a `ModelSelection`'s snapshot once `predicate` passes — the store
 * notifies synchronously on every change (including the initial
 * `get_state`/`get_available_models` round trip's completion), so this
 * resolves off that notification rather than polling. */
async function waitForSnapshot(
  selection: ModelSelection,
  predicate: (snapshot: ModelSelectionSnapshot) => boolean,
): Promise<ModelSelectionSnapshot> {
  const { promise, resolve } = Promise.withResolvers<ModelSelectionSnapshot>();
  const unsubscribe = selection.subscribe(() => {
    const snapshot = selection.getSnapshot();
    if (predicate(snapshot)) resolve(snapshot);
  });
  const initial = selection.getSnapshot();
  if (predicate(initial)) resolve(initial);
  const result = await promise;
  unsubscribe();
  return result;
}

describe("createModelSelection against the pinned omp binary", () => {
  let sandbox: string | undefined;
  let handle: IpcSessionHandle | undefined;
  let selection: ModelSelection | undefined;

  afterEach(async () => {
    selection?.dispose();
    selection = undefined;
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

  it("lists available models from live get_available_models data", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    selection = createModelSelection(handle.session);
    const snapshot = await waitForSnapshot(selection, (s) => !s.loading);

    expect(snapshot.error).toBeUndefined();
    expect(Array.isArray(snapshot.availableModels)).toBe(true);
    expect(snapshot.availableModels.length).toBeGreaterThan(0);

    const live = await handle.session.command({ type: "get_available_models" });
    expect(snapshot.availableModels.map((m) => `${m.provider}:${m.id}`).sort()).toEqual(
      live.data.models.map((m) => `${m.provider}:${m.id}`).sort(),
    );
  }, 30_000);

  it("applies a model switch to the session", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    selection = createModelSelection(handle.session);
    const initial = await waitForSnapshot(selection, (s) => !s.loading);
    expect(initial.availableModels.length).toBeGreaterThan(0);

    // Prefer a model different from the current one so the switch is
    // observable; fall back to the current model (still a real round trip)
    // when the catalog only has one entry.
    const target =
      initial.availableModels.find(
        (m) => !(m.provider === initial.model?.provider && m.id === initial.model?.id),
      ) ?? initial.availableModels[0];
    expect(target).toBeDefined();
    if (!target) throw new Error("unreachable: asserted above");

    await selection.setModel(target.provider, target.id);

    expect(selection.getSnapshot().model?.provider).toBe(target.provider);
    expect(selection.getSnapshot().model?.id).toBe(target.id);

    // Independent verification: re-fetch state directly, bypassing the
    // module's own optimistic echo, to prove the change reached omp itself.
    const state = await handle.session.command({ type: "get_state" });
    expect(state.data.model?.provider).toBe(target.provider);
    expect(state.data.model?.id).toBe(target.id);
  }, 30_000);

  it("applies a thinking-level switch to the session", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    selection = createModelSelection(handle.session);
    const initial = await waitForSnapshot(selection, (s) => !s.loading);

    // Pick a level distinct from the current one so the switch is observable.
    const target = initial.thinkingLevel === "high" ? "low" : "high";

    await selection.setThinkingLevel(target);

    expect(selection.getSnapshot().thinkingLevel).toBe(target);

    // Independent verification, same rationale as the model-switch test.
    const state = await handle.session.command({ type: "get_state" });
    expect(state.data.thinkingLevel).toBe(target);
  }, 30_000);
});
