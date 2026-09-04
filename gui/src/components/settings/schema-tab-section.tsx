/**
 * One omp settings tab, rendered generically from `config schema --json`
 * (#26, issue #19; ADR-0011 §"schema/structure"): groups render as
 * `SettingsGroup` cards in `TAB_GROUPS` order, each row's editor chosen by
 * `pickEditor` (`editors/config-editor.tsx`, shared with `advanced-
 * section.tsx`) from `SchemaEntry.type`/`options`, and a dependent row
 * (`condition`) appears or disappears live as its parent changes —
 * `buildSchemaView` is rebuilt from scratch on every `entries` change, so
 * there is nothing to invalidate (issue #19 story #18). A terminal-
 * conditioned row is never hidden by its condition (that isn't the GUI's
 * call) — it renders with a "Terminal only" `Badge` beside its label
 * (`row.terminalOnly`), same as a `tui.*`-prefixed key; the group also
 * carries the badge when every row in it is terminal-only.
 *
 * A key claimed by a section with no tab home of its own (`models`) is
 * absent from `buildSchemaView`'s groups entirely (`claimed` below excludes
 * it, see `schema-view.ts`) — this component never has to special-case it.
 * A key claimed by a *tab-owned* bespoke section (`#29`'s approval/
 * fallback-chains/provider-limits editors — `claims.ts`'s `"tab:<id>"`
 * claims) stays in its own home tab's row list instead, since that is
 * exactly where its bespoke editor belongs; `BESPOKE_EDITORS` below is
 * consulted per row so it renders there once, in place of the generic
 * per-type editor, never as a second copy anywhere else.
 */
import { useMemo } from "react";
import type { ComponentType, ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { buildSchemaView, type SchemaRowView } from "@omp-gui/ipc";
import { Badge } from "@omp-gui/ui/components/badge";
import { useSettingsContext } from "./settings-context";
import { useSettings } from "@gui/settings/use-settings";
import { useConfigSchema } from "@gui/settings/use-config-schema";
import { useBundledOmp } from "@gui/settings/use-bundled-omp";
import { detectPlatform } from "@gui/settings/platform";
import { SettingsGroup } from "./settings-group";
import { SettingsRow, rowStatusFromState, type RowStatus } from "./settings-row";
import { SectionSkeleton } from "./section-skeleton";
import { SectionError } from "./section-error";
import { SessionsNote } from "./sessions-note";
import { UnsetButton } from "./unset-button";
import { CLAIMED_KEYS } from "./claims";
import { pickEditor, useLocalConfigErrors } from "./editors/config-editor";
import { ApprovalPolicyEditor } from "./bespoke/approval-policy-editor";
import { FallbackChainsEditor } from "./bespoke/fallback-chains-editor";
import { ProviderLimitsEditor } from "./bespoke/provider-limits-editor";
import type { BespokeEditorProps } from "./bespoke/bespoke-editor";

/** Claimed keys with their own bespoke schema-tab editor (#29) — every
 * other `"tab:<id>"` claim in `claims.ts` (there are none yet) would fall
 * through to the generic editor for its type. */
const BESPOKE_EDITORS: Record<string, ComponentType<BespokeEditorProps>> = {
  "tools.approval": ApprovalPolicyEditor,
  "retry.fallbackChains": FallbackChainsEditor,
  "providers.maxInFlightRequests": ProviderLimitsEditor,
};
export interface SchemaTabSectionProps {
  tabId: string;
}

export function SchemaTabSection({ tabId }: SchemaTabSectionProps) {
  const { bridge, settings } = useSettingsContext();
  if (!settings) {
    throw new Error(
      "SchemaTabSection requires routes/settings.tsx's SettingsController in context",
    );
  }
  const controller = settings;
  const snapshot = useSettings(controller);
  const schemaState = useConfigSchema(bridge);
  const useBundled = useBundledOmp();
  const navigate = useNavigate();
  const { localErrors, setLocalError } = useLocalConfigErrors();

  // Only fully excludes keys claimed by a section with no tab home of its
  // own (e.g. `models`) — a `"tab:<id>"` claim (#29's bespoke editors)
  // stays in `buildSchemaView`'s groups so it still renders at its
  // schema position, just via `BESPOKE_EDITORS` below instead of the
  // generic per-type editor.
  const claimed = useMemo(
    () =>
      new Set(
        Object.entries(CLAIMED_KEYS)
          .filter(([, claim]) => !claim.section.startsWith("tab:"))
          .map(([key]) => key),
      ),
    [],
  );
  const env = useMemo(
    () => ({ platform: detectPlatform(), terminalCapabilities: new Set<string>() }),
    [],
  );

  const view = useMemo(
    () =>
      schemaState.status === "ready"
        ? buildSchemaView(schemaState.schema, snapshot.entries, claimed, env)
        : undefined,
    [schemaState, snapshot.entries, claimed, env],
  );

  if (snapshot.status === "loading" && snapshot.entries.size === 0) {
    return <SectionSkeleton rows={8} />;
  }

  if (snapshot.status === "error") {
    return (
      <SectionError
        title="Settings unavailable"
        stage={snapshot.error?.stage}
        message={snapshot.error?.message ?? "omp is unreachable."}
        onUseBundled={() => void useBundled()}
        onOpenAppPreferences={() => void navigate({ to: "/settings/app-preferences" })}
      />
    );
  }

  if (schemaState.status === "unavailable") {
    return (
      <SectionError
        title="This omp predates `config schema`"
        message="The active omp binary is too old to describe its own settings tabs. Every key is still reachable under Advanced."
        onOpenAppPreferences={() => void navigate({ to: "/settings/advanced" })}
      />
    );
  }

  if (schemaState.status === "loading" || !view) {
    return <SectionSkeleton rows={8} />;
  }

  const tab = view.tabs.find((t) => t.id === tabId);
  if (!tab) {
    return (
      <SectionError
        title="Unknown tab"
        message={`omp's schema does not declare a tab named "${tabId}".`}
      />
    );
  }

  function renderRow(row: SchemaRowView): ReactNode {
    if (!row.visible || !row.value) return null;
    const { entry, value } = row;

    const Bespoke = BESPOKE_EDITORS[entry.key];
    if (Bespoke) {
      return <Bespoke key={entry.key} entry={entry} value={value} />;
    }

    const localError = localErrors.get(entry.key);
    const status: RowStatus = localError
      ? { kind: "rejected", message: localError }
      : rowStatusFromState(snapshot.rows.get(entry.key));
    const rejected = snapshot.rows.get(entry.key)?.rejected;
    const description =
      entry.options === "runtime" && entry.description
        ? `${entry.description} (choices resolved at runtime — type the value directly.)`
        : (entry.description ?? undefined);
    const onSet = (next: unknown) => {
      setLocalError(entry.key, undefined);
      void controller.set(entry.key, next);
    };
    const onInvalid = (message: string | undefined) => setLocalError(entry.key, message);

    return (
      <SettingsRow
        key={entry.key}
        rowKey={`tab.${entry.key}`}
        label={entry.label ?? entry.key}
        description={description}
        warning={entry.warning ?? undefined}
        badge={row.terminalOnly ? <Badge variant="outline">Terminal only</Badge> : undefined}
        keyPath={entry.key}
        modified={row.modified}
        status={status}
      >
        {row.modified && <UnsetButton onUnset={() => void controller.unset(entry.key)} />}
        {pickEditor({
          value,
          valueType: entry.type,
          schema: entry,
          rejected,
          onSet,
          onInvalid,
        })}
      </SettingsRow>
    );
  }

  return (
    <>
      {tab.ungrouped.length > 0 && (
        <SettingsGroup title="General">{tab.ungrouped.map(renderRow)}</SettingsGroup>
      )}
      {tab.groups.map((group) => (
        <SettingsGroup
          key={group.name}
          title={group.name}
          badge={group.terminalOnly ? <Badge variant="outline">Terminal only</Badge> : undefined}
        >
          {group.rows.map(renderRow)}
        </SettingsGroup>
      ))}
      <SessionsNote />
    </>
  );
}
