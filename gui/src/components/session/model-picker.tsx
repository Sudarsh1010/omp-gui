/**
 * Model & thinking-level pickers for a session's header (T13, issue #14).
 * Two independent `Select`s wired to `useModelSelection`: the model picker
 * lists `get_available_models`'s catalog (`provider — name`, keyed by
 * `provider:id` since `set_model` needs both fields back apart); the
 * thinking-level picker lists the full `THINKING_LEVELS` catalog. Both are
 * disabled while the initial `get_state`/`get_available_models` round trip
 * is still loading.
 */
import type { SessionsStore, SessionThinkingLevel } from "@omp-gui/ipc";
import { THINKING_LEVELS } from "@omp-gui/ipc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@omp-gui/ui/components/select";
import { useModelSelection } from "@gui/session/use-model-selection";

export interface ModelPickerProps {
  store: SessionsStore;
  sessionId: string;
}

const THINKING_LEVEL_LABELS: Record<SessionThinkingLevel, string> = {
  inherit: "Inherit",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function ModelPicker({ store, sessionId }: ModelPickerProps) {
  const { model, thinkingLevel, availableModels, loading, setModel, setThinkingLevel } =
    useModelSelection(store, sessionId);

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Select<string>
        value={model ? `${model.provider}:${model.id}` : null}
        onValueChange={(value) => {
          const selected = availableModels.find(
            (option) => `${option.provider}:${option.id}` === value,
          );
          if (selected) void setModel(selected.provider, selected.id);
        }}
        disabled={loading || availableModels.length === 0}
      >
        <SelectTrigger size="sm" className="w-48">
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent>
          {availableModels.map((option) => (
            <SelectItem
              key={`${option.provider}:${option.id}`}
              value={`${option.provider}:${option.id}`}
            >
              {option.provider} — {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select<SessionThinkingLevel>
        value={thinkingLevel ?? null}
        onValueChange={(value) => value && void setThinkingLevel(value)}
        disabled={loading}
      >
        <SelectTrigger size="sm" className="w-32">
          <SelectValue placeholder="Thinking" />
        </SelectTrigger>
        <SelectContent>
          {THINKING_LEVELS.map((level) => (
            <SelectItem key={level} value={level}>
              {THINKING_LEVEL_LABELS[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
