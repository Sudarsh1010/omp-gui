/**
 * Seam tests for `createSettingsController` (#24, issue #19), driven
 * through `nodeBridge` against the real pinned omp binary — the same
 * pattern as `../preferences/app-preferences.test.ts` for App
 * Preferences, but exercising the config CLI seam instead of a local
 * file. Each test gets its own `PI_CODING_AGENT_DIR`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import { createSettingsController, type SettingsController } from "./settings-controller";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

/** Awaits a `SettingsController`'s snapshot once `predicate` passes — the
 * controller notifies synchronously on every change (including the
 * initial `configList()` completing), so this resolves off that
 * notification rather than polling (mirrors `models.test.ts`'s
 * `waitForSnapshot`). */
async function waitForSnapshot(
  controller: SettingsController,
  predicate: (snapshot: ReturnType<SettingsController["snapshot"]>) => boolean,
): Promise<ReturnType<SettingsController["snapshot"]>> {
  const { promise, resolve } = Promise.withResolvers<ReturnType<SettingsController["snapshot"]>>();
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

describe("createSettingsController against nodeBridge's config bridge", () => {
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
    vi.useRealTimers();
  });

  function makeController(): SettingsController {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-settings-controller-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-settings-controller-cwd-"));
    const bridge = nodeBridge(binary, cwd, { agentDir });
    controller = createSettingsController(bridge);
    return controller;
  }

  it("a discrete set updates the entry in the snapshot", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");

    await ctl.set("autoResume", true);

    expect(ctl.snapshot().entries.get("autoResume")?.value).toBe(true);
    expect(ctl.snapshot().rows.get("autoResume")?.rejected).toBeUndefined();
  }, 30_000);

  it("a rejection leaves the entry unchanged and records rows[key].rejected", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");
    const before = ctl.snapshot().entries.get("retry.maxRetries");

    // A number-typed key: `serializeConfigValue` passes a string value
    // through as plain text (unlike boolean, which coerces truthiness),
    // so this genuinely reaches omp's own numeric parser and is rejected
    // by it — exercising the same path a text/number control's blur/Enter
    // commit would.
    await ctl.set("retry.maxRetries", "nope");

    expect(ctl.snapshot().entries.get("retry.maxRetries")).toEqual(before);
    expect(ctl.snapshot().rows.get("retry.maxRetries")?.rejected).toContain("Invalid number");
  }, 30_000);

  it("unset restores the entry to its schema default and marks the row saved", async () => {
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");
    await ctl.set("autoResume", true);
    expect(ctl.snapshot().entries.get("autoResume")?.value).toBe(true);

    await ctl.unset("autoResume");

    expect(ctl.snapshot().entries.get("autoResume")?.value).toBe(false);
    expect(ctl.snapshot().rows.get("autoResume")?.saved).toBe(true);
    expect(ctl.snapshot().rows.get("autoResume")?.rejected).toBeUndefined();
  }, 30_000);

  it("saved is set after a write and clears after the indicator window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ctl = makeController();
    await waitForSnapshot(ctl, (s) => s.status === "ready");

    await ctl.set("autoResume", true);

    expect(ctl.snapshot().rows.get("autoResume")?.saved).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);

    expect(ctl.snapshot().rows.get("autoResume")?.saved).toBe(false);
  }, 30_000);

  it("reports an error state naming the failure stage when the binary path is bogus", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-settings-controller-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-settings-controller-cwd-"));
    const bridge = nodeBridge("/nonexistent/not-omp", cwd, { agentDir });
    controller = createSettingsController(bridge);

    const snapshot = await waitForSnapshot(controller, (s) => s.status === "error");

    expect(snapshot.error?.stage).toBe("spawn");
    expect(snapshot.error?.message).toBeTruthy();
  }, 30_000);
});
