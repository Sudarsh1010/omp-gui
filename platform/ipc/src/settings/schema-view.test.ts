/**
 * Pure unit tests for `buildSchemaView` (#26, issue #19; ADR-0011
 * §"schema/structure"): hand-built `ConfigSchema` fixtures, no bridge, no
 * binary — covers tab/group ordering, the uiless bucket, terminal-only
 * marking at the row and group level, the modified-from-default
 * derivation, claimed-key exclusion, and live condition visibility.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ConfigEntry, ConfigSchema, SchemaEntry } from "../bindings/bindings.gen";
import { buildSchemaView } from "./schema-view";
import type { ConditionEnv } from "./conditions";

const env: ConditionEnv = { platform: "linux", terminalCapabilities: new Set() };

function schemaEntry(overrides: Partial<SchemaEntry> & { key: string }): SchemaEntry {
  return {
    type: "boolean",
    default: false,
    values: null,
    tab: null,
    group: null,
    label: null,
    description: null,
    warning: null,
    options: null,
    ordered: false,
    secret: false,
    condition: null,
    ...overrides,
  };
}

function configEntry(key: string, value: ConfigEntry["value"]): ConfigEntry {
  return { key, value, valueType: "boolean", description: "" };
}

describe("buildSchemaView", () => {
  it("buckets tab-less keys into uiless, independent of claim status", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: [] }],
      settings: [
        schemaEntry({ key: "enabledModels", type: "array", default: [] }),
        schemaEntry({ key: "advisor.enabled", tab: "model", group: "Advisor", label: "Advisor" }),
      ],
    };
    const view = buildSchemaView(schema, new Map(), new Set(["enabledModels"]), env);
    expect(view.uiless).toEqual(["enabledModels"]);
  });

  it("renders groups in the tab's declared TAB_GROUPS order, omitting empty groups", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: ["Thinking", "Sampling", "Advisor"] }],
      settings: [
        schemaEntry({
          key: "sampling.temperature",
          type: "number",
          tab: "model",
          group: "Sampling",
        }),
        schemaEntry({ key: "advisor.enabled", tab: "model", group: "Advisor" }),
      ],
    };
    const view = buildSchemaView(schema, new Map(), new Set(), env);
    const tab = view.tabs[0];
    expect(tab.groups.map((g) => g.name)).toEqual(["Sampling", "Advisor"]);
  });

  it("excludes a claimed key from its tab's groups", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: ["Retry & Fallback"] }],
      settings: [
        schemaEntry({
          key: "retry.fallbackChains",
          type: "array",
          tab: "model",
          group: "Retry & Fallback",
        }),
      ],
    };
    const view = buildSchemaView(schema, new Map(), new Set(["retry.fallbackChains"]), env);
    expect(view.tabs[0].groups).toEqual([]);
  });

  it("falls back to ungrouped for a missing group or one the tab never declared", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: ["Sampling"] }],
      settings: [
        schemaEntry({ key: "noGroup", tab: "model" }),
        schemaEntry({ key: "strayGroup", tab: "model", group: "Nonexistent Group" }),
      ],
    };
    const view = buildSchemaView(schema, new Map(), new Set(), env);
    expect(view.tabs[0].groups).toEqual([]);
    expect(view.tabs[0].ungrouped.map((r) => r.entry.key)).toEqual(["noGroup", "strayGroup"]);
  });

  it("marks a row terminal-only by tui.* key prefix or a terminal condition, and a group only when every row is", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "appearance", label: "Appearance", groups: ["Images", "Mixed"] }],
      settings: [
        schemaEntry({
          key: "terminal.showImages",
          tab: "appearance",
          group: "Images",
          condition: { kind: "terminal", capability: "imageProtocol" },
        }),
        schemaEntry({ key: "tui.hyperlinks", tab: "appearance", group: "Mixed" }),
        schemaEntry({ key: "display.shimmer", tab: "appearance", group: "Mixed" }),
      ],
    };
    const view = buildSchemaView(schema, new Map(), new Set(), env);
    const images = view.tabs[0].groups.find((g) => g.name === "Images")!;
    expect(images.terminalOnly).toBe(true);
    expect(images.rows[0].terminalOnly).toBe(true);

    const mixed = view.tabs[0].groups.find((g) => g.name === "Mixed")!;
    expect(mixed.terminalOnly).toBe(false);
    expect(mixed.rows.find((r) => r.entry.key === "tui.hyperlinks")?.terminalOnly).toBe(true);
    expect(mixed.rows.find((r) => r.entry.key === "display.shimmer")?.terminalOnly).toBe(false);
  });

  it("derives modified by JSON-deep comparison against the schema default", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: ["Advisor"] }],
      settings: [
        schemaEntry({ key: "advisor.enabled", tab: "model", group: "Advisor", default: false }),
        schemaEntry({
          key: "advisor.syncBacklog",
          type: "enum",
          default: "off",
          tab: "model",
          group: "Advisor",
        }),
      ],
    };
    const entries = new Map([
      ["advisor.enabled", configEntry("advisor.enabled", false)],
      ["advisor.syncBacklog", configEntry("advisor.syncBacklog", "3")],
    ]);
    const view = buildSchemaView(schema, entries, new Set(), env);
    const rows = view.tabs[0].groups[0].rows;
    expect(rows.find((r) => r.entry.key === "advisor.enabled")?.modified).toBe(false);
    expect(rows.find((r) => r.entry.key === "advisor.syncBacklog")?.modified).toBe(true);
  });

  it("is not modified when the entry is missing from the reported list", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: ["Advisor"] }],
      settings: [
        schemaEntry({ key: "advisor.enabled", tab: "model", group: "Advisor", default: false }),
      ],
    };
    const view = buildSchemaView(schema, new Map(), new Set(), env);
    expect(view.tabs[0].groups[0].rows[0].modified).toBe(false);
    expect(view.tabs[0].groups[0].rows[0].value).toBeUndefined();
  });

  it("resolves visibility live against a setting condition's current value", () => {
    const schema: ConfigSchema = {
      version: "1",
      tabs: [{ id: "model", label: "Model", groups: ["Advisor"] }],
      settings: [
        schemaEntry({ key: "advisor.enabled", tab: "model", group: "Advisor", default: false }),
        schemaEntry({
          key: "advisor.immuneTurns",
          type: "number",
          default: 3,
          tab: "model",
          group: "Advisor",
          condition: { kind: "setting", dependsOn: "advisor.enabled", equals: true },
        }),
      ],
    };
    const off = buildSchemaView(
      schema,
      new Map([["advisor.enabled", configEntry("advisor.enabled", false)]]),
      new Set(),
      env,
    );
    const on = buildSchemaView(
      schema,
      new Map([["advisor.enabled", configEntry("advisor.enabled", true)]]),
      new Set(),
      env,
    );
    const dependentOff = off.tabs[0].groups[0].rows.find(
      (r) => r.entry.key === "advisor.immuneTurns",
    )!;
    const dependentOn = on.tabs[0].groups[0].rows.find(
      (r) => r.entry.key === "advisor.immuneTurns",
    )!;
    expect(dependentOff.visible).toBe(false);
    expect(dependentOn.visible).toBe(true);
  });
});
