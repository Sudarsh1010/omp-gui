/**
 * Approval policy editor (#29, issue #19 story #27; ADR-0011 "Bespoke
 * sections"): claims `tools.approval` out of the Interaction tab's
 * Approvals group (`claims.ts`) and renders it as one 32px row per known
 * tool — a 3-way allow/prompt/deny `ToggleGroup` plus a Clear button —
 * instead of the generic record's raw JSON editor. Sits directly under
 * the schema's own `tools.approvalMode` row (`schema-tab-section.tsx`
 * renders that generically, unclaimed) inside the same "Approvals" card.
 *
 * Tool list is the union of every `<tool>.enabled` key in the schema's
 * "Available Tools" group (Tools tab), the core tools that group never
 * lists (`bash`, `eval`, `task`, `read`, `write`, `edit` — no `.enabled`
 * toggle of their own), and any tool name already present in the record
 * (an override binary's tool the schema doesn't know about yet). An
 * unlisted tool still renders — never hidden — since an override policy
 * for it is otherwise inspectable only as raw JSON in Advanced.
 *
 * "Approval" is the glossary term (`gui/CONTEXT.md`) labeling the block.
 * Deny renders red text on a `destructive/10` wash (the Wash-Not-Block /
 * Two-Signals rules) — never a solid fill; an unset tool shows no
 * selection ("inherits mode": `tools.approvalMode` applies instead).
 */
import { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { XIcon } from "@phosphor-icons/react";
import { setToolPolicy, type ToolApprovalRecord, type ToolPolicy } from "@omp-gui/ipc";
import { Button } from "@omp-gui/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@omp-gui/ui/components/toggle-group";
import { cn } from "@omp-gui/ui/lib/utils";
import { useSettingsContext } from "../settings-context";
import { rowStatusFromState, SettingsRow } from "../settings-row";
import { useConfigSchema } from "@gui/settings/use-config-schema";
import type { BespokeEditorProps } from "./bespoke-editor";

/** Tools with no `<tool>.enabled` row in the schema's "Available Tools"
 * group — always eligible for a policy override regardless. */
const CORE_TOOLS = ["bash", "eval", "task", "read", "write", "edit"];

const POLICY_OPTIONS: ReadonlyArray<{ value: ToolPolicy; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "prompt", label: "Prompt" },
  { value: "deny", label: "Deny" },
];

const DENY_ON_CLASS =
  "aria-pressed:bg-destructive/10 aria-pressed:text-destructive data-[state=on]:bg-destructive/10 data-[state=on]:text-destructive";

export function ApprovalPolicyEditor({ entry, value }: BespokeEditorProps) {
  const { bridge, settings } = useSettingsContext();
  if (!settings) {
    throw new Error(
      "ApprovalPolicyEditor requires routes/settings.tsx's SettingsController in context",
    );
  }
  const controller = settings;
  const schemaState = useConfigSchema(bridge);
  // Subscribes to the same store `SchemaTabSection`'s `useSettings` already
  // reloads on mount/focus — reading it directly here (not through
  // `useSettings` again) avoids a second redundant `configList()` call.
  const rows = useSyncExternalStore(controller.subscribe, () => controller.snapshot().rows);

  const record = (value?.value as ToolApprovalRecord | undefined) ?? {};

  const tools = useMemo(() => {
    const names = new Set<string>();
    if (schemaState.status === "ready") {
      for (const setting of schemaState.schema.settings) {
        if (
          setting.tab === "tools" &&
          setting.group === "Available Tools" &&
          setting.key.endsWith(".enabled")
        ) {
          names.add(setting.key.slice(0, -".enabled".length));
        }
      }
    }
    for (const tool of CORE_TOOLS) names.add(tool);
    for (const tool of Object.keys(record)) names.add(tool);
    return [...names].sort();
  }, [schemaState, record]);

  function setPolicy(tool: string, policy: ToolPolicy | undefined) {
    void controller.set(entry.key, setToolPolicy(record, tool, policy));
  }

  const rowState = rows.get(entry.key);

  return (
    <div className="flex flex-col">
      <SettingsRow
        rowKey={`tab.${entry.key}`}
        label="Approval"
        description={entry.description ?? undefined}
        keyPath={entry.key}
        status={rowStatusFromState(rowState)}
      >
        {null}
      </SettingsRow>
      {tools.map((tool) => {
        const policy = record[tool];
        return (
          <div
            key={tool}
            data-settings-row={`tab.tools.approval.${tool}`}
            id={`row-tab.tools.approval.${tool}`}
            className="flex min-h-8 items-center justify-between gap-4 px-3 py-2"
          >
            <span className="truncate font-mono text-xs text-foreground">{tool}</span>
            <div className="flex shrink-0 items-center gap-1">
              <ToggleGroup
                size="sm"
                value={policy ? [policy] : []}
                onValueChange={(next) => setPolicy(tool, next[0] as ToolPolicy | undefined)}
              >
                {POLICY_OPTIONS.map((option) => (
                  <ToggleGroupItem
                    key={option.value}
                    value={option.value}
                    className={cn(option.value === "deny" && DENY_ON_CLASS)}
                  >
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Clear ${tool} approval override`}
                title="Clear — inherits the global mode"
                disabled={!policy}
                onClick={() => setPolicy(tool, undefined)}
              >
                <XIcon />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
