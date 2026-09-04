/**
 * Pure unit tests for `evaluateCondition`/`jsonValueEquals` (#26, issue
 * #19 story #18, ADR-0011 §"schema/structure"): no bridge, no binary —
 * every `SchemaCondition` kind evaluated against a hand-built entries map
 * and `ConditionEnv`.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ConfigEntry, SchemaCondition } from "../bindings/bindings.gen";
import { evaluateCondition, jsonValueEquals, type ConditionEnv } from "./conditions";

function entry(key: string, value: ConfigEntry["value"]): ConfigEntry {
  return { key, value, valueType: "boolean", description: "" };
}

const env: ConditionEnv = { platform: "linux", terminalCapabilities: new Set() };

describe("jsonValueEquals", () => {
  it("treats null and undefined as the same absent value", () => {
    expect(jsonValueEquals(null, undefined)).toBe(true);
    expect(jsonValueEquals(undefined, undefined)).toBe(true);
  });

  it("compares primitives by value", () => {
    expect(jsonValueEquals(true, true)).toBe(true);
    expect(jsonValueEquals(true, false)).toBe(false);
    expect(jsonValueEquals("idle", "idle")).toBe(true);
    expect(jsonValueEquals(3, 3)).toBe(true);
    expect(jsonValueEquals(3, 4)).toBe(false);
  });

  it("compares arrays element-wise, order-sensitively", () => {
    expect(jsonValueEquals(["a", "b"], ["a", "b"])).toBe(true);
    expect(jsonValueEquals(["a", "b"], ["b", "a"])).toBe(false);
    expect(jsonValueEquals(["a"], ["a", "b"])).toBe(false);
  });

  it("compares records by key set and recursive equality, independent of key order", () => {
    expect(jsonValueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonValueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonValueEquals({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });
});

describe("evaluateCondition", () => {
  it("is visible when there is no condition", () => {
    expect(evaluateCondition(null, new Map(), env)).toBe(true);
  });

  it("setting kind: true when the depended-on entry's value equals `equals`", () => {
    const condition: SchemaCondition = { kind: "setting", dependsOn: "advisor.enabled", equals: true };
    const values = new Map([["advisor.enabled", entry("advisor.enabled", true)]]);
    expect(evaluateCondition(condition, values, env)).toBe(true);
  });

  it("setting kind: false when the depended-on entry's value differs", () => {
    const condition: SchemaCondition = { kind: "setting", dependsOn: "advisor.enabled", equals: true };
    const values = new Map([["advisor.enabled", entry("advisor.enabled", false)]]);
    expect(evaluateCondition(condition, values, env)).toBe(false);
  });

  it("setting kind: false when the depended-on key is missing entirely", () => {
    const condition: SchemaCondition = { kind: "setting", dependsOn: "advisor.enabled", equals: true };
    expect(evaluateCondition(condition, new Map(), env)).toBe(false);
  });

  it("setting kind: compares non-boolean equals with JSON-deep equality", () => {
    const condition: SchemaCondition = {
      kind: "setting",
      dependsOn: "advisor.syncBacklog",
      equals: "off",
    };
    const values = new Map([["advisor.syncBacklog", entry("advisor.syncBacklog", "off")]]);
    expect(evaluateCondition(condition, values, env)).toBe(true);
  });

  it("platform kind: true only when env.platform matches", () => {
    const condition: SchemaCondition = { kind: "platform", platform: "darwin" };
    expect(evaluateCondition(condition, new Map(), env)).toBe(false);
    expect(
      evaluateCondition(condition, new Map(), { platform: "darwin", terminalCapabilities: new Set() }),
    ).toBe(true);
  });

  it("terminal kind: always false in the GUI, regardless of reported capabilities", () => {
    const condition: SchemaCondition = { kind: "terminal", capability: "imageProtocol" };
    expect(evaluateCondition(condition, new Map(), env)).toBe(false);
    expect(
      evaluateCondition(condition, new Map(), {
        platform: "linux",
        terminalCapabilities: new Set(["imageProtocol"]),
      }),
    ).toBe(false);
  });
});
