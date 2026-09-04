/**
 * Shared `CliError` narrowing for every omp-backed settings controller
 * (`settings-controller.ts`, `accounts-controller.ts`,
 * `models-catalog.ts`): extracts `{ stage, message }` from a
 * `BridgeCommandError<CliError>`, falling back to a bare message for
 * anything else (a transport-level failure, not omp's own `CliError`
 * shape). `Rejected` has no stage of its own — it's omp's validation, not
 * a transport stage — so it reports `"rejected"` explicitly, giving a
 * degraded `SectionError` something to show under "stage" either way.
 */
import { BridgeCommandError } from "../bridge/shell-bridge";

export function describeCliError(error: unknown): { stage: string; message: string } {
  if (error instanceof BridgeCommandError) {
    const cliError = error.error;
    if (cliError && typeof cliError === "object" && "type" in cliError) {
      if (cliError.type === "unavailable") {
        return { stage: cliError.stage, message: cliError.message };
      }
      if (cliError.type === "rejected") {
        return { stage: "rejected", message: cliError.message };
      }
    }
  }
  return { stage: "unknown", message: error instanceof Error ? error.message : String(error) };
}
