/**
 * Seam test (T7, issue #8; ADR-0005 single-writer guard): drives
 * `SessionDirectory` against the REAL pinned omp binary via `nodeBridge`,
 * same discipline as the sibling seam tests in this directory (never
 * mocked — omp is a fixed, local, fast dependency, so mocking it would
 * only test assumptions about the protocol rather than the protocol
 * itself).
 *
 * `listSessionFiles`/`switch_session`/the single-writer guard all need a
 * session file that's actually resumable, but omp only ever materializes
 * one to disk once its history contains a real assistant message
 * (`session-manager.ts`'s `isSessionOnDisk` doc: "persistence is lazy...
 * until the history contains an assistant message") — which needs live
 * model credentials this test environment can't assume, unlike
 * `session.test.ts`'s canned `get_state` round trip. So the fixture below
 * is written directly to disk rather than produced by prompting a real
 * session. This is *not* a stand-in for omp's own parsing: the pinned
 * `session-loader.ts`'s header check (`isValidSessionHeader`: `entry.type
 * === "session" && typeof entry.id === "string"`, verified by reading that
 * file directly) is the only hard requirement `switch_session`'s resume
 * path (`SessionManager#setSessionFile`) enforces, so this minimal, real-
 * format fixture is loaded by the exact same, unmodified loader every real
 * session file goes through.
 */
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient } from "../client";
import { nodeBridge } from "../bridge/node";
import { createSessionsStore, type SessionsStore } from "./sessions-store";
import { createSessionDirectory, type SessionDirectory } from "./session-directory";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/**
 * Mirrors `crates/shell/src/sessions.rs`'s `sessions_root` and
 * `bridge/node.ts`'s own `sessionsRoot()` — both hand-roll the identical
 * resolution (`@oh-my-pi/pi-utils`'s `dirs.ts` default, non-profile,
 * non-XDG): `PI_CODING_AGENT_DIR` wins outright, else `$HOME/<PI_CONFIG_DIR
 * or .omp>/agent/sessions`. Computed here rather than importing
 * `getSessionsDir` from `@oh-my-pi/pi-utils` directly because that package
 * isn't `platform/ipc`'s own declared dependency (only the pinned
 * `@oh-my-pi/pi-coding-agent` is).
 */
function resolveSessionsRoot(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return join(override, "sessions");
  const configDirName = process.env.PI_CONFIG_DIR?.trim() || ".omp";
  return join(homedir(), configDirName, "agent", "sessions");
}

/**
 * Writes a minimal, real-format session file directly to a fresh directory
 * under the actual sessions root `listAllSessions`/`list_session_files`
 * scan (see module doc for why this can't come from a live prompt).
 * Returns the file's absolute path and the project directory it lives in
 * (for cleanup).
 */
function writeFixtureSessionFile(cwd: string, title: string): { path: string; projectDir: string } {
  const projectDir = join(resolveSessionsRoot(), `omp-gui-directory-test-${randomUUID()}`);
  mkdirSync(projectDir, { recursive: true });
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const path = join(projectDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp, cwd, title, titleSource: "user" };
  const message = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp,
    message: { role: "user", content: [{ type: "text", text: "hello from a test fixture" }] },
  };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  return { path, projectDir };
}

/**
 * Resolves once `predicate()` is true, re-checking on every directory
 * notification (ownership changes are event-driven, so this rides
 * `subscribe` instead of polling or a guessed sleep) — mirrors
 * `sessions-store.test.ts`'s own `waitForStore` helper. `timeoutMs` is a
 * real `setTimeout`, not a fake timer: this drives a real `omp` subprocess
 * exiting over real OS process teardown (`store.closeSession` -> kill ->
 * the child's actual `"exit"` event), which a fake clock cannot advance —
 * only a wall-clock upper bound catches a genuinely hung teardown here.
 */
function waitForDirectory(
  directory: SessionDirectory,
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const unsubscribe = directory.subscribe(() => {
    if (!predicate()) return;
    clearTimeout(timer);
    unsubscribe();
    resolve();
  });
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`waitForDirectory: condition never became true within ${timeoutMs}ms`));
  }, timeoutMs);
  return promise;
}

describe("SessionDirectory against the pinned omp binary", () => {
  const projectDirs: string[] = [];
  const sandboxes: string[] = [];
  let store: SessionsStore | undefined;

  function makeSandbox(): string {
    const sandbox = mkdtempSync(join(tmpdir(), "omp-gui-directory-test-"));
    sandboxes.push(sandbox);
    return sandbox;
  }

  function makeFixture(title: string, cwd: string = makeSandbox()): { path: string } {
    const { path, projectDir } = writeFixtureSessionFile(cwd, title);
    projectDirs.push(projectDir);
    return { path };
  }

  afterEach(async () => {
    if (store) {
      const current = store;
      await Promise.all(current.list().map((session) => current.closeSession(session.id)));
      store = undefined;
    }
    for (const dir of projectDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("lists past sessions from disk without spawning omp", async () => {
    const fixture = makeFixture("Listing fixture");

    // A deliberately broken binary path: if listing needed to spawn omp,
    // this would fail loudly. `refresh()` succeeding anyway is the proof.
    const bridge = nodeBridge("/nonexistent/omp-binary-should-never-run", makeSandbox());
    store = createSessionsStore(createIpcClient(bridge));
    const directory = createSessionDirectory(bridge, store);

    await directory.refresh();

    const entry = directory.list().find((e) => e.path === fixture.path);
    expect(entry).toBeDefined();
    expect(entry?.title).toBe("Listing fixture");
    expect(entry?.sizeBytes).toBeGreaterThan(0);
  });

  it("switch_session resumes a selected session", async () => {
    const sandbox = makeSandbox();
    const fixture = makeFixture("Resume fixture", sandbox);
    const bridge = nodeBridge(binary, sandbox);
    store = createSessionsStore(createIpcClient(bridge));
    const directory = createSessionDirectory(bridge, store);

    const result = await directory.resume(fixture.path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(directory.ownerOf(fixture.path)).toEqual({
      state: "ownedByApp",
      sessionId: result.sessionId,
    });

    const session = store.getSession(result.sessionId);
    expect(session).toBeDefined();
    const messages = await session!.command({ type: "get_messages" });
    expect(JSON.stringify(messages.data.messages)).toContain("hello from a test fixture");
  }, 30_000);

  it("refuses to drive a file already open in this app and offers read-only", async () => {
    const sandbox = makeSandbox();
    const fixture = makeFixture("Guard fixture", sandbox);
    const bridge = nodeBridge(binary, sandbox);
    store = createSessionsStore(createIpcClient(bridge));
    const directory = createSessionDirectory(bridge, store);

    const first = await directory.resume(fixture.path);
    expect(first.ok).toBe(true);

    const second = await directory.resume(fixture.path);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.readOnly).toBe(true);
    expect(second.reason).toContain("already open");

    // The read-only affordance itself: viewable without ever attempting to
    // drive it, so refusing the second resume never blocked a legitimate
    // way to see the session's content.
    const preview = await directory.preview(fixture.path);
    expect(preview.messages.length).toBeGreaterThan(0);
    expect(preview.messages.some((m) => m.text.includes("hello from a test fixture"))).toBe(true);
  }, 30_000);

  it("releases ownership once the driving session closes", async () => {
    const sandbox = makeSandbox();
    const fixture = makeFixture("Release fixture", sandbox);
    const bridge = nodeBridge(binary, sandbox);
    store = createSessionsStore(createIpcClient(bridge));
    const directory = createSessionDirectory(bridge, store);

    const first = await directory.resume(fixture.path);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(directory.ownerOf(fixture.path).state).toBe("ownedByApp");

    await store.closeSession(first.sessionId);
    await waitForDirectory(directory, () => directory.ownerOf(fixture.path).state === "free");

    expect(directory.ownerOf(fixture.path)).toEqual({ state: "free" });

    // Ownership actually released, not just relabeled: a fresh resume on
    // the same path now succeeds instead of being refused.
    const second = await directory.resume(fixture.path);
    expect(second.ok).toBe(true);
  }, 30_000);
});
