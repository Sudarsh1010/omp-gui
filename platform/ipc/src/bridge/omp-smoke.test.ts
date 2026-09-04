/**
 * Seam test for `nodeBridge`'s `ompSmokeTest` (T23, issue #23, ADR-0004):
 * proves the TypeScript mirror of `crates/shell/src/smoke.rs`'s smoke
 * sequence against the REAL pinned omp binary (success case) and a fake
 * executable (failure case, named stage) -- never mocked, matching every
 * other seam test in this package. Kept small and separate from
 * `session/smoke.test.ts` (the ADR-0008 protocol suite over `RpcSession`
 * directly): this file is specifically about the bridge method a GUI row
 * or a future node-only caller would call.
 */
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { nodeBridge } from "./node";

const binary =
  process.env.OMP_GUI_OMP_PATH ?? join(import.meta.dirname, "../../../../crates/shell/binaries/omp");

describe("nodeBridge().ompSmokeTest against the pinned omp binary", () => {
  it(
    "passes and reports the pinned version",
    async () => {
      const bridge = nodeBridge(binary, process.cwd());
      const report = await bridge.ompSmokeTest?.(binary);
      expect(report?.version).toContain("18.1.10");
    },
    30_000,
  );

  it(
    "fails at a named stage for a non-omp executable",
    async () => {
      const bridge = nodeBridge(binary, process.cwd());
      // `/bin/sh` rejects the omp-style `--mode rpc-ui` argument as an
      // unrecognized option and exits immediately with nothing on stdout
      // -- a stand-in for "some other binary that happens to be
      // executable but is not omp" (mirrors `smoke.rs`'s own unit test).
      await expect(bridge.ompSmokeTest?.("/bin/sh")).rejects.toMatchObject({
        name: "SmokeTestError",
        stage: expect.stringMatching(/^(launch|ready)$/),
      });
    },
    15_000,
  );

  it(
    "fails at the launch stage for a nonexistent path",
    async () => {
      const bridge = nodeBridge(binary, process.cwd());
      await expect(bridge.ompSmokeTest?.("/nonexistent/omp/binary/path")).rejects.toMatchObject({
        name: "SmokeTestError",
        stage: "launch",
      });
    },
    15_000,
  );
});
