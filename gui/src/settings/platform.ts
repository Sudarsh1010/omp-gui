/**
 * The GUI's own OS fact for `SchemaCondition`'s `platform` kind (#26,
 * ADR-0011 §"schema/structure"): `platform/ipc`'s `evaluateCondition` has
 * no DOM/OS access of its own (it's a pure package shared with Node seam
 * tests), so the webview supplies its `ConditionEnv.platform` from here.
 * The webview never exposes `process.platform` — only `navigator` — so
 * this reads the user-agent string, matching the three values
 * `SchemaCondition`'s `platform` field can ever name (macOS conditions
 * are the only ones the pinned schema declares today; `win32`/`linux`
 * are named for completeness against `ConditionEnv`'s own type).
 */
export function detectPlatform(): "darwin" | "linux" | "win32" | string {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(ua)) return "darwin";
  if (/Windows/i.test(ua)) return "win32";
  if (/Linux/i.test(ua)) return "linux";
  return ua;
}
