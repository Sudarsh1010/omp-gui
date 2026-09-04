/**
 * Fetches `omp config schema --json` once per app session and caches the
 * in-flight/resolved promise in module state (ADR-0011 §"schema/
 * structure"): the Advanced section (#24) is the first of several
 * Settings consumers that want `SchemaEntry.values` (enum choices) or
 * `.secret` off of it, and there is no reason to shell out to `omp` again
 * for every mounted row. An override binary that predates `config schema`
 * rejects — callers degrade (#24 falls an enum row back to a free-text
 * input) rather than block on it forever.
 */
import { useEffect, useState } from "react";
import type { ConfigSchema, ShellBridge } from "@omp-gui/ipc";

export type ConfigSchemaState =
  | { status: "loading" }
  | { status: "ready"; schema: ConfigSchema }
  | { status: "unavailable" };

let cachedSchema: Promise<ConfigSchema> | undefined;

function loadConfigSchema(bridge: ShellBridge): Promise<ConfigSchema> {
  if (!cachedSchema) {
    cachedSchema = bridge.configSchema
      ? bridge.configSchema()
      : Promise.reject(new Error("this ShellBridge does not implement configSchema"));
  }
  return cachedSchema;
}

export function useConfigSchema(bridge: ShellBridge): ConfigSchemaState {
  const [state, setState] = useState<ConfigSchemaState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
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
  }, [bridge]);

  return state;
}
