/**
 * Per-session model & thinking-level selection (T13, issue #14). Framework-
 * agnostic like `sessions-store.ts`/`transcript.ts` (no React import here):
 * wraps one live `RpcSession`'s model catalog and current selection,
 * driven by `get_state`/`get_available_models`/`set_model`/
 * `set_thinking_level` (docs/adr; wire shapes confirmed against the pinned
 * `rpc-types.ts`).
 *
 * "Live data" means: the initial snapshot comes from `get_state` (current
 * model/thinking level) and `get_available_models` (the catalog), fetched
 * once in parallel on construction. After that, `set_model`/
 * `set_thinking_level` responses are the session's own confirmation a
 * change applied, and are reflected immediately; the session's own
 * `model_changed`/`thinking_level_changed` events (emitted by omp itself —
 * e.g. an advisor-driven fallback, not only in response to this module's
 * commands) keep the snapshot in sync with changes this module didn't
 * initiate. `model_changed` carries no payload, so it triggers a
 * `get_state` refetch; `thinking_level_changed` carries the new level
 * directly.
 */
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcEventFrame, RpcSession } from "./session";

type GetStateResponse = Extract<RpcResponse, { command: "get_state" }>;

/** The full `Model` object as returned by `get_state`/`get_available_models`/
 * `set_model`, re-exported under this name so consumers never need their
 * own dependency on the underlying `@oh-my-pi/pi-catalog` package — this
 * package only depends on `@oh-my-pi/pi-coding-agent`'s RPC types. */
export type SessionModel = NonNullable<GetStateResponse["data"]["model"]>;

/** `"inherit" | "off" | Effort` (the wire `ThinkingLevel` union from
 * `@oh-my-pi/pi-agent-core`), re-exported the same way as `SessionModel`. */
export type SessionThinkingLevel = NonNullable<GetStateResponse["data"]["thinkingLevel"]>;

/**
 * Every selectable thinking level, least to most intensive. Mirrors
 * `ThinkingLevel`'s member order in `@oh-my-pi/pi-agent-core`'s
 * `thinking.ts`, reproduced as a literal catalog here because this package
 * never imports agent-core directly.
 */
export const THINKING_LEVELS = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as readonly SessionThinkingLevel[];

export interface ModelSelectionSnapshot {
  model: SessionModel | undefined;
  thinkingLevel: SessionThinkingLevel | undefined;
  availableModels: readonly SessionModel[];
  /** True until the initial `get_state` + `get_available_models` round
   * trip resolves. */
  loading: boolean;
  /** Message from the most recently failed load or `set_*` call; cleared
   * on the next successful operation. */
  error: string | undefined;
}

/** Shared across every `ModelSelection` until its first `emit` replaces the
 * reference — never mutated, so sharing it is safe (mirrors
 * `transcript.ts`'s `EMPTY_SNAPSHOT`). */
export const EMPTY_MODEL_SELECTION_SNAPSHOT: ModelSelectionSnapshot = {
  model: undefined,
  thinkingLevel: undefined,
  availableModels: [],
  loading: true,
  error: undefined,
};

export interface ModelSelection {
  getSnapshot(): ModelSelectionSnapshot;
  /** Register for snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Send `set_model` and reflect the applied `Model` once it responds. */
  setModel(provider: string, modelId: string): Promise<void>;
  /** Send `set_thinking_level` and reflect `level` once it responds — the
   * command's response carries no data, so the requested level itself is
   * the new truth. */
  setThinkingLevel(level: SessionThinkingLevel): Promise<void>;
  /** Stop listening to the underlying session's events. Call when the
   * owning session closes or the consumer unmounts. */
  dispose(): void;
}

/**
 * Creates a `ModelSelection` bound to one live `RpcSession`. Fetches
 * `get_state` + `get_available_models` immediately; call `dispose()` once
 * the session goes away.
 */
export function createModelSelection(session: RpcSession): ModelSelection {
  let snapshot = EMPTY_MODEL_SELECTION_SNAPSHOT;
  const listeners = new Set<() => void>();

  const emit = (next: Partial<ModelSelectionSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const refreshState = async () => {
    try {
      const response = await session.command({ type: "get_state" });
      emit({
        model: response.data.model,
        thinkingLevel: response.data.thinkingLevel,
        error: undefined,
      });
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  void (async () => {
    try {
      const [state, available] = await Promise.all([
        session.command({ type: "get_state" }),
        session.command({ type: "get_available_models" }),
      ]);
      emit({
        model: state.data.model,
        thinkingLevel: state.data.thinkingLevel,
        availableModels: available.data.models,
        loading: false,
        error: undefined,
      });
    } catch (error) {
      emit({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  const unsubscribeEvent = session.onEvent((frame: RpcEventFrame) => {
    if (frame.type === "model_changed") {
      void refreshState();
    } else if (frame.type === "thinking_level_changed") {
      emit({ thinkingLevel: frame.thinkingLevel as SessionThinkingLevel | undefined });
    }
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setModel(provider, modelId) {
      try {
        const response = await session.command({ type: "set_model", provider, modelId });
        emit({ model: response.data, error: undefined });
      } catch (error) {
        emit({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    async setThinkingLevel(level) {
      try {
        await session.command({ type: "set_thinking_level", level });
        emit({ thinkingLevel: level, error: undefined });
      } catch (error) {
        emit({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    dispose() {
      unsubscribeEvent();
    },
  };
}
