/**
 * The App Preferences Theme row (T20, issue #19 story #39): System / Light
 * / Dark, default System. Saves on change (a discrete control, per the
 * Settings save model) and shows the quiet inline "Saved"/rejected status
 * `SettingsRow` renders beside the control — never a toast. Applying the
 * chosen theme live is `main.tsx`'s job (it subscribes the shared
 * `AppPreferencesController` once for the whole app); this row only writes
 * the preference.
 */
import { useState } from "react";
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { ToggleGroup, ToggleGroupItem } from "@omp-gui/ui/components/toggle-group";
import type { Theme } from "@omp-gui/ipc";
import { useAppPreferences } from "@gui/settings/use-app-preferences";
import { useSettingsContext } from "./settings-context";
import { SettingsRow, type RowStatus } from "./settings-row";

const THEME_OPTIONS = [
  { value: "system" as const, label: "System", icon: DesktopIcon },
  { value: "light" as const, label: "Light", icon: SunIcon },
  { value: "dark" as const, label: "Dark", icon: MoonIcon },
];

export function ThemeRow() {
  const { preferences } = useSettingsContext();
  const snapshot = useAppPreferences(preferences);
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });
  const theme: Theme = snapshot.prefs.theme ?? "system";

  const onChange = async (next: Theme) => {
    if (next === theme) return;
    setStatus({ kind: "saving" });
    try {
      await preferences.update({ theme: next });
      setStatus({ kind: "saved" });
      window.setTimeout(() => {
        setStatus((current) => (current.kind === "saved" ? { kind: "idle" } : current));
      }, 1500);
    } catch (error) {
      setStatus({
        kind: "rejected",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <SettingsRow
      rowKey="theme"
      label="Theme"
      description="System follows your OS's light/dark setting."
      keyPath="theme"
      status={status}
    >
      <ToggleGroup
        value={[theme]}
        onValueChange={(values) => {
          const next = values[0] as Theme | undefined;
          if (next) void onChange(next);
        }}
      >
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <ToggleGroupItem key={value} value={value} aria-label={label}>
            <Icon />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingsRow>
  );
}
