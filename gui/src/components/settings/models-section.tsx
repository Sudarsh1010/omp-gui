/**
 * Models section (#27, issue #19/#27; ADR-0011 "Bespoke sections"): three
 * role `Select`s (smol/default/slow) in a "Roles" group on top, then one
 * `SettingsGroup` per provider whose title row carries an enable `Switch`;
 * model rows are a `Checkbox` + name + context/cost in mono. An `Input`
 * filter at the top narrows providers/models by substring (issue #19
 * story #23). `enabledModels`/`disabledProviders`/`modelRoles` are the
 * claimed keys this section owns outright (`claims.ts`) — Advanced points
 * here instead of rendering them generically.
 *
 * Degrades to `SectionError` when either `modelsList` or the shared
 * config write path (`SettingsController`, threaded in by the route) fails
 * — independent of every other Settings section (ADR-0011 "Bootstrap
 * independence").
 */
import { useMemo } from "react";
import type { ModelRole, SettingsController, ShellBridge } from "@omp-gui/ipc";
import { Checkbox } from "@omp-gui/ui/components/checkbox";
import { Input } from "@omp-gui/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@omp-gui/ui/components/select";
import { Switch } from "@omp-gui/ui/components/switch";
import { useModelsCatalog } from "@gui/settings/use-models-catalog";
import { SectionError } from "./section-error";
import { SectionSkeleton } from "./section-skeleton";
import { SessionsNote } from "./sessions-note";
import { SettingsGroup } from "./settings-group";
import { SettingsRow } from "./settings-row";

export interface ModelsSectionProps {
  bridge: ShellBridge;
  settings: SettingsController;
}

const ROLES: ReadonlyArray<{ role: ModelRole; label: string; description: string }> = [
  { role: "smol", label: "Smol", description: "Fast, cheap model for lightweight tasks." },
  { role: "default", label: "Default", description: "The main model for ordinary turns." },
  { role: "slow", label: "Slow", description: "The most capable model for hard, slow problems." },
];

export function ModelsSection({ bridge, settings }: ModelsSectionProps) {
  const catalog = useModelsCatalog(bridge, settings);

  const allModels = useMemo(
    () =>
      catalog.providers.flatMap((provider) =>
        provider.models.map((model) => ({ providerId: provider.id, model })),
      ),
    [catalog.providers],
  );

  if (catalog.status === "loading" && catalog.providers.length === 0) {
    return <SectionSkeleton rows={8} />;
  }

  if (catalog.status === "error" && catalog.error) {
    return (
      <SectionError
        title="Models unavailable"
        stage={catalog.error.stage}
        message={catalog.error.message}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Filter providers and models…"
        value={catalog.filter}
        onChange={(event) => catalog.setFilter(event.target.value)}
      />

      <SettingsGroup title="Roles">
        {ROLES.map(({ role, label, description }) => (
          <SettingsRow
            key={role}
            rowKey={`model-role-${role}`}
            label={label}
            description={description}
            keyPath="modelRoles"
          >
            <Select<string>
              value={catalog.roles[role] ?? null}
              onValueChange={(value) => value && void catalog.setRole(role, value)}
              disabled={allModels.length === 0}
            >
              <SelectTrigger size="sm" className="w-56">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                {allModels.map(({ providerId, model }) => (
                  <SelectItem key={model.selector} value={model.selector}>
                    {providerId} — {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        ))}
      </SettingsGroup>

      {catalog.providers.map((provider) => (
        <SettingsGroup
          key={provider.id}
          title={provider.name}
          badge={
            <Switch
              checked={provider.enabled}
              onCheckedChange={(checked) => void catalog.setProviderEnabled(provider.id, checked)}
              aria-label={`Enable ${provider.name}`}
            />
          }
        >
          {provider.models.map((model) => {
            const caption = modelCaption(model.contextWindow, model.cost);
            return (
              <SettingsRow
                key={model.selector}
                rowKey={`model-${model.selector}`}
                label={model.name}
                keyPath="enabledModels"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {caption && (
                    <span
                      className="truncate font-mono text-[10px] text-muted-foreground"
                      title={caption}
                    >
                      {caption}
                    </span>
                  )}
                  <Checkbox
                    checked={model.enabled}
                    onCheckedChange={(checked) =>
                      void catalog.setModelEnabled(model.selector, checked === true)
                    }
                    aria-label={`Enable ${model.name}`}
                  />
                </div>
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      ))}

      {catalog.providers.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {catalog.filter
            ? `No providers or models match "${catalog.filter}".`
            : "No models discovered — configure at least one provider credential to populate this catalog."}
        </p>
      )}

      <SessionsNote />
    </div>
  );
}

/** `"200K ctx · $3.00/$15.00 per M"` — context window rounded to the
 * nearest thousand tokens, cost as input/output USD per million tokens.
 * Either half is omitted when its source field is absent; the whole
 * caption is `undefined` when both are. */
function modelCaption(
  contextWindow: number | undefined,
  cost: { input: number; output: number } | undefined,
): string | undefined {
  const parts: string[] = [];
  if (contextWindow !== undefined) {
    parts.push(contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K ctx` : `${contextWindow} ctx`);
  }
  if (cost) {
    parts.push(`$${cost.input.toFixed(2)}/$${cost.output.toFixed(2)} per M`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
