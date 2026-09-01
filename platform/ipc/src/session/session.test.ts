/**
 * Seam 1 from the v1 spec: drive the session core against the real pinned omp
 * binary over stdin/stdout NDJSON. omp is never mocked — the pin is a fixed,
 * local, fast dependency; mocking it would test our assumptions about the
 * protocol rather than the protocol.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createIpcClient, type IpcSessionHandle } from "../client";
import { nodeBridge } from "../bridge/node";

const pin = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../../omp-pin.json"), "utf8"),
) as {
  version: string;
};

const binary =
  process.env.OMP_GUI_OMP_PATH ??
  join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

describe("rpc-ui session core against the pinned omp binary", () => {
  let sandbox: string | undefined;
  let handle: IpcSessionHandle | undefined;

  afterEach(async () => {
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

  it("round-trips: ready frame, protocol negotiation, canned command", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    expect(handle.session.ready.type).toBe("ready");
    expect(handle.session.ready.supportedProtocolVersions).toContain(2);
    expect(handle.session.protocolVersion).toBe(2);

    const response = await handle.session.command({ type: "get_state" });
    expect(response.type).toBe("response");
    expect(response.command).toBe("get_state");
    expect(response.success).toBe(true);
  }, 30_000);

  it("surfaces command errors instead of hanging", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const bridge = nodeBridge(binary, sandbox);
    const client = createIpcClient(bridge);
    handle = await client.startSession();

    await expect(
      handle.session.command({
        type: "switch_session",
        sessionPath: "/nonexistent/session.jsonl",
      }),
    ).rejects.toThrow();
  }, 30_000);
});

describe("the recorded pin (ADR-0004)", () => {
  it("matches the fetched binary", () => {
    const out = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
    expect(out).toContain(pin.version);
  });
});
