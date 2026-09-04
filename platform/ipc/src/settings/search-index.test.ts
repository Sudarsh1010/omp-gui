/**
 * Pure unit tests for `buildSearchIndex`/`searchSettings` (#28, issue #19
 * story #19/#20): no bridge, no binary — every ranking tier and the
 * substring/token match exercised against hand-built `SearchSource`s.
 */
import { describe, expect, it } from "vite-plus/test";
import { buildSearchIndex, searchSettings, type SearchSource } from "./search-index";

function source(overrides: Partial<SearchSource> & Pick<SearchSource, "rowKey" | "label">): SearchSource {
  return {
    section: "advanced",
    sectionLabel: "Advanced",
    to: "/settings/advanced",
    ...overrides,
  };
}

describe("searchSettings", () => {
  it("returns nothing for a blank or whitespace-only query", () => {
    const index = buildSearchIndex([source({ rowKey: "retry.maxRetries", label: "Max retries", keyPath: "retry.maxRetries" })]);
    expect(searchSettings(index, "")).toEqual([]);
    expect(searchSettings(index, "   ")).toEqual([]);
  });

  it("finds a row by a key-path fragment", () => {
    const index = buildSearchIndex([
      source({ rowKey: "retry.maxRetries", label: "Max retries", keyPath: "retry.maxRetries" }),
      source({ rowKey: "theme", label: "Theme", keyPath: "theme" }),
    ]);
    const hits = searchSettings(index, "maxRetries");
    expect(hits.map((h) => h.rowKey)).toEqual(["retry.maxRetries"]);
  });

  it("finds a row by a label word", () => {
    const index = buildSearchIndex([
      source({ rowKey: "chromium-path", label: "Chromium path", keyPath: "chromiumPath" }),
    ]);
    expect(searchSettings(index, "chromium").map((h) => h.rowKey)).toEqual(["chromium-path"]);
  });

  it("finds a row by a description word when the key and label don't match", () => {
    const index = buildSearchIndex([
      source({
        rowKey: "tab.browser.headless",
        label: "Headless",
        keyPath: "browser.headless",
        description: "Runs the browser pane without a visible window.",
      }),
    ]);
    expect(searchSettings(index, "visible").map((h) => h.rowKey)).toEqual(["tab.browser.headless"]);
  });

  it("is case-insensitive", () => {
    const index = buildSearchIndex([source({ rowKey: "theme", label: "Theme", keyPath: "theme" })]);
    expect(searchSettings(index, "THEME").map((h) => h.rowKey)).toEqual(["theme"]);
  });

  it("excludes a row where no token of a multi-word query appears anywhere", () => {
    const index = buildSearchIndex([source({ rowKey: "theme", label: "Theme", keyPath: "theme" })]);
    expect(searchSettings(index, "theme nonexistent")).toEqual([]);
  });

  it("ranks a key-path exact prefix above a key-path substring match", () => {
    const index = buildSearchIndex([
      source({ rowKey: "browser.chromiumPath", label: "Chromium path", keyPath: "browser.chromiumPath" }),
      source({ rowKey: "chromiumPath", label: "Legacy Chromium path", keyPath: "chromiumPath" }),
    ]);
    // "chromiumPath" is a substring of both, but a prefix only of the second.
    expect(searchSettings(index, "chromiumPath").map((h) => h.rowKey)).toEqual([
      "chromiumPath",
      "browser.chromiumPath",
    ]);
  });

  it("ranks a key-path match above a label-only match", () => {
    const index = buildSearchIndex([
      source({ rowKey: "row-a", label: "Retry budget", keyPath: "somethingElse" }),
      source({ rowKey: "row-b", label: "Unrelated", keyPath: "retry.budget" }),
    ]);
    expect(searchSettings(index, "retry").map((h) => h.rowKey)).toEqual(["row-b", "row-a"]);
  });

  it("ranks a label match above a description-only match", () => {
    const index = buildSearchIndex([
      source({ rowKey: "row-a", label: "Unrelated", description: "Mentions retries somewhere in prose." }),
      source({ rowKey: "row-b", label: "Retry policy" }),
    ]);
    expect(searchSettings(index, "retr").map((h) => h.rowKey)).toEqual(["row-b", "row-a"]);
  });

  it("matches tokens scattered across different fields, ranked last", () => {
    const index = buildSearchIndex([
      source({ rowKey: "row-both", label: "alpha beta" }),
      source({ rowKey: "row-scattered", label: "alpha", description: "beta appears here" }),
    ]);
    const hits = searchSettings(index, "alpha beta");
    expect(hits.map((h) => h.rowKey)).toEqual(["row-both", "row-scattered"]);
  });

  it("preserves every SearchSource field on a hit", () => {
    const src = source({
      section: "tab:model",
      sectionLabel: "Model",
      to: "/settings/model",
      group: "Retries",
      rowKey: "tab.retry.maxRetries",
      keyPath: "retry.maxRetries",
      label: "Max retries",
      description: "How many times a failed request is retried.",
    });
    const index = buildSearchIndex([src]);
    expect(searchSettings(index, "max retries")).toEqual([src]);
  });
});
