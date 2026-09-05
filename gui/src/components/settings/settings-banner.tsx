/**
 * Landing banner shown at the top of App Preferences when the page routed
 * there because every omp-backed section is degraded (T20 ships the
 * component; #24 wires the redirect rule, ADR-0011's "lands on App
 * Preferences with a banner" requirement).
 */
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription } from "@omp-gui/ui/components/alert";
import { Button } from "@omp-gui/ui/components/button";

export interface SettingsBannerAction {
  label: string;
  onClick: () => void;
}

export interface SettingsBannerProps {
  message: string;
  actions?: SettingsBannerAction[];
}

export function SettingsBanner({ message, actions = [] }: SettingsBannerProps) {
  return (
    <Alert variant="destructive" className="mb-3">
      <WarningCircleIcon />
      <AlertDescription>{message}</AlertDescription>
      {actions.length > 0 && (
        <div className="col-start-2 mt-2 flex gap-2">
          {actions.map((action) => (
            <Button key={action.label} size="sm" variant="outline" onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </Alert>
  );
}
