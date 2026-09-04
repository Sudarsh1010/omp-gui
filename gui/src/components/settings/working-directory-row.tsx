/**
 * The App Preferences default-working-directory row (#22, issue #19): a
 * validated path field — no Tauri dialog plugin is wired in yet
 * (`01-shell-bridge.md`), so this stands in for a directory picker. The
 * value becomes the working directory `omp_start` spawns every *fresh*
 * session into (`crates/shell/src/omp.rs`'s `resolve_start_cwd`); a
 * resume always keeps the session's own recorded cwd instead. Commits on
 * blur/Enter (the Settings save model's text-field rule); an empty value
 * clears the preference; a path that isn't a directory is rejected inline
 * without writing. The effective value and where it came from (the
 * preference, the fallback home directory, or a preference whose target
 * no longer exists) render in mono underneath, from `preferencesEffective`.
 */
import { useEffect, useState } from "react";
import type { EffectiveWorkingDirectory } from "@omp-gui/ipc";
import { Input } from "@omp-gui/ui/components/input";
import { useAppPreferences } from "@gui/settings/use-app-preferences";
import { useSettingsContext } from "./settings-context";
import { SettingsRow, type RowStatus } from "./settings-row";

function effectiveCaption(effective: EffectiveWorkingDirectory): string {
  switch (effective.source) {
    case "preference":
      return `${effective.value} · from preference`;
    case "fallback":
      return `${effective.value} · preference no longer exists, using home`;
    case "home":
      return `${effective.value} · home directory (no preference set)`;
  }
}

export function WorkingDirectoryRow() {
  const { bridge, preferences } = useSettingsContext();
  const snapshot = useAppPreferences(preferences);
  const saved = snapshot.prefs.defaultWorkingDirectory ?? "";

  const [value, setValue] = useState(saved);
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });
  const [effective, setEffective] = useState<EffectiveWorkingDirectory | null>(null);

  useEffect(() => {
    setValue(saved);
  }, [saved]);

  const loadEffective = async () => {
    const result = await bridge.preferencesEffective?.();
    if (result) setEffective(result.workingDirectory);
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
      if (probe && !probe.isDir) {
        setStatus({
          kind: "rejected",
          message: probe.exists ? "Not a directory" : "Directory does not exist",
        });
        setValue(saved);
        return;
      }
    }

    setStatus({ kind: "saving" });
    try {
      await preferences.update({ defaultWorkingDirectory: trimmed === "" ? null : trimmed });
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
      rowKey="default-working-directory"
      label="Default working directory"
      description="New sessions start here. Resumed sessions always keep their own recorded directory."
      keyPath="defaultWorkingDirectory"
      modified={saved !== ""}
      status={status}
    >
      <div className="flex flex-col items-end gap-1">
        <Input
          value={value}
          placeholder="~ (home directory)"
          className="w-64 font-mono"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {effective && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {effectiveCaption(effective)}
          </span>
        )}
      </div>
    </SettingsRow>
  );
}
