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
import { spawnOmp } from "./node-transport";
import { RpcSession } from "./session-core";

const pin = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../omp-pin.json"), "utf8"),
) as {
  version: string;
};

const binary =
  process.env.OMP_GUI_OMP_PATH ?? join(import.meta.dirname, "../../../crates/shell/binaries/omp");

describe("rpc-ui session core against the pinned omp binary", () => {
  let sandbox: string | undefined;

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  it("round-trips: ready frame, protocol negotiation, canned command", async () => {
    // Isolated HOME so the test never touches the developer's omp state.
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const { transport, child } = spawnOmp(binary, sandbox);
    try {
      const session = await RpcSession.start(transport);

      expect(session.ready.type).toBe("ready");
      expect(session.ready.supportedProtocolVersions).toContain(2);
      expect(session.protocolVersion).toBe(2);

      const response = await session.command({ type: "get_state" });
      expect(response.type).toBe("response");
      expect(response.command).toBe("get_state");
      expect(response.success).toBe(true);

      session.close();
    } finally {
      child.kill();
    }
  }, 30_000);

  it("surfaces command errors instead of hanging", async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omp-gui-test-"));
    const { transport, child } = spawnOmp(binary, sandbox);
    try {
      const session = await RpcSession.start(transport);
      await expect(
        session.command({ type: "switch_session", sessionPath: "/nonexistent/session.jsonl" }),
      ).rejects.toThrow();
      session.close();
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe("the recorded pin (ADR-0004)", () => {
  it("matches the fetched binary", () => {
    const out = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
    expect(out).toContain(pin.version);
  });
});
