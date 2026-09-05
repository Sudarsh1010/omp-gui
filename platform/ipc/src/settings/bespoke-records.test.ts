/**
 * Seam tests for the three bespoke-editor claimed keys (#29, issue #19
 * stories #27-29; ADR-0011 "Bespoke sections") — driven through
 * `createSettingsController` + `nodeBridge` against the real pinned omp
 * binary, exactly like `settings-controller.test.ts`. Each write is
 * verified independently by shelling out to `omp config get <key> --json`
 * directly (never through the bridge under test), so a passing assertion
 * means omp itself reports the exact record shape the editor wrote — not
 * just that the controller's own snapshot echoed it back. Each test gets
 * its own `PI_CODING_AGENT_DIR`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import {
  createSettingsController,
  type SettingsController,
  type SettingsSnapshot,
} from "./settings-controller";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/** Awaits a `SettingsController`'s snapshot once `predicate` passes, the
 * same helper `settings-controller.test.ts` uses — the controller
 * notifies synchronously on every change, so this resolves off that
 * notification rather than polling. */
async function waitForSnapshot(
  controller: SettingsController,
  predicate: (snapshot: SettingsSnapshot) => boolean,
): Promise<SettingsSnapshot> {
  const { promise, resolve } = Promise.withResolvers<SettingsSnapshot>();
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

describe("bespoke-editor claimed keys against the real omp binary", () => {
  let agentDir: string | undefined;
  let cwd: string | undefined;
  let controller: SettingsController | undefined;

  afterEach(() => {
    controller?.dispose();
    controller = undefined;
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    agentDir = undefined;
    cwd = undefined;
  });

  function makeController(): SettingsController {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-bespoke-records-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-bespoke-records-cwd-"));
    const bridge = nodeBridge(binary, cwd, { agentDir });
    controller = createSettingsController(bridge);
    return controller;
  }

  /** Shells out to `omp config get <key> --json` directly — independent of
   * the bridge/controller under test — and returns its parsed `value`
   * field, the shape a user would see from the terminal. */
  function configGet(key: string): unknown {
    const output = execFileSync(binary, ["config", "get", key, "--json"], {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
    });
    return JSON.parse(output).value;
  }

  it("tools.approval: writing a per-tool policy record reads back the exact shape", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");

    await ctl.set("tools.approval", { bash: "deny", eval: "allow" });

    expect(ctl.snapshot().rows.get("tools.approval")?.rejected).toBeUndefined();
    expect(ctl.snapshot().entries.get("tools.approval")?.value).toEqual({
      bash: "deny",
      eval: "allow",
    });
    expect(configGet("tools.approval")).toEqual({ bash: "deny", eval: "allow" });
  }, 30_000);

  it("retry.fallbackChains: writing an ordered per-role chain record reads back the exact shape", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");

    await ctl.set("retry.fallbackChains", {
      default: ["openai/gpt-4o-mini", "anthropic/claude-3-5-haiku"],
      "google-antigravity/*": ["google/*"],
    });

    expect(ctl.snapshot().rows.get("retry.fallbackChains")?.rejected).toBeUndefined();
    const expected = {
      default: ["openai/gpt-4o-mini", "anthropic/claude-3-5-haiku"],
      "google-antigravity/*": ["google/*"],
    };
    expect(ctl.snapshot().entries.get("retry.fallbackChains")?.value).toEqual(expected);
    expect(configGet("retry.fallbackChains")).toEqual(expected);
  }, 30_000);

  it("providers.maxInFlightRequests: writing a positive per-provider limit record reads back the exact shape", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");

    await ctl.set("providers.maxInFlightRequests", { openai: 3, anthropic: 1 });

    expect(ctl.snapshot().rows.get("providers.maxInFlightRequests")?.rejected).toBeUndefined();
    expect(ctl.snapshot().entries.get("providers.maxInFlightRequests")?.value).toEqual({
      openai: 3,
      anthropic: 1,
    });
    expect(configGet("providers.maxInFlightRequests")).toEqual({ openai: 3, anthropic: 1 });
  }, 30_000);

  it("providers.maxInFlightRequests: a non-positive value is rejected by omp's own validator and reported as rejected", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");
    const before = ctl.snapshot().entries.get("providers.maxInFlightRequests");

    await ctl.set("providers.maxInFlightRequests", { openai: 0 });

    expect(ctl.snapshot().entries.get("providers.maxInFlightRequests")).toEqual(before);
    expect(ctl.snapshot().rows.get("providers.maxInFlightRequests")?.rejected).toContain(
      "positive",
    );
    // omp never wrote the rejected value — the on-disk record stays at
    // its schema default.
    expect(configGet("providers.maxInFlightRequests")).toEqual({});
  }, 30_000);
});
