/**
 * Seam 1 from the v1 spec, at the transcript layer: drive `Transcript` — the
 * module the UI actually consumes — against the real pinned omp binary over
 * stdin/stdout NDJSON, reusing the `nodeBridge`/`createIpcClient` pattern
 * from `session/session.test.ts`. omp is never mocked (same rationale there:
 * the pin is a fixed, local, fast dependency; mocking it would test our
 * assumptions about the protocol rather than the protocol).
 *
 * Real prompts hit a real, non-deterministic model, so assertions are built
 * around behavior every well-behaved coding-agent turn should exhibit (an
 * assistant reply, a running→idle lifecycle, an explicitly-requested tool
 * call reaching a terminal status) rather than exact model output. Thinking
 * blocks depend on the configured model/thinking level, so their presence is
 * not required — only that any entry the state machine does produce,
 * including thinking, is well-formed (the "every entry is well-formed" sweep
 * in the first test covers that regardless of which kinds actually fired).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient, type IpcSessionHandle } from "../client";
import { nodeBridge } from "../bridge/node";
import { Transcript, type ToolExecutionEntry, type TranscriptSnapshot } from "./transcript";

const binary =
  process.env.OMP_GUI_OMP_PATH ?? join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/**
 * Waits for the transcript's live snapshot to satisfy `predicate`, checking
 * the current snapshot first so an already-true condition resolves instantly.
 * The wait itself is event-driven (`transcript.subscribe`), matching a real
 * `agent_start`/`agent_end`/etc. arriving from the live subprocess; the
 * `setTimeout` below is only a ceiling on that real wall-clock wait, not a
 * guessed sleep — this integration test drives a real omp process and,
 * transitively, a real model API call, so there is no synthetic clock to
 * advance instead.
 */
function waitForSnapshot(
  transcript: Transcript,
  predicate: (snapshot: TranscriptSnapshot) => boolean,
  timeoutMs: number,
): Promise<TranscriptSnapshot> {
  const initial = transcript.getSnapshot();
  if (predicate(initial)) return Promise.resolve(initial);
  const { promise, resolve, reject } = Promise.withResolvers<TranscriptSnapshot>();
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`timed out after ${timeoutMs}ms waiting for a transcript condition`));
  }, timeoutMs);
  const unsubscribe = transcript.subscribe((snapshot) => {
    if (!predicate(snapshot)) return;
    clearTimeout(timer);
    unsubscribe();
    resolve(snapshot);
  });
  return promise;
}

describe("Transcript against the pinned omp binary", () => {
  let sandbox: string | undefined;
  let handle: IpcSessionHandle | undefined;
  let transcript: Transcript | undefined;

  afterEach(async () => {
    transcript?.dispose();
    transcript = undefined;
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

  it(
    "streams message/thinking/tool-execution events live and completes",
    async () => {
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-transcript-test-"));
      const bridge = nodeBridge(binary, sandbox);
      const client = createIpcClient(bridge);
      handle = await client.startSession();
      transcript = new Transcript(handle.session);

      // Best-effort: exercise the thinking path when the configured model
      // supports it. Not required for the assertions below.
      await handle.session.command({ type: "set_thinking_level", level: "high" }).catch(() => {});

      await transcript.sendPrompt(
        "Use your bash tool to run `echo hello-transcript-test`, then reply with a one-sentence summary of the output.",
      );

      // The optimistic user entry renders synchronously, before any wire round-trip.
      const first = transcript.getSnapshot().entries[0];
      expect(first?.kind).toBe("user");
      expect(first && first.kind === "user" ? first.text : null).toContain("echo hello-transcript-test");

      await waitForSnapshot(transcript, (snapshot) => snapshot.running, 30_000);
      const final = await waitForSnapshot(transcript, (snapshot) => !snapshot.running, 120_000);

      expect(final.aborting).toBe(false);
      expect(final.entries.some((entry) => entry.kind === "assistant" && entry.text.length > 0)).toBe(true);

      const toolEntries = final.entries.filter(
        (entry): entry is ToolExecutionEntry => entry.kind === "tool",
      );
      expect(toolEntries.length).toBeGreaterThan(0);
      for (const entry of toolEntries) {
        expect(["done", "error", "aborted"]).toContain(entry.status);
        expect(entry.toolCallId.length).toBeGreaterThan(0);
      }

      // Every entry the state machine produced is well-formed, regardless of
      // which entry kinds this particular run happened to exercise.
      for (const entry of final.entries) {
        expect(typeof entry.id).toBe("string");
        expect(entry.id.length).toBeGreaterThan(0);
        expect(typeof entry.timestamp).toBe("number");
        if (entry.kind === "assistant" || entry.kind === "thinking") {
          expect(entry.streaming).toBe(false);
        }
      }
    },
    150_000,
  );

  it(
    "abort stops the turn and the transcript reflects it",
    async () => {
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-transcript-abort-test-"));
      const bridge = nodeBridge(binary, sandbox);
      const client = createIpcClient(bridge);
      handle = await client.startSession();
      transcript = new Transcript(handle.session);

      await transcript.sendPrompt(
        "Count out loud from one to one hundred, writing exactly one number per line with a short remark on each.",
      );

      await waitForSnapshot(transcript, (snapshot) => snapshot.running, 30_000);
      expect(transcript.getSnapshot().running).toBe(true);

      await transcript.abort();
      const final = await waitForSnapshot(transcript, (snapshot) => !snapshot.running, 60_000);

      expect(final.running).toBe(false);
      expect(final.aborting).toBe(false);
      // The abort must be reflected in every entry it interrupted: nothing is
      // left claiming to still be streaming or still running.
      for (const entry of final.entries) {
        if (entry.kind === "assistant" || entry.kind === "thinking") {
          expect(entry.streaming).toBe(false);
        }
        if (entry.kind === "tool") {
          expect(entry.status).not.toBe("running");
        }
      }
    },
    90_000,
  );
});
