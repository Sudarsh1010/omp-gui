/**
 * A degraded omp-backed section (T20 ships this shell; #23 wires
 * `onUseBundled`, #24 is the first real consumer besides App Preferences
 * itself): names the failure stage, offers "Use bundled omp" and "Open App
 * Preferences" so the page degrades to a recovery path rather than a blank
 * screen (ADR-0011 "Bootstrap independence").
 */
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@omp-gui/ui/components/alert";
import { Button } from "@omp-gui/ui/components/button";

export interface SectionErrorProps {
  title: string;
  /** Which step failed (`resolve` | `spawn` | `exit` | `parse`, …) — shown
   * in mono so it reads as machine truth, not prose. */
  stage?: string;
  message: string;
  onUseBundled?: () => void;
  onOpenAppPreferences?: () => void;
}

export function SectionError({
  title,
  stage,
  message,
  onUseBundled,
  onOpenAppPreferences,
}: SectionErrorProps) {
  return (
    <Alert variant="destructive">
      <WarningCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {stage && <span className="font-mono text-[10px] text-muted-foreground">{stage}: </span>}
        {message}
      </AlertDescription>
      {(onUseBundled || onOpenAppPreferences) && (
        <div className="col-start-2 mt-2 flex gap-2">
          {onUseBundled && (
            <Button size="sm" variant="outline" onClick={onUseBundled}>
              Use bundled omp
            </Button>
          )}
          {onOpenAppPreferences && (
            <Button size="sm" variant="outline" onClick={onOpenAppPreferences}>
              Open App Preferences
            </Button>
          )}
        </div>
      )}
    </Alert>
  );
}
