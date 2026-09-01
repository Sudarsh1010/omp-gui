/**
 * The CDP seam (spec Testing Decisions §2, "pane only"): a small suite
 * against a *real* app-owned Chromium, proving the exact contract
 * `crates/shell/src/browser.rs` depends on rather than mocking CDP itself —
 * "never mock the thing whose contract we're depending on." Below this
 * seam, the CDP pump's event-loop/state-machine logic is verified by
 * smoke-driving the real app, not by test automation (per the spec).
 *
 * This covers what T9 delivers: attaching as a second CDP client, screencast
 * frames arriving, and the persistent profile surviving a relaunch. Input
 * dispatch (Takeover) is a later ticket and is deliberately not exercised
 * here.
 *
 * Chrome resolution mirrors `crates/shell/src/browser.rs`'s
 * `resolve_chromium_executable` (env override, then the standard
 * `@puppeteer/browsers` cache layout under both the ecosystem-default cache
 * and omp's own managed-browser cache) so this test proves the exact recipe
 * the Rust launcher relies on. No Chrome for Testing resolvable → the suite
 * skips rather than fails, mirroring the "skip on hosts missing Chrome's
 * system libraries" precedent in omp's own real-browser tests.
 *
 * Launched headed (never `--headless`), matching ADR-0006's production
 * configuration exactly — CI must provide a virtual display (e.g. `xvfb-run`
 * on Linux runners) for this suite to run.
 *
 * Every `setTimeout` below is a failure-mode bound on a real external
 * Chrome subprocess's CDP traffic, not a "sleep then assert" — fake timers
 * (`vi.useFakeTimers`) have no effect on that external process, so there is
 * no deterministic substitute (ts-no-test-timers' documented exception).
 */
import { describe, expect, it } from "vite-plus/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${context} to be a string, got ${typeof value}`);
  }
  return value;
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${context} to be an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${context} to be an array, got ${typeof value}`);
  }
  return value;
}

/** A minimal hand-rolled CDP client — the same "tiny, stable surface" this
 * project's Rust CDP pump speaks, exercised here over Node's native
 * `WebSocket` with no CDP binding library in between. */
class CdpClient {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  #listeners = new Set<(msg: CdpMessage) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as CdpMessage;
      if (typeof msg.id === "number" && this.#pending.has(msg.id)) {
        const pending = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) pending?.reject(new Error(msg.error.message));
        else pending?.resolve(msg.result ?? {});
      }
      for (const listener of this.#listeners) listener(msg);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`failed to connect to ${url}`)), {
      once: true,
    });
    await promise;
    return new CdpClient(ws);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const envelope: Record<string, unknown> = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    this.#pending.set(id, { resolve, reject });
    this.#ws.send(JSON.stringify(envelope));
    return promise;
  }

  onMessage(listener: (msg: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** `timeoutMs` bounds a real external Chrome process's event delivery —
   * see the file-level note on this suite's `setTimeout` usage. */
  waitForEvent(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    const unsubscribe = this.onMessage((msg) => {
      if (msg.method === method && predicate(msg.params ?? {})) {
        clearTimeout(timer);
        unsubscribe();
        resolve(msg.params ?? {});
      }
    });
    return promise;
  }

  close(): void {
    this.#ws.close();
  }
}

function isPageTarget(params: Record<string, unknown>): boolean {
  const targetInfo = params.targetInfo;
  return (
    !!targetInfo &&
    typeof targetInfo === "object" &&
    "type" in targetInfo &&
    targetInfo.type === "page"
  );
}

function targetIdOf(params: Record<string, unknown>): string {
  const targetInfo = asObject(params.targetInfo, "targetInfo");
  return asString(targetInfo.targetId, "targetInfo.targetId");
}

function findCookieValue(cookies: unknown[], name: string): string | undefined {
  for (const cookie of cookies) {
    if (cookie && typeof cookie === "object" && "name" in cookie && cookie.name === name) {
      return "value" in cookie && typeof cookie.value === "string" ? cookie.value : undefined;
    }
  }
  return undefined;
}

/** Attaches a second CDP client and returns the flatten-mode session id for
 * the first page target — the same `Target.setDiscoverTargets` ->
 * `Target.attachToTarget` sequence `run_cdp_pump` drives. */
async function attachToFirstPage(cdp: CdpClient): Promise<string> {
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const params = await cdp.waitForEvent("Target.targetCreated", isPageTarget);
  const result = await cdp.send("Target.attachToTarget", {
    targetId: targetIdOf(params),
    flatten: true,
  });
  return asString(result.sessionId, "Target.attachToTarget sessionId");
}

/** Mirrors `chrome_for_testing_relative_path` in `crates/shell/src/browser.rs`. */
function chromeForTestingRelativePath(): string {
  if (process.platform === "darwin") {
    const archFolder = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
    return join(
      `chrome-${archFolder}`,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
  }
  if (process.platform === "win32") {
    return join("chrome-win64", "chrome.exe");
  }
  return join("chrome-linux64", "chrome");
}

/** Mirrors `resolve_chromium_executable` in `crates/shell/src/browser.rs`. */
function resolveChromeExecutable(): string | null {
  const override = process.env.OMP_GUI_CHROMIUM_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override && existsSync(override)) return override;

  const relativeExecutable = chromeForTestingRelativePath();
  const cacheRoots = [
    join(homedir(), ".cache", "puppeteer"), // @puppeteer/browsers' own default cache
    join(homedir(), ".omp", "puppeteer"), // omp's managed-browser cache (notes/browser.md §5)
  ];

  for (const root of cacheRoots) {
    const chromeDir = join(root, "chrome");
    if (!existsSync(chromeDir)) continue;
    for (const entry of readdirSync(chromeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(chromeDir, entry.name, relativeExecutable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Mirrors `browser_launch`'s stderr-banner scrape: the exact signal
 * `@puppeteer/browsers`' own launcher waits on (`CDP_WEBSOCKET_ENDPOINT_REGEX`).
 * `timeoutMs` bounds a real Chrome cold start — see the file-level note. */
function waitForDevToolsUrl(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const rl = createInterface({ input: child.stderr });
  const timer = setTimeout(() => {
    rl.close();
    reject(new Error("timed out waiting for Chrome's DevTools listening banner"));
  }, timeoutMs);
  rl.on("line", (line) => {
    const match = /^DevTools listening on (ws:\/\/.*)$/.exec(line);
    if (match) {
      clearTimeout(timer);
      rl.close();
      resolve(match[1]);
    }
  });
  child.once("error", (err) => {
    clearTimeout(timer);
    rl.close();
    reject(err);
  });
  return promise;
}

const chromePath = resolveChromeExecutable();

function launchChrome(userDataDir: string): ChildProcessWithoutNullStreams {
  const child = spawn(chromePath ?? "", [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "about:blank",
  ]);
  child.stdout.resume(); // never read, but must be drained so Chrome can't block on a full pipe
  return child;
}

async function launchAndWait(
  userDataDir: string,
): Promise<{ child: ChildProcessWithoutNullStreams; wsUrl: string }> {
  const child = launchChrome(userDataDir);
  const wsUrl = await waitForDevToolsUrl(child, 20_000);
  return { child, wsUrl };
}

async function stopChrome(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill();
  await once(child, "exit");
}

(chromePath ? describe : describe.skip)(
  "browser CDP seam (dual attach, screencast, profile persistence)",
  () => {
    it("attaches as a second CDP client and receives screencast frames", async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), "omp-gui-browser-test-"));
      const { child, wsUrl } = await launchAndWait(userDataDir);
      try {
        const cdp = await CdpClient.connect(wsUrl);
        try {
          const targetSessionId = await attachToFirstPage(cdp);
          await cdp.send("Page.enable", {}, targetSessionId);
          await cdp.send(
            "Page.startScreencast",
            { format: "jpeg", quality: 80, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
            targetSessionId,
          );

          const frame = await cdp.waitForEvent("Page.screencastFrame", () => true, 15_000);
          const jpegBytes = Buffer.from(
            asString(frame.data, "Page.screencastFrame data"),
            "base64",
          );
          // JPEG magic number: 0xFF 0xD8.
          expect(jpegBytes[0]).toBe(0xff);
          expect(jpegBytes[1]).toBe(0xd8);

          await cdp.send(
            "Page.screencastFrameAck",
            { sessionId: frame.sessionId },
            targetSessionId,
          );
        } finally {
          cdp.close();
        }
      } finally {
        await stopChrome(child);
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }, 30_000);

    it("persists the profile across a relaunch", async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), "omp-gui-browser-test-"));
      const probeName = "ompGuiPersistenceProbe";
      const probeValue = randomUUID();
      const probeUrl = "https://omp-gui-persistence-probe.example/";

      try {
        // First launch: write a cookie into the persistent profile — CDP's
        // cookie store can be written/read directly without ever actually
        // navigating anywhere, keeping this hermetic (no real network).
        {
          const { child, wsUrl } = await launchAndWait(userDataDir);
          try {
            const cdp = await CdpClient.connect(wsUrl);
            try {
              const targetSessionId = await attachToFirstPage(cdp);
              await cdp.send(
                "Network.setCookie",
                { name: probeName, value: probeValue, url: probeUrl },
                targetSessionId,
              );
            } finally {
              cdp.close();
            }
          } finally {
            await stopChrome(child);
          }
        }

        // Second launch, same user-data-dir: the cookie — and so the
        // "log in once, ever" property ADR-0006 promises — must survive.
        {
          const { child, wsUrl } = await launchAndWait(userDataDir);
          try {
            const cdp = await CdpClient.connect(wsUrl);
            try {
              const targetSessionId = await attachToFirstPage(cdp);
              const cookiesResult = await cdp.send(
                "Network.getCookies",
                { urls: [probeUrl] },
                targetSessionId,
              );
              const cookies = asArray(cookiesResult.cookies, "Network.getCookies cookies");
              expect(findCookieValue(cookies, probeName)).toBe(probeValue);
            } finally {
              cdp.close();
            }
          } finally {
            await stopChrome(child);
          }
        }
      } finally {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

/**
 * Relay daemon seam (T11, issue #12, ADR-0006 §"Human-in-the-loop", notes/
 * browser.md §6): proves the exact contract `browser_set_relay`
 * (`crates/shell/src/browser.rs`) depends on against the *real* pinned omp
 * binary's `browser-relay serve` subcommand, never mocking the CDP-
 * discovery HTTP protocol it speaks. Unlike the suite above, this needs no
 * Chrome, no extension, and no `xvfb-run`: `relay/server.ts`'s
 * `/json/version` legitimately answers 503 before any extension has ever
 * attached, so the daemon's own up/down lifecycle and HTTP surface are
 * fully exercisable headless.
 *
 * The browser-relay Chrome extension's actual handshake (`chrome.debugger`
 * attach, tab discovery, driving the user's real tabs) is deliberately not
 * exercised here, for the same reason BrowserPane's Takeover input isn't in
 * the suite above: it requires a human's real, already-logged-in Chrome
 * profile with the extension loaded via "Load unpacked" — verified by
 * running the app, not CI automation (spec Testing Decisions §2).
 *
 * Omp resolution mirrors `crates/shell/src/omp.rs`'s `resolve_omp_path`
 * (env override, then the repo-local dev binary `fetch-omp.mjs`
 * downloads; the bundled-resource-dir branch has no equivalent outside a
 * built Tauri app). No pinned omp binary resolvable → the suite skips
 * rather than fails, mirroring `resolveChromeExecutable`'s precedent above.
 */
function resolveOmpBinary(): string | null {
  const override = process.env.OMP_GUI_OMP_PATH;
  if (override && existsSync(override)) return override;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const dev = join(repoRoot, "crates", "shell", "binaries", "omp");
  return existsSync(dev) ? dev : null;
}

/** Binds an ephemeral loopback port and releases it immediately, so each
 * test drives its own private relay rather than the shared default port
 * `9224` a real omp install (or this very app) might already be serving. */
async function findFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("failed to allocate a free port"));
    });
  });
  return promise;
}

/** Mirrors `spawn_relay_daemon`'s wait in `crates/shell/src/browser.rs`:
 * the exact ready banner `runServe` prints (`cli/browser-relay-cli.ts`).
 *
 * `setTimeout` here is a failure-mode bound on a real `omp browser-relay`
 * child process's stdout, exactly like `waitForDevToolsUrl` above for
 * Chrome (see this file's header) — not a "sleep then assert": the actual
 * wait is the `rl.on("line", ...)` listener, and fake timers have no
 * effect on the external subprocess actually producing that line, so
 * there is no deterministic substitute (ts-no-test-timers' documented
 * exception). */
function waitForRelayBanner(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const rl = createInterface({ input: child.stdout });
  const timer = setTimeout(() => {
    rl.close();
    reject(new Error("timed out waiting for omp browser-relay's ready banner"));
  }, timeoutMs);
  rl.on("line", (line) => {
    if (line.includes("browser relay listening on http://")) {
      clearTimeout(timer);
      rl.close();
      resolve();
    }
  });
  child.once("error", (err) => {
    clearTimeout(timer);
    rl.close();
    reject(err);
  });
  return promise;
}

async function stopRelay(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill();
  await once(child, "exit");
}

const ompPath = resolveOmpBinary();

(ompPath ? describe : describe.skip)(
  "browser relay daemon seam (real omp browser-relay binary)",
  () => {
    it("serves the CDP-discovery HTTP contract before any extension attaches", async () => {
      const port = await findFreePort();
      const child = spawn(ompPath!, ["browser-relay", "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr.resume(); // drained but unused, mirrors `launchChrome`'s stdout note above
      try {
        await waitForRelayBanner(child, 15_000);

        // `probe_relay_status`'s entire contract: *any* HTTP response means
        // "adopt, don't bind a second one" — 503 is that response before an
        // extension has ever dialed in (`relay/server.ts`'s handler).
        const status = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.status);
        expect(status).toBe(503);

        // `/json` (page-target listing) answers even pre-handshake.
        const targets: unknown = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
        expect(Array.isArray(targets)).toBe(true);
      } finally {
        await stopRelay(child);
      }
    }, 20_000);

    it("loses a same-port race cleanly — the exact signal ensure_relay_daemon's adopt fallback depends on", async () => {
      const port = await findFreePort();
      const first = spawn(ompPath!, ["browser-relay", "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      first.stderr.resume();
      try {
        await waitForRelayBanner(first, 15_000);

        // A second `browser-relay` on the same port must lose the bind and
        // exit 0 without ever printing the ready banner (`runServe`'s
        // EADDRINUSE path: "already running ... nothing to do") — the
        // signal `spawn_relay_daemon` reads as "someone else won; go adopt
        // them" rather than a real launch failure.
        const second = spawn(ompPath!, ["browser-relay", "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        second.stdout.resume();
        second.stderr.resume();
        const [code] = await once(second, "exit");
        expect(code).toBe(0);

        // The winner is still the one actually serving.
        const status = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.status);
        expect(status).toBe(503);
      } finally {
        await stopRelay(first);
      }
    }, 20_000);
  },
);
