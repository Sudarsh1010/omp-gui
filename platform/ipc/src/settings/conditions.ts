/**
 * Declarative visibility-condition evaluator (ADR-0011 §"schema/structure",
 * contract §F, #26): the app-side half of `SchemaCondition` — the shell
 * only ever describes conditions, it never evaluates them (ADR-0011's
 * rejection of importing `SETTINGS_SCHEMA` into the renderer applies just
 * as much to a condition evaluator). Every kind is evaluated live against
 * the values the binary currently reports, never baked in at build time,
 * so toggling a dependency re-runs this and the dependent row appears or
 * disappears without a reload (issue #19 story #18).
 *
 * - `setting`: compares the depended-on key's current `ConfigEntry.value`
 *   to `equals` with JSON-deep equality (`config list --json` already
 *   resolves an unset key to its schema default, so comparing the raw
 *   reported value is correct even when the key has never been written).
 * - `platform`: compares to the GUI's own OS, supplied by the caller
 *   (`gui/src/settings/platform.ts`) since this package has no DOM/OS
 *   access of its own.
 * - `terminal`: always `false` in the GUI — there is no terminal capability
 *   to query from a webview. The row is not hidden for this reason alone;
 *   `schema-view.ts` marks it `terminalOnly` instead of dropping it, since
 *   a `terminal` condition is itself the strongest terminal-only signal
 *   the schema carries.
 */
import type { ConfigEntry, JsonValue, SchemaCondition } from "../bindings/bindings.gen";

/** The platform/terminal facts a `SchemaCondition` can be evaluated
 * against — supplied by the caller since this package has no environment
 * access of its own (mirrors `ConfigEntry`'s own bridge-supplied shape). */
export interface ConditionEnv {
  platform: "darwin" | "linux" | "win32" | string;
  /** Terminal capability names the active terminal reports (TUI-only
   * concept). Always empty in the GUI — kept on the env shape so a
   * `terminal` condition has something to compare against if this
   * evaluator is ever reused outside the GUI. */
  terminalCapabilities: Set<string>;
}

/** Deep-equality for `JsonValue` — arrays compare element-wise in order,
 * records compare by key set and recursive value equality, everything
 * else by `===`. `undefined` and `null` are treated as the same "absent"
 * value since `ConfigEntry.value`/`SchemaEntry.default` use `null` for
 * "no value" while a lookup miss (`Map.get` returning `undefined`)
 * expresses the same fact one level up. */
export function jsonValueEquals(
  a: JsonValue | null | undefined,
  b: JsonValue | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonValueEquals(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => bKeys.includes(key) && jsonValueEquals(a[key], b[key]));
  }
  return false;
}

/**
 * Evaluates one `SchemaEntry.condition` against the current config
 * entries. `null` (no condition) is always visible.
 */
export function evaluateCondition(
  condition: SchemaCondition | null,
  values: ReadonlyMap<string, ConfigEntry>,
  env: ConditionEnv,
): boolean {
  if (!condition) return true;
  switch (condition.kind) {
    case "setting":
      return jsonValueEquals(values.get(condition.dependsOn)?.value, condition.equals);
    case "platform":
      return env.platform === condition.platform;
    case "terminal":
      // No terminal exists in the GUI; `schema-view.ts` marks the row
      // `terminalOnly` instead of relying on visibility to convey that.
      return false;
  }
}
