/**
 * Pure unit tests for the bespoke-editor record helpers (#29, issue #19
 * stories #27-29) — no bridge, no binary. `bespoke-records.test.ts` covers
 * the seam (a write reaching omp and reading back as the right shape);
 * this file covers only the in-memory record algebra each editor calls
 * into.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  addChainEntry,
  addChainKey,
  moveChainEntry,
  removeChainKey,
  setProviderLimit,
  setToolPolicy,
  validateLimit,
} from "./records";

describe("setToolPolicy", () => {
  it("adds a tool's policy", () => {
    expect(setToolPolicy({}, "bash", "deny")).toEqual({ bash: "deny" });
  });

  it("overwrites an existing policy", () => {
    expect(setToolPolicy({ bash: "deny" }, "bash", "allow")).toEqual({ bash: "allow" });
  });

  it("removes the tool entirely when policy is undefined (Clear / inherits mode)", () => {
    expect(setToolPolicy({ bash: "deny", eval: "allow" }, "bash", undefined)).toEqual({ eval: "allow" });
  });

  it("leaves other tools untouched", () => {
    expect(setToolPolicy({ eval: "prompt" }, "bash", "deny")).toEqual({ eval: "prompt", bash: "deny" });
  });

  it("is a no-op clearing a tool that was never set", () => {
    const record = { eval: "prompt" as const };
    expect(setToolPolicy(record, "bash", undefined)).toBe(record);
  });
});

describe("moveChainEntry", () => {
  const record = { default: ["a", "b", "c"] };

  it("swaps an entry up", () => {
    expect(moveChainEntry(record, "default", 1, "up")).toEqual({ default: ["b", "a", "c"] });
  });

  it("swaps an entry down", () => {
    expect(moveChainEntry(record, "default", 1, "down")).toEqual({ default: ["a", "c", "b"] });
  });

  it("is a no-op moving the first entry up", () => {
    expect(moveChainEntry(record, "default", 0, "up")).toBe(record);
  });

  it("is a no-op moving the last entry down", () => {
    expect(moveChainEntry(record, "default", 2, "down")).toBe(record);
  });

  it("is a no-op for an out-of-range index", () => {
    expect(moveChainEntry(record, "default", 9, "up")).toBe(record);
    expect(moveChainEntry(record, "default", -1, "remove")).toBe(record);
  });

  it("is a no-op for a key that is not in the record", () => {
    expect(moveChainEntry(record, "slow", 0, "remove")).toBe(record);
  });

  it("removes one entry, keeping the others in order", () => {
    expect(moveChainEntry(record, "default", 1, "remove")).toEqual({ default: ["a", "c"] });
  });

  it("drops the key entirely when removing its last entry", () => {
    expect(moveChainEntry({ default: ["only"] }, "default", 0, "remove")).toEqual({});
  });
});

describe("addChainEntry", () => {
  it("appends to an existing chain", () => {
    expect(addChainEntry({ default: ["a"] }, "default", "b")).toEqual({ default: ["a", "b"] });
  });

  it("creates the key when absent", () => {
    expect(addChainEntry({}, "smol", "openai/gpt-4o-mini")).toEqual({ smol: ["openai/gpt-4o-mini"] });
  });

  it("trims the selector", () => {
    expect(addChainEntry({}, "smol", "  openai/gpt-4o-mini  ")).toEqual({ smol: ["openai/gpt-4o-mini"] });
  });

  it("is a no-op for a blank selector", () => {
    const record = { default: ["a"] };
    expect(addChainEntry(record, "default", "   ")).toBe(record);
  });
});

describe("addChainKey", () => {
  it("adds a new empty key", () => {
    expect(addChainKey({}, "openai/*")).toEqual({ "openai/*": [] });
  });

  it("is a no-op for a key already present", () => {
    const record = { "openai/*": ["a"] };
    expect(addChainKey(record, "openai/*")).toBe(record);
  });

  it("is a no-op for a blank key", () => {
    const record = {};
    expect(addChainKey(record, "   ")).toBe(record);
  });
});

describe("removeChainKey", () => {
  it("drops the key", () => {
    expect(removeChainKey({ default: ["a"], smol: ["b"] }, "default")).toEqual({ smol: ["b"] });
  });

  it("is a no-op for a key not present", () => {
    const record = { default: ["a"] };
    expect(removeChainKey(record, "slow")).toBe(record);
  });
});

describe("setProviderLimit", () => {
  it("sets a provider's limit", () => {
    expect(setProviderLimit({}, "openai", 3)).toEqual({ openai: 3 });
  });

  it("overwrites an existing limit", () => {
    expect(setProviderLimit({ openai: 3 }, "openai", 5)).toEqual({ openai: 5 });
  });

  it("removes the provider when limit is undefined (empty input)", () => {
    expect(setProviderLimit({ openai: 3, anthropic: 2 }, "openai", undefined)).toEqual({ anthropic: 2 });
  });

  it("is a no-op removing a provider that was never set", () => {
    const record = { anthropic: 2 };
    expect(setProviderLimit(record, "openai", undefined)).toBe(record);
  });
});

describe("validateLimit", () => {
  it("accepts a positive integer", () => {
    expect(validateLimit("3")).toEqual({ kind: "valid", value: 3 });
  });

  it("trims surrounding whitespace", () => {
    expect(validateLimit("  8  ")).toEqual({ kind: "valid", value: 8 });
  });

  it("treats blank text as the empty/clear case, not invalid", () => {
    expect(validateLimit("")).toEqual({ kind: "empty" });
    expect(validateLimit("   ")).toEqual({ kind: "empty" });
  });

  it("rejects zero", () => {
    expect(validateLimit("0")).toEqual({ kind: "invalid", message: expect.any(String) });
  });

  it("rejects negative numbers", () => {
    expect(validateLimit("-1")).toEqual({ kind: "invalid", message: expect.any(String) });
  });

  it("rejects non-integers", () => {
    expect(validateLimit("1.5")).toEqual({ kind: "invalid", message: expect.any(String) });
  });

  it("rejects non-numeric text", () => {
    expect(validateLimit("many")).toEqual({ kind: "invalid", message: expect.any(String) });
  });
});
