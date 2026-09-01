/**
 * The CDP seam (spec Testing Decisions §2, "pane only"): a small suite
 * against a *real* app-owned Chromium, proving the exact contract
 * `crates/shell/src/browser.rs` depends on rather than mocking CDP itself —
 * "never mock the thing whose contract we're depending on." Below this
 * seam, the CDP pump's event-loop/state-machine logic is verified by
 * smoke-driving the real app, not by test automation (per the spec).
 *
 * This covers what T9 delivers: attaching as a second CDP client, screencast
 * frames arriving, and the persistent profile surviving a relaunch — plus
 * what T10 adds: Takeover's `Input.dispatchMouseEvent`/`dispatchKeyEvent`
 * calls actually landing on the page (a dispatched click and dispatched
 * typed text, read back via `Runtime.evaluate` DOM state) — the same CDP
 * seam `crates/shell/src/browser.rs`'s `run_cdp_pump` depends on to dispatch
 * pane input.
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
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
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

function asNumber(value: unknown, context: string): number {
  if (typeof value !== "number") {
    throw new Error(`expected ${context} to be a number, got ${typeof value}`);
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

/** Runs a `Runtime.evaluate` expression and returns its raw result value —
 * the read-back half of the Takeover seam test below, since asserting
 * dispatched input "landed" means reading DOM state back through CDP, not
 * through the page's own JS return value of the dispatch call (there isn't
 * one: `Input.dispatch*` is fire-and-forget from the caller's side). */
async function evaluate(cdp: CdpClient, sessionId: string, expression: string): Promise<unknown> {
  const response = await cdp.send("Runtime.evaluate", { expression }, sessionId);
  return asObject(response.result, "Runtime.evaluate result").value;
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
  "browser CDP seam (dual attach, screencast, profile persistence, takeover input dispatch)",
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

    it("lands Takeover's dispatched Input.dispatch* on the live page (click + typed text)", async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), "omp-gui-browser-test-"));
      const { child, wsUrl } = await launchAndWait(userDataDir);
      try {
        const cdp = await CdpClient.connect(wsUrl);
        try {
          const targetSessionId = await attachToFirstPage(cdp);
          await cdp.send("Page.enable", {}, targetSessionId);

          // A `data:` URL keeps this hermetic (no real network, matching
          // the persistence test's own precedent above) while still giving
          // dispatched input a real button and a real text field to land on.
          const loaded = cdp.waitForEvent("Page.loadEventFired", () => true, 15_000);
          const html =
            "<button id=btn onclick=\"btn.dataset.clicked='yes'\">Click</button><input id=field>";
          await cdp.send(
            "Page.navigate",
            { url: `data:text/html,${encodeURIComponent(html)}` },
            targetSessionId,
          );
          await loaded;

          // Mirrors `BrowserPane.tsx`'s Takeover path exactly: compute a
          // viewport point from the element's own geometry (the same job
          // `paneCoordinates` does from the pane's frame), then drive it
          // with `Input.dispatchMouseEvent` — never a DOM-level `.click()`
          // shortcut, since that would prove nothing about the CDP seam
          // Takeover actually depends on.
          const buttonX = asNumber(
            await evaluate(
              cdp,
              targetSessionId,
              "btn.getBoundingClientRect().x + btn.getBoundingClientRect().width / 2",
            ),
            "button center x",
          );
          const buttonY = asNumber(
            await evaluate(
              cdp,
              targetSessionId,
              "btn.getBoundingClientRect().y + btn.getBoundingClientRect().height / 2",
            ),
            "button center y",
          );
          await cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mousePressed", x: buttonX, y: buttonY, button: "left", clickCount: 1 },
            targetSessionId,
          );
          await cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x: buttonX, y: buttonY, button: "left", clickCount: 1 },
            targetSessionId,
          );
          expect(
            asString(await evaluate(cdp, targetSessionId, "btn.dataset.clicked"), "btn.dataset.clicked"),
          ).toBe("yes");

          // Same seam for the keyboard half: dispatch a click to focus the
          // field (Takeover's own click-to-focus path, see
          // `BrowserPane.tsx`'s `onMouseDown`), then dispatch key events —
          // never a DOM-level `.value =` shortcut.
          const fieldX = asNumber(
            await evaluate(
              cdp,
              targetSessionId,
              "field.getBoundingClientRect().x + field.getBoundingClientRect().width / 2",
            ),
            "field center x",
          );
          const fieldY = asNumber(
            await evaluate(
              cdp,
              targetSessionId,
              "field.getBoundingClientRect().y + field.getBoundingClientRect().height / 2",
            ),
            "field center y",
          );
          await cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mousePressed", x: fieldX, y: fieldY, button: "left", clickCount: 1 },
            targetSessionId,
          );
          await cdp.send(
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x: fieldX, y: fieldY, button: "left", clickCount: 1 },
            targetSessionId,
          );
          for (const key of "hi") {
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key }, targetSessionId);
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key }, targetSessionId);
          }
          expect(asString(await evaluate(cdp, targetSessionId, "field.value"), "field.value")).toBe("hi");
        } finally {
          cdp.close();
        }
      } finally {
        await stopChrome(child);
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
