/**
 * Per-route-mount Settings context (T20, issue #19/#20): `{ bridge,
 * preferences }` created once in `routes/settings.tsx` from the root
 * router context, plus every field a later Settings ticket adds — kept
 * optional so concurrent tickets extending this file never collide on the
 * same properties (`settings?: SettingsController` #24, `models?:
 * ModelsCatalogController` #27, `accounts?` #25).
 */
import { createContext, useContext, type ReactNode } from "react";
import type { AppPreferencesController, BrowserShellBridge } from "@omp-gui/ipc";

export interface SettingsContextValue {
  bridge: BrowserShellBridge;
  preferences: AppPreferencesController;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export interface SettingsProviderProps {
  value: SettingsContextValue;
  children: ReactNode;
}

export function SettingsProvider({ value, children }: SettingsProviderProps) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettingsContext(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettingsContext must be used within a SettingsProvider");
  }
  return context;
}
