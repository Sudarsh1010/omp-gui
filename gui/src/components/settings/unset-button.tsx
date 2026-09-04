/**
 * Hover-revealed "Reset to default" action (#24/#26, issue #19 story
 * #13): a per-row unset button, shown only when the caller's row value
 * differs from its schema default, shared by every generic Settings
 * section (`advanced-section.tsx`, `schema-tab-section.tsx`) so the
 * affordance looks and behaves identically everywhere instead of being
 * hand-rolled per section.
 */
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { Button } from "@omp-gui/ui/components/button";

export interface UnsetButtonProps {
  onUnset: () => void;
}

export function UnsetButton({ onUnset }: UnsetButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Reset to default"
      title="Reset to default"
      className="opacity-0 group-hover:opacity-100"
      onClick={onUnset}
    >
      <ArrowCounterClockwiseIcon />
    </Button>
  );
}
