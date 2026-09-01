/**
 * Seam test (v1 spec "two seams... 1. the pinned-binary stdio seam"): drives
 * `SessionsStore` against the REAL pinned omp binary via `nodeBridge`, never
 * mocked, same discipline as `session.test.ts`/`smoke.test.ts` — omp is a
 * fixed, local, fast dependency, so mocking it would only test assumptions
 * about the protocol rather than the protocol itself.
 *
 * Exercises the multi-session contract T8 owns: N independent subprocesses
 * reaching ready on their own, an isolated transcript per session, and a
 * close that doesn't disturb its siblings. Command-level protocol behavior
 * (negotiation, `get_state`, ...) is already covered by `session.test.ts`;
 * this suite only covers what's new here — the demultiplexed, many-sessions
 * layer on top.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient } from "../client";
import { nodeBridge } from "../bridge/node";
import { createSessionsStore, type SessionsStore } from "./sessions-store";

const binary =
  process.env.OMP_GUI_OMP_PATH ?? join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/**
 * Resolves once `predicate()` is true, re-checking on every store
 * notification (store updates are event-driven, so this rides `subscribe`
 * instead of polling on a fixed interval). Rejects after `timeoutMs`.
 *
 * The timeout is a real `setTimeout`, not a fake timer: this drives a real
 * `omp` subprocess over real stdio, so the awaited condition depends on
 * actual OS process/IO scheduling that a fake clock can't advance — only a
 * wall-clock upper bound can catch a genuinely hung subprocess here.
 */
function waitForStore(
  store: SessionsStore,
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe(() => {
    if (!predicate()) return;
    clearTimeout(timer);
    unsubscribe();
    resolve();
  });
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`waitForStore: condition never became true within ${timeoutMs}ms`));
  }, timeoutMs);
  return promise;
}

describe("SessionsStore against the pinned omp binary", () => {
  let sandbox: string | undefined;
  let store: SessionsStore | undefined;

  function makeStore(): SessionsStore {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-sessions-store-test-"));
    const bridge = nodeBridge(binary, sandbox);
    store = createSessionsStore(createIpcClient(bridge));
    return store;
  }

  afterEach(async () => {
    if (store) {
      const current = store;
      await Promise.all(current.list().map((session) => current.closeSession(session.id)));
      store = undefined;
    }
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  it("starts multiple sessions concurrently and each reaches ready independently", async () => {
    const s = makeStore();
    const idA = s.createSession();
    const idB = s.createSession();

    // Synchronously registered, subprocess not ready yet: both tracked,
    // neither has a transcript, neither is in an error state.
    expect(s.list().map((session) => session.id)).toEqual([idA, idB]);
    expect(s.list().every((session) => session.status === "idle")).toBe(true);
    expect(s.getTranscript(idA)).toBeUndefined();
    expect(s.getTranscript(idB)).toBeUndefined();

    await waitForStore(s, () => s.getTranscript(idA) !== undefined && s.getTranscript(idB) !== undefined);

    expect(s.list().find((session) => session.id === idA)?.status).toBe("idle");
    expect(s.list().find((session) => session.id === idB)?.status).toBe("idle");
  }, 30_000);

  it("prompting one session only changes that session's transcript", async () => {
    const s = makeStore();
    const idA = s.createSession();
    const idB = s.createSession();
    await waitForStore(s, () => s.getTranscript(idA) !== undefined && s.getTranscript(idB) !== undefined);

    const transcriptA = s.getTranscript(idA)!;
    const transcriptB = s.getTranscript(idB)!;

    // `Transcript.sendPrompt` appends its optimistic `user` entry (and, on a
    // rejected command, a `notice`) without ever throwing, so this holds
    // regardless of whether a live model credential is configured — the
    // seam under test is demultiplexing, not agent behavior.
    await transcriptA.sendPrompt("say the single word: hello");

    expect(transcriptA.getSnapshot().entries.length).toBeGreaterThan(0);
    expect(transcriptA.getSnapshot().entries[0]).toMatchObject({ kind: "user", text: expect.any(String) });
    expect(transcriptB.getSnapshot().entries).toEqual([]);
    expect(s.list().find((session) => session.id === idB)?.status).toBe("idle");
  }, 30_000);

  it("closing one session leaves the other tracked and responsive", async () => {
    const s = makeStore();
    const idA = s.createSession();
    const idB = s.createSession();
    await waitForStore(s, () => s.getTranscript(idA) !== undefined && s.getTranscript(idB) !== undefined);
    const transcriptB = s.getTranscript(idB)!;

    await s.closeSession(idA);

    expect(s.list().map((session) => session.id)).toEqual([idB]);
    expect(s.getTranscript(idA)).toBeUndefined();

    // idB's subprocess is still alive: its transcript still accepts and
    // records a prompt.
    await transcriptB.sendPrompt("say the single word: hello");
    expect(transcriptB.getSnapshot().entries.length).toBeGreaterThan(0);
    expect(s.list().find((session) => session.id === idB)?.status).not.toBe("error");
  }, 30_000);

  it("closing the active session activates the next remaining one", async () => {
    const s = makeStore();
    const idA = s.createSession();
    const idB = s.createSession();
    expect(s.activeId).toBe(idB);
    // Wait for both to be fully up before closing one, so this test's
    // cleanup always closes a resolved subprocess handle like the others.
    await waitForStore(s, () => s.getTranscript(idA) !== undefined && s.getTranscript(idB) !== undefined);

    await s.closeSession(idB);

    expect(s.activeId).toBe(idA);
    expect(s.list().map((session) => session.id)).toEqual([idA]);
  }, 30_000);
});
