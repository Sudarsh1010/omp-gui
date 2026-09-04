/**
 * Seam tests (#27, issue #19/#27; ADR-0011 "Bespoke sections") driving
 * `nodeBridge`'s `modelsList` (the Rust mirror in `crates/shell/src/
 * models.rs`) and `createModelsCatalogController` against the REAL pinned
 * omp binary — never mocked, same discipline as the sibling seam tests in
 * this package (`accounts.test.ts`, `config-bridge.test.ts`).
 *
 * `omp models --json` reports an empty catalog with zero credentials
 * present (note `04-omp-cli-surface.md` §6), so most tests here set fake
 * (non-functional) `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` env vars and run
 * `omp models refresh` once per agent dir before asserting on the catalog
 * — no network call validates the key just to list the static
 * per-provider catalog. Each test gets its own `PI_CODING_AGENT_DIR` (via
 * `nodeBridge`'s `agentDir` option), never the real `~/.omp`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "../bridge/node";
import { createSettingsController, type SettingsController } from "./settings-controller";
import {
  createModelsCatalogController,
  ENABLED_MODELS_EMPTY_MEANS_ALL,
  type ModelsCatalogController,
  type ModelsCatalogSnapshot,
} from "./models-catalog";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

const FAKE_CREDENTIAL_ENV = {
  ANTHROPIC_API_KEY: "sk-fake-test",
  OPENAI_API_KEY: "sk-fake-openai-test",
};

/** `omp models --json` filters its per-provider catalog by whatever
 * credential env vars are present *at call time* — the persisted
 * `models.db` a refresh writes is not enough on its own (note
 * `04-omp-cli-surface.md` §6). `nodeBridge`'s spawns inherit `process.env`
 * directly (`bridge/node.ts`'s `runOmpCli`), so exercising a populated
 * catalog through the bridge — not just through a hand-rolled
 * `execFileSync` call with its own env object — means these fake,
 * non-functional keys have to live on `process.env` itself for the
 * duration of the test. Saves and restores whatever was already there so
 * a real credential in the host environment is never clobbered. */
let savedAnthropicKey: string | undefined;
let savedOpenAiKey: string | undefined;

function setFakeCredentials(): void {
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  savedOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_CREDENTIAL_ENV.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = FAKE_CREDENTIAL_ENV.OPENAI_API_KEY;
}

function restoreCredentials(): void {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiKey;
  savedAnthropicKey = undefined;
  savedOpenAiKey = undefined;
}

/** Populates a fresh agent dir's model catalog: fake, non-functional
 * provider credentials are enough for `omp models refresh` to discover
 * the bundled anthropic/openai static catalogs — no network call
 * validates the key just to list models (note `04-omp-cli-surface.md`
 * §6). Callers must also hold `setFakeCredentials()` for any later
 * `omp models --json` read (via `nodeBridge` or otherwise) to see what
 * this writes. */
function refreshCatalog(agentDir: string): void {
  execFileSync(binary, ["models", "refresh"], {
    env: { ...process.env, ...FAKE_CREDENTIAL_ENV, PI_CODING_AGENT_DIR: agentDir },
    stdio: "ignore",
  });
}

function configGet(agentDir: string, key: string): string {
  return execFileSync(binary, ["config", "get", key], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
  }).trim();
}

/** Awaits a `ModelsCatalogController`'s snapshot once `predicate` passes
 * — the controller notifies synchronously on every change (including the
 * constructor's own initial reload and every settings-driven rebuild), so
 * this resolves off that notification rather than polling. Mirrors
 * `accounts.test.ts`/`settings-controller.test.ts`'s `waitForSnapshot`. */
async function waitForSnapshot(
  controller: ModelsCatalogController,
  predicate: (snapshot: ModelsCatalogSnapshot) => boolean,
): Promise<ModelsCatalogSnapshot> {
  const { promise, resolve } = Promise.withResolvers<ModelsCatalogSnapshot>();
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

describe("nodeBridge's modelsList against the pinned omp binary", () => {
  let agentDir: string | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    restoreCredentials();
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    agentDir = undefined;
    cwd = undefined;
  });

  it("parses the real catalog after a refresh with fake provider credentials", async () => {
    setFakeCredentials();
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-models-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-models-cwd-"));
    refreshCatalog(agentDir);
    const bridge = nodeBridge(binary, cwd, { agentDir });

    const catalog = await bridge.modelsList!();

    expect(Array.isArray(catalog.models)).toBe(true);
    expect(catalog.models.length).toBeGreaterThan(0);
    const providers = new Set(catalog.models.map((model) => model.provider));
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai")).toBe(true);
    for (const model of catalog.models) {
      expect(model.selector).toBe(`${model.provider}/${model.id}`);
      expect(typeof model.name).toBe("string");
      expect(model.name.length).toBeGreaterThan(0);
      expect(model.cost).toBeTruthy();
    }
  }, 60_000);

  it("returns an empty catalog with zero credentials present", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-models-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-models-cwd-"));
    const bridge = nodeBridge(binary, cwd, { agentDir });

    const catalog = await bridge.modelsList!();

    expect(catalog.models).toEqual([]);
  }, 30_000);
});

describe("createModelsCatalogController against the pinned omp binary", () => {
  let agentDir: string | undefined;
  let cwd: string | undefined;
  let settings: SettingsController | undefined;
  let controller: ModelsCatalogController | undefined;

  beforeEach(() => {
    setFakeCredentials();
  });

  afterEach(() => {
    controller?.dispose();
    settings?.dispose();
    controller = undefined;
    settings = undefined;
    restoreCredentials();
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    agentDir = undefined;
    cwd = undefined;
  });

  /** Fresh agent dir + refreshed catalog, wired into a real
   * `SettingsController` and `ModelsCatalogController` pair — the exact
   * composition the Models GUI route builds. */
  function makeController(): {
    catalog: ModelsCatalogController;
    settingsController: SettingsController;
  } {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-models-controller-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-models-controller-cwd-"));
    refreshCatalog(agentDir);
    const bridge = nodeBridge(binary, cwd, { agentDir });
    settings = createSettingsController(bridge);
    controller = createModelsCatalogController(bridge, settings);
    return { catalog: controller, settingsController: settings };
  }

  it("catalog groups by provider and every model reports enabled from an empty enabledModels", async () => {
    const { catalog, settingsController } = makeController();
    await waitForSnapshot(catalog, (s) => s.status !== "loading");
    const snapshot = await waitForSnapshot(
      catalog,
      (s) => s.status === "ready" && s.providers.length > 0,
    );

    expect(settingsController.snapshot().status).toBe("ready");
    const anthropic = snapshot.providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.enabled).toBe(true);
    expect(anthropic!.models.length).toBeGreaterThan(0);
    // ENABLED_MODELS_EMPTY_MEANS_ALL: a fresh config's enabledModels is
    // an empty array, so every discovered model must report enabled.
    expect(ENABLED_MODELS_EMPTY_MEANS_ALL).toBe(true);
    for (const provider of snapshot.providers) {
      for (const model of provider.models) {
        expect(model.enabled).toBe(true);
      }
    }
  }, 60_000);

  it("filter narrows providers and models by substring", async () => {
    const { catalog } = makeController();
    await waitForSnapshot(catalog, (s) => s.status === "ready" && s.providers.length > 0);

    catalog.setFilter("anthropic");
    const byProvider = catalog.snapshot();
    expect(byProvider.providers.length).toBe(1);
    expect(byProvider.providers[0]!.id).toBe("anthropic");

    catalog.setFilter("codex-mini");
    const byModel = catalog.snapshot();
    expect(byModel.providers.length).toBe(1);
    expect(byModel.providers[0]!.models.some((m) => m.id === "codex-mini-latest")).toBe(true);

    catalog.setFilter("");
    const cleared = catalog.snapshot();
    expect(cleared.providers.length).toBeGreaterThan(1);
  }, 60_000);

  it("setProviderEnabled writes disabledProviders, verified by config get", async () => {
    const { catalog } = makeController();
    await waitForSnapshot(catalog, (s) => s.status === "ready" && s.providers.length > 0);

    await catalog.setProviderEnabled("openai", false);

    expect(JSON.parse(configGet(agentDir!, "disabledProviders"))).toEqual(["openai"]);
    const disabled = await waitForSnapshot(
      catalog,
      (s) => s.providers.find((p) => p.id === "openai")?.enabled === false,
    );
    expect(disabled.providers.find((p) => p.id === "openai")?.enabled).toBe(false);

    await catalog.setProviderEnabled("openai", true);
    expect(JSON.parse(configGet(agentDir!, "disabledProviders"))).toEqual([]);
  }, 60_000);

  it("setModelEnabled(false) from the all-enabled state writes the full catalog minus that model", async () => {
    const { catalog } = makeController();
    const ready = await waitForSnapshot(
      catalog,
      (s) => s.status === "ready" && s.providers.length > 0,
    );
    const totalModels = ready.providers.reduce((sum, provider) => sum + provider.models.length, 0);
    const targetProvider = ready.providers[0]!;
    const target = targetProvider.models[0]!;

    await catalog.setModelEnabled(target.selector, false);

    const written: string[] = JSON.parse(configGet(agentDir!, "enabledModels"));
    expect(written.length).toBe(totalModels - 1);
    expect(written).not.toContain(target.selector);

    const afterDisable = await waitForSnapshot(
      catalog,
      (s) =>
        s.providers
          .find((p) => p.id === targetProvider.id)
          ?.models.find((m) => m.selector === target.selector)?.enabled === false,
    );
    expect(
      afterDisable.providers
        .find((p) => p.id === targetProvider.id)
        ?.models.find((m) => m.selector === target.selector)?.enabled,
    ).toBe(false);

    // Re-enabling appends it back onto the now-nonempty allow list rather
    // than clearing it entirely — omp's empty-means-all semantics only
    // special-case a genuinely empty list, never a list that merely
    // matches everything currently available.
    await catalog.setModelEnabled(target.selector, true);
    const rewritten: string[] = JSON.parse(configGet(agentDir!, "enabledModels"));
    expect(rewritten).toContain(target.selector);
    expect(rewritten.length).toBe(totalModels);
  }, 60_000);

  it("setRole writes modelRoles, verified by config get", async () => {
    const { catalog } = makeController();
    const ready = await waitForSnapshot(
      catalog,
      (s) => s.status === "ready" && s.providers.length > 0,
    );
    const target = ready.providers[0]!.models[0]!;

    await catalog.setRole("smol", target.selector);

    expect(JSON.parse(configGet(agentDir!, "modelRoles"))).toEqual({ smol: target.selector });
    const snapshot = await waitForSnapshot(catalog, (s) => s.roles.smol === target.selector);
    expect(snapshot.roles.smol).toBe(target.selector);
    expect(snapshot.roles.default).toBeUndefined();
  }, 60_000);
});
