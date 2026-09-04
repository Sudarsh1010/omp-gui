/**
 * Seam test for `nodeBridge`'s spawn-cwd resolution (#22): proves `start()`
 * honors the App Preferences `defaultWorkingDirectory` (falling back to the
 * bridge's own constructor cwd) without needing a real omp binary or a live
 * model credential — `child_process` is mocked so this only exercises the
 * actual cwd-resolution code path `start()` runs before spawning, mirroring
 * `crates/shell/src/omp.rs`'s `resolve_start_cwd` precedence on the Rust
 * side. Reading a session's *recorded* cwd back off disk (like
 * `session-directory.test.ts`'s fixtures) isn't available here: omp only
 * materializes a session file once its history contains a real assistant
 * message (see that file's module doc), which needs live model credentials
 * this environment can't assume.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeBridge } from "./node";

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn(() => "18.1.10");

// Hoisted by vitest ahead of the static imports above, so `./node`'s own
// `import { spawn, execFileSync } from "node:child_process"` resolves
// against these mocks.
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  return child;
}

describe("nodeBridge's start() spawn-cwd resolution (#22)", () => {
  let sandboxes: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
    sandboxes = [];
  });

  function makeDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `omp-gui-node-bridge-${name}-`));
    sandboxes.push(dir);
    return dir;
  }

  function writePreferences(path: string, defaultWorkingDirectory: string | null): void {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        theme: "system",
        ompPath: null,
        chromiumPath: null,
        defaultWorkingDirectory,
      }),
    );
  }

  it("spawns in the preferences file's defaultWorkingDirectory when no explicit cwd is given", async () => {
    const fallbackCwd = makeDir("fallback");
    const preferredCwd = makeDir("preferred");
    const preferencesPath = join(makeDir("prefs"), "preferences.json");
    writePreferences(preferencesPath, preferredCwd);

    spawnMock.mockReturnValue(fakeChild());
    const bridge = nodeBridge("unused-omp-binary", fallbackCwd, { preferencesPath });

    await bridge.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnOptions.cwd).toBe(preferredCwd);
  });

  it("falls back to the constructor cwd when the preferred directory no longer exists on disk", async () => {
    const fallbackCwd = makeDir("fallback2");
    const preferencesPath = join(makeDir("prefs2"), "preferences.json");
    writePreferences(preferencesPath, "/nonexistent/omp-gui-preferred-cwd-should-never-exist");

    spawnMock.mockReturnValue(fakeChild());
    const bridge = nodeBridge("unused-omp-binary", fallbackCwd, { preferencesPath });

    await bridge.start();

    const [, , spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnOptions.cwd).toBe(fallbackCwd);
  });

  it("falls back to the constructor cwd when no preferencesPath was given at all", async () => {
    const fallbackCwd = makeDir("fallback3");

    spawnMock.mockReturnValue(fakeChild());
    const bridge = nodeBridge("unused-omp-binary", fallbackCwd);

    await bridge.start();

    const [, , spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnOptions.cwd).toBe(fallbackCwd);
  });

  it("an explicit requested cwd (a resume) always wins over the preference", async () => {
    const fallbackCwd = makeDir("fallback4");
    const preferredCwd = makeDir("preferred4");
    const requestedCwd = makeDir("requested4");
    const preferencesPath = join(makeDir("prefs4"), "preferences.json");
    writePreferences(preferencesPath, preferredCwd);

    spawnMock.mockReturnValue(fakeChild());
    const bridge = nodeBridge("unused-omp-binary", fallbackCwd, { preferencesPath });

    await bridge.start(requestedCwd);

    const [, , spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(spawnOptions.cwd).toBe(requestedCwd);
  });

  it("threads agentDir into PI_CODING_AGENT_DIR for every spawned process", async () => {
    const fallbackCwd = makeDir("fallback5");
    const agentDir = makeDir("agent5");

    spawnMock.mockReturnValue(fakeChild());
    const bridge = nodeBridge("unused-omp-binary", fallbackCwd, { agentDir });

    await bridge.start();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [, , execOptions] = execFileSyncMock.mock.calls[0] as [string, string[], { env?: Record<string, string> }];
    expect(execOptions.env?.PI_CODING_AGENT_DIR).toBe(agentDir);

    const [, , spawnOptions] = spawnMock.mock.calls[0] as [string, string[], { env?: Record<string, string> }];
    expect(spawnOptions.env?.PI_CODING_AGENT_DIR).toBe(agentDir);
  });
});
