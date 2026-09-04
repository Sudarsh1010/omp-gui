/**
 * Seam test for `createAppPreferencesController`, driven through
 * `nodeBridge`'s file-backed App Preferences implementation against a temp
 * file per test — never mocked. App Preferences has zero omp dependency
 * (ADR-0011), so unlike every other seam test in this package this one
 * never spawns the pinned binary at all.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import { createAppPreferencesController } from "./app-preferences";

describe("createAppPreferencesController against nodeBridge's file-backed preferences", () => {
  let sandbox: string | undefined;

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  function makeSandbox(): { preferencesPath: string; cwd: string } {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-app-preferences-test-"));
    return { preferencesPath: join(sandbox, "preferences.json"), cwd: sandbox };
  }

  it("update persists to disk and refreshes the snapshot from the written value", async () => {
    const { preferencesPath, cwd } = makeSandbox();
    const bridge = nodeBridge("unused", cwd, { preferencesPath });
    const controller = createAppPreferencesController(bridge);

    const written = await controller.update({ theme: "dark" });

    expect(written.theme).toBe("dark");
    expect(controller.snapshot().status).toBe("ready");
    expect(controller.snapshot().prefs.theme).toBe("dark");

    const onDisk = JSON.parse(readFileSync(preferencesPath, "utf8"));
    expect(onDisk.theme).toBe("dark");
    expect(onDisk.version).toBe(1);

    controller.dispose();
  });

  it("reload reflects an edit made outside the controller", async () => {
    const { preferencesPath, cwd } = makeSandbox();
    const bridge = nodeBridge("unused", cwd, { preferencesPath });
    const controller = createAppPreferencesController(bridge);
    await controller.update({ theme: "light" });

    writeFileSync(
      preferencesPath,
      JSON.stringify({
        version: 1,
        theme: "dark",
        ompPath: null,
        chromiumPath: null,
        defaultWorkingDirectory: null,
      }),
    );

    await controller.reload();

    expect(controller.snapshot().prefs.theme).toBe("dark");

    controller.dispose();
  });

  it("an unknown key already on disk survives an update", async () => {
    const { preferencesPath, cwd } = makeSandbox();
    writeFileSync(
      preferencesPath,
      JSON.stringify({ version: 1, theme: "system", futureKey: { nested: true } }),
    );
    const bridge = nodeBridge("unused", cwd, { preferencesPath });
    const controller = createAppPreferencesController(bridge);
    await controller.reload();

    await controller.update({ theme: "dark" });

    const onDisk = JSON.parse(readFileSync(preferencesPath, "utf8"));
    expect(onDisk.futureKey).toEqual({ nested: true });
    expect(onDisk.theme).toBe("dark");

    controller.dispose();
  });
});
