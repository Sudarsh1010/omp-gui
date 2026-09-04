/**
 * Seam test (T25, issue #19/#25): drives `authProvidersList`/
 * `authAccountsList`/`authLogout` (`crates/shell/src/auth.rs`'s Rust
 * mirror; here exercised through `nodeBridge`'s own shell-outs) and
 * `createAccountsController` against the REAL pinned omp binary — never
 * mocked, same discipline as the sibling seam tests in this package.
 *
 * Unlike `login.test.ts`/`models.test.ts`, these bridge methods never spawn
 * `--mode rpc-ui` (no live model credential needed to exercise them): they
 * shell out directly to `omp auth-broker list --json` and `omp token
 * <provider> --list`, mirroring `auth.rs`'s `run_omp_cli`-backed commands.
 *
 * `authAccountsList` calls `token <provider> --list` once per provider from
 * the real ~69-entry catalog (the CLI has no bulk-listing mode — see
 * `auth.rs`'s module doc) — each ~0.5-1s, so a full list takes roughly a
 * minute. Tests below share that cost across as few full-catalog fetches
 * as the required coverage allows, with generous timeouts rather than
 * mocking it away.
 *
 * Each test gets its own `PI_CODING_AGENT_DIR` via `nodeBridge`'s
 * `agentDir` option (added by this ticket) rather than relying on a
 * process-wide env var, so `authAccountsList`'s claim ("empty in a fresh
 * agent dir") is verified against a store this test itself created and
 * owns, never the real `~/.omp`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import {
  createAccountsController,
  type AccountsController,
  type AccountsSnapshot,
} from "./accounts-controller";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

const FULL_LIST_TIMEOUT_MS = 180_000;

/** Await an `AccountsController`'s snapshot once `predicate` passes — the
 * controller notifies synchronously on every change (including the
 * constructor's own initial reload), so this resolves off that
 * notification rather than polling. Mirrors `login.test.ts`'s
 * `waitForSnapshot`. */
async function waitForSnapshot(
  controller: AccountsController,
  predicate: (snapshot: AccountsSnapshot) => boolean,
): Promise<AccountsSnapshot> {
  const { promise, resolve } = Promise.withResolvers<AccountsSnapshot>();
  const unsubscribe = controller.subscribe(() => {
    const snapshot = controller.snapshot();
    if (predicate(snapshot)) resolve(snapshot);
  });
  const initial = controller.snapshot();
  if (predicate(initial)) resolve(initial);
  const result = await promise;
  unsubscribe();
  return result;
}

describe("auth bridge methods against the pinned omp binary", () => {
  let agentDir: string | undefined;
  let sandbox: string | undefined;

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    agentDir = undefined;
    sandbox = undefined;
  });

  it("authProvidersList parses the real auth-broker catalog", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-agentdir-"));
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox, { agentDir });

    const providers = await bridge.authProvidersList!();

    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(typeof provider.id).toBe("string");
      expect(provider.id.length).toBeGreaterThan(0);
      expect(typeof provider.name).toBe("string");
    }
    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.name).toBeTruthy();
  }, 30_000);

  it(
    "authAccountsList parses to an empty list in a fresh agent dir",
    async () => {
      agentDir = mkdtempSync(join(tmpdir(), "omp-gui-agentdir-"));
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
      const bridge = nodeBridge(binary, sandbox, { agentDir });

      const accounts = await bridge.authAccountsList!();

      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts).toEqual([]);
    },
    FULL_LIST_TIMEOUT_MS,
  );

  it("authLogout succeeds against a provider with nothing stored", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-agentdir-"));
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox, { agentDir });

    await expect(bridge.authLogout!("anthropic")).resolves.toBeUndefined();
  }, 30_000);
});

describe("createAccountsController against the pinned omp binary", () => {
  let agentDir: string | undefined;
  let sandbox: string | undefined;
  let controller: AccountsController | undefined;

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    agentDir = undefined;
    sandbox = undefined;
  });

  it(
    "joins providers with accounts into rows, then logout keeps the snapshot ready",
    async () => {
      agentDir = mkdtempSync(join(tmpdir(), "omp-gui-agentdir-"));
      sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
      const bridge = nodeBridge(binary, sandbox, { agentDir });

      controller = createAccountsController(bridge);
      const snapshot = await waitForSnapshot(controller, (s) => s.status !== "loading");

      expect(snapshot.status).toBe("ready");
      expect(snapshot.error).toBeUndefined();
      expect(snapshot.rows.length).toBeGreaterThan(0);

      const anthropicRow = snapshot.rows.find((row) => row.providerId === "anthropic");
      expect(anthropicRow).toBeDefined();
      expect(anthropicRow?.loggedInAs).toBeNull();
      for (const row of snapshot.rows) {
        expect(row.loggedInAs).toBeNull();
      }

      // Independent verification: re-fetch the provider catalog directly,
      // bypassing the controller's own state, to prove `rows` is a faithful
      // join of the two bridge calls rather than any invented row.
      const providers = await bridge.authProvidersList!();
      expect(snapshot.rows.map((row) => row.providerId).sort()).toEqual(
        providers.map((p) => p.id).sort(),
      );

      // `logout` shells out (no session needed) and reloads — the snapshot
      // stays "ready" with no error rather than getting stuck mid-flight.
      await controller.logout("anthropic");
      const afterLogout = controller.snapshot();
      expect(afterLogout.status).toBe("ready");
      expect(afterLogout.error).toBeUndefined();
    },
    FULL_LIST_TIMEOUT_MS * 2,
  );
});
