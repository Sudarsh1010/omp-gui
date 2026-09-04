/**
 * Seam tests (#24, issue #19; ADR-0011) driving `nodeBridge`'s
 * `configList`/`configSet`/`configReset`/`configUnset`/`configSchema`
 * against the real pinned omp binary — never a mock. Each test gets its
 * own `PI_CODING_AGENT_DIR` (via `nodeBridge`'s `agentDir` option) so
 * config/credential state never crosses tests or touches the real
 * `~/.omp`, matching the session/model/login seam tests in this package.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BridgeCommandError } from "../bridge/shell-bridge";
import { nodeBridge } from "../bridge/node";
import type { CliError } from "../bindings/bindings.gen";

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

describe("nodeBridge's config bridge against the pinned omp binary", () => {
  let agentDir: string | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    agentDir = undefined;
    cwd = undefined;
  });

  function makeBridge() {
    agentDir = mkdtempSync(join(tmpdir(), "omp-gui-config-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "omp-gui-config-cwd-"));
    return nodeBridge(binary, cwd, { agentDir });
  }

  it("list reflects a set", async () => {
    const bridge = makeBridge();
    const before = await bridge.configList!();
    const beforeEntry = before.find((entry) => entry.key === "autoResume");
    expect(beforeEntry?.value).toBe(false);

    const written = await bridge.configSet!("autoResume", "true");
    expect(written.value).toBe(true);
    expect(written.valueType).toBe("boolean");

    const after = await bridge.configList!();
    expect(after.find((entry) => entry.key === "autoResume")?.value).toBe(true);
  }, 30_000);

  it("rejects an unknown key with omp's own message", async () => {
    const bridge = makeBridge();
    await expect(bridge.configSet!("unknownKey.doesNotExist", "somevalue")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(BridgeCommandError);
        const cliError = (error as BridgeCommandError<CliError>).error;
        expect(cliError.type).toBe("rejected");
        expect(cliError.message).toContain("Unknown setting");
        return true;
      },
    );
  }, 30_000);

  it("rejects a mistyped value for a boolean key with omp's own message", async () => {
    const bridge = makeBridge();
    await expect(bridge.configSet!("autoResume", "notabool")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(BridgeCommandError);
        const cliError = (error as BridgeCommandError<CliError>).error;
        expect(cliError.type).toBe("rejected");
        expect(cliError.message).toContain("Invalid boolean value");
        return true;
      },
    );
  }, 30_000);

  it("reset writes the schema default", async () => {
    const bridge = makeBridge();
    await bridge.configSet!("autoResume", "true");
    expect((await bridge.configList!()).find((e) => e.key === "autoResume")?.value).toBe(true);

    const reset = await bridge.configReset!("autoResume");
    expect(reset.value).toBe(false);
    expect((await bridge.configList!()).find((e) => e.key === "autoResume")?.value).toBe(false);
  }, 30_000);

  it("unset removes the key entirely, and a direct `config get` shows the default", async () => {
    const bridge = makeBridge();
    await bridge.configSet!("autoResume", "true");

    await bridge.configUnset!("autoResume");

    const entry = (await bridge.configList!()).find((e) => e.key === "autoResume");
    expect(entry?.value).toBe(false);

    const got = execFileSync(binary, ["config", "get", "autoResume"], {
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
    }).trim();
    expect(got).toBe("false");
  }, 30_000);

  it("schema shape: ten tabs, every list key present in settings, condition kinds are the declared union", async () => {
    const bridge = makeBridge();
    const schema = await bridge.configSchema!();
    expect(schema.tabs).toHaveLength(10);

    const settingsKeys = new Set(schema.settings.map((entry) => entry.key));
    const listKeys = (await bridge.configList!()).map((entry) => entry.key);
    for (const key of listKeys) {
      expect(settingsKeys.has(key)).toBe(true);
    }

    const conditionKinds = new Set(
      schema.settings.flatMap((entry) => (entry.condition ? [entry.condition.kind] : [])),
    );
    for (const kind of conditionKinds) {
      expect(["setting", "platform", "terminal"]).toContain(kind);
    }
    expect(conditionKinds.size).toBeGreaterThan(0);
  }, 30_000);

  it("scratch-cwd isolation: a .claude/settings.json in the bridge's own cwd never leaks into configList", async () => {
    const bridge = makeBridge();
    mkdirSync(join(cwd!, ".claude"), { recursive: true });
    writeFileSync(join(cwd!, ".claude", "settings.json"), JSON.stringify({ autoResume: true }));

    const entry = (await bridge.configList!()).find((e) => e.key === "autoResume");
    expect(entry?.value).toBe(false);
  }, 30_000);
});
