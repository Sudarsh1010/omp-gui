/**
 * Fetches `omp config schema --json` once per app session and caches the
 * in-flight/resolved promise in module state (ADR-0011 §"schema/
 * structure"): the Advanced section (#24) is the first of several
 * Settings consumers that want `SchemaEntry.values` (enum choices) or
 * `.secret` off of it, and there is no reason to shell out to `omp` again
 * for every mounted row. An override binary that predates `config schema`
 * rejects — callers degrade (#24 falls an enum row back to a free-text
 * input) rather than block on it forever. A rejection is not cached, and
 * `invalidateConfigSchema()` drops a cached success, so recovering from a
 * broken override ("Use bundled omp", "Retry") re-asks the binary that is
 * actually running now.
 */
import { useEffect, useState } from "react";
import type { ConfigSchema, ShellBridge } from "@omp-gui/ipc";

export type ConfigSchemaState =
  | { status: "loading" }
  | { status: "ready"; schema: ConfigSchema }
  | { status: "unavailable" };

let cachedSchema: Promise<ConfigSchema> | undefined;
let generation = 0;
const listeners = new Set<() => void>();

function loadConfigSchema(bridge: ShellBridge): Promise<ConfigSchema> {
  if (!cachedSchema) {
    const attempt = bridge.configSchema
      ? bridge.configSchema()
      : Promise.reject(new Error("this ShellBridge does not implement configSchema"));
    cachedSchema = attempt;
    attempt.catch(() => {
      if (cachedSchema === attempt) cachedSchema = undefined;
    });
  }
  return cachedSchema;
}

/** Forget any cached schema and make every mounted `useConfigSchema`
 * re-fetch — call after the resolved omp binary may have changed. */
export function invalidateConfigSchema(): void {
  cachedSchema = undefined;
  generation += 1;
  for (const listener of listeners) listener();
}

export function useConfigSchema(bridge: ShellBridge): ConfigSchemaState {
  const [state, setState] = useState<ConfigSchemaState>({ status: "loading" });
  const [version, setVersion] = useState(generation);

  useEffect(() => {
    const listener = () => setVersion(generation);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadConfigSchema(bridge).then(
      (schema) => {
        if (!cancelled) setState({ status: "ready", schema });
      },
      () => {
        if (!cancelled) setState({ status: "unavailable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, version]);

  return state;
}
