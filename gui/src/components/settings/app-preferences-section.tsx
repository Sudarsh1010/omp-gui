/**
 * App Preferences section (T20, issue #19/#20): the page's one section
 * that always renders, independent of omp (ADR-0011). Kept deliberately
 * small — each row lives in its own file so #22 (`working-directory-row`),
 * #23 (`chromium-path-row`, `omp-binary-row`) add a one-line import here
 * rather than touching this file's body.
 */
import { SettingsGroup } from "./settings-group";
import { ThemeRow } from "./theme-row";
import { OmpBinaryRow } from "./omp-binary-row";

export function AppPreferencesSection() {
  return (
    <>
      <SettingsGroup title="Appearance">
        <ThemeRow />
      </SettingsGroup>
      <OmpBinaryRow />
    </>
  );
}
