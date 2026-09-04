/**
 * The App Preferences Chromium-path row (#22, issue #19): a validated path
 * field the Browser Pane's Chromium resolution consumes
 * (`crates/shell/src/browser.rs`'s `resolve_chromium_executable`) — no
 * Tauri dialog plugin is wired in yet (`01-shell-bridge.md`), so this
 * stands in for an executable picker. Commits on blur/Enter; an empty
 * value clears the preference; a path that isn't an executable file is
 * rejected inline without writing. The environment-variable override
 * (`OMP_GUI_CHROMIUM_PATH`, or the ecosystem-standard
 * `PUPPETEER_EXECUTABLE_PATH`) always wins over this preference, and the
 * effective value plus where it came from render in mono underneath, from
 * `preferencesEffective`.
 */
import { useEffect, useState } from "react";
import type { EffectiveChromiumPath } from "@omp-gui/ipc";
import { Input } from "@omp-gui/ui/components/input";
import { useAppPreferences } from "@gui/settings/use-app-preferences";
import { useSettingsContext } from "./settings-context";
import { SettingsRow, type RowStatus } from "./settings-row";

function effectiveCaption(effective: EffectiveChromiumPath): string {
  switch (effective.source) {
    case "env":
      return `${effective.value} · env ${effective.envVar} wins`;
    case "preference":
      return `${effective.value} · from preference`;
    case "cache":
      return `${effective.value} · found in Chrome for Testing cache`;
    case "none":
      return "No Chrome for Testing binary found";
  }
}

export function ChromiumPathRow() {
  const { bridge, preferences } = useSettingsContext();
  const snapshot = useAppPreferences(preferences);
  const saved = snapshot.prefs.chromiumPath ?? "";

  const [value, setValue] = useState(saved);
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });
  const [effective, setEffective] = useState<EffectiveChromiumPath | null>(null);

  useEffect(() => {
    setValue(saved);
  }, [saved]);

  const loadEffective = async () => {
    const result = await bridge.preferencesEffective?.();
    if (result) setEffective(result.chromium);
  };

  useEffect(() => {
    void loadEffective();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = async () => {
    const trimmed = value.trim();
    if (trimmed === saved) return;

    if (trimmed !== "") {
      const probe = await bridge.pathProbe?.(trimmed);
      if (probe && !probe.isExecutable) {
        setStatus({
          kind: "rejected",
          message: !probe.exists
            ? "File does not exist"
            : probe.isDir
              ? "Not a file"
              : "Not executable",
        });
        setValue(saved);
        return;
      }
    }

    setStatus({ kind: "saving" });
    try {
      await preferences.update({ chromiumPath: trimmed === "" ? null : trimmed });
      setStatus({ kind: "saved" });
      window.setTimeout(() => {
        setStatus((current) => (current.kind === "saved" ? { kind: "idle" } : current));
      }, 1500);
      await loadEffective();
    } catch (error) {
      setStatus({
        kind: "rejected",
        message: error instanceof Error ? error.message : String(error),
      });
      setValue(saved);
    }
  };

  return (
    <SettingsRow
      rowKey="chromium-path"
      label="Chromium path"
      description={
        effective
          ? `Used by the Browser Pane. The ${effective.envVar} (or PUPPETEER_EXECUTABLE_PATH) environment variable always wins over this.`
          : "Used by the Browser Pane. An environment variable override always wins over this."
      }
      keyPath="chromiumPath"
      modified={saved !== ""}
      status={status}
    >
      <div className="flex min-w-0 flex-col items-end gap-1">
        <Input
          value={value}
          placeholder="Auto-detected"
          className="w-64 font-mono"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {effective && (
          <span
            className="max-w-64 truncate font-mono text-[11px] text-muted-foreground"
            title={effectiveCaption(effective)}
          >
            {effectiveCaption(effective)}
          </span>
        )}
      </div>
    </SettingsRow>
  );
}
