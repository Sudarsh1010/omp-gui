/**
 * Real-binary seam test (v1 spec's primary seam, ADR-0008-style) for the
 * login controller (T14, issue #15): drives `createLoginController`
 * against the real pinned omp binary over stdin/stdout NDJSON, mirroring
 * `models.test.ts`'s harness — omp's OAuth provider registry is never
 * mocked.
 *
 * Covers two of #15's four acceptance criteria directly:
 *   - `get_login_providers` returns a real provider list, and the
 *     controller's snapshot reflects each provider's `authenticated`
 *     ("logged in as…") state read-only, as a verbatim projection of that
 *     list (independently re-verified below, not just the module's own
 *     echo).
 *   - `login()` sends the `login` command, and the resulting `open_url`
 *     `extension_ui_request` elicitation is surfaced on the snapshot.
 *
 * ## Boundary this suite cannot cross headlessly
 *
 * Finishing an OAuth login needs a real browser and a human completing an
 * external provider's consent screen. omp's "anthropic" provider
 * (`AnthropicOAuthFlow`, `@oh-my-pi/pi-ai`'s `registry/oauth/anthropic.ts`)
 * builds its authorization URL and binds its local loopback callback
 * server before it ever touches the network, so the `open_url` elicitation
 * is reachable here with no network access and no credentials — but the
 * `login` command itself then blocks server-side (up to
 * `OAuthCallbackFlow`'s five-minute default timeout) waiting for that
 * browser round trip to complete. This suite therefore never awaits
 * `login()`'s own resolution: it only asserts the command was sent and the
 * elicitation frame arrived, then tears the session down (which kills the
 * still-pending login along with the omp subprocess). The full
 * command -> elicitation -> browser -> credential-stored path is exercised
 * by hand, not by this automated suite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient, type IpcSessionHandle } from "../client";
import { nodeBridge } from "../bridge/node";
import { createLoginController, type LoginController, type LoginSnapshot } from "./login";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/** Await a `LoginController`'s snapshot once `predicate` passes — the
 * store notifies synchronously on every change (including the initial
 * `get_login_providers` round trip's completion), so this resolves off
 * that notification rather than polling. Mirrors `models.test.ts`'s
 * `waitForSnapshot`. */
async function waitForSnapshot(
  controller: LoginController,
  predicate: (snapshot: LoginSnapshot) => boolean,
): Promise<LoginSnapshot> {
  const { promise, resolve } = Promise.withResolvers<LoginSnapshot>();
  const unsubscribe = controller.subscribe(() => {
    const snapshot = controller.getSnapshot();
    if (predicate(snapshot)) resolve(snapshot);
  });
  const initial = controller.getSnapshot();
  if (predicate(initial)) resolve(initial);
  const result = await promise;
  unsubscribe();
  return result;
}

describe("createLoginController against the pinned omp binary", () => {
  let sandbox: string | undefined;
  let handle: IpcSessionHandle | undefined;
  let controller: LoginController | undefined;

  afterEach(async () => {
    controller?.dispose();
    controller = undefined;
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

  it("lists real OAuth providers and reflects authenticated state read-only", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    controller = createLoginController(handle.session);
    const snapshot = await waitForSnapshot(controller, (s) => !s.loading);

    expect(snapshot.error).toBeUndefined();
    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(snapshot.providers.length).toBeGreaterThan(0);

    const anthropic = snapshot.providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(typeof anthropic?.authenticated).toBe("boolean");
    expect(anthropic?.name).toBeTruthy();

    // Independent verification: re-fetch directly, bypassing the module's
    // own state, to prove the snapshot is exactly the wire data — no
    // derived or invented identity field, per ADR-0009 (the app stores
    // and computes no credential-adjacent state of its own).
    const live = await handle.session.command({ type: "get_login_providers" });
    expect(snapshot.providers).toEqual(live.data.providers);
  }, 30_000);

  it("sends the login command and surfaces the open_url elicitation", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    controller = createLoginController(handle.session);
    await waitForSnapshot(controller, (s) => !s.loading);

    // Fire-and-forget — see this file's header comment: `login`'s own
    // response doesn't arrive until the whole OAuth round trip resolves,
    // which needs a real browser and a human, never in this suite.
    // `afterEach` tears the session down mid-flight, which rejects any
    // still-pending command; attach a no-op handler so that isn't an
    // unhandled rejection.
    void controller.login("anthropic").catch(() => {});

    const snapshot = await waitForSnapshot(controller, (s) => s.elicitation !== undefined);

    expect(snapshot.pendingProviderId).toBe("anthropic");
    expect(snapshot.elicitation?.url).toMatch(/^https:\/\//);
    expect(snapshot.elicitation?.id).toBeTruthy();
  }, 30_000);
});
