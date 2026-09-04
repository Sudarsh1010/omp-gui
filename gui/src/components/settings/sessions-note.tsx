/**
 * Footer line for every omp-backed section and every App Preferences row
 * that a running session doesn't hot-reload — default working directory,
 * Chromium path, omp binary override (#22/#23) — so the reader never
 * wonders why a running session didn't pick up a change (issue #19 story
 * #14, ADR-0011's "sessions started afterwards" rule).
 */
export function SessionsNote() {
  return (
    <p className="px-1 text-xs text-muted-foreground">
      Changes apply to sessions started from now on.
    </p>
  );
}
