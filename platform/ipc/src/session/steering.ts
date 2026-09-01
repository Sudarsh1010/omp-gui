/**
 * Steering & queue-mode controller (T5, issue #6): a framework-agnostic
 * wrapper over one session's `steer`/`follow_up`/`abort`/`abort_and_prompt`
 * commands and its three independent queue-mode toggles (protocol.md §2.2,
 * §2.6; `RpcSessionState.steeringMode`/`followUpMode`/`interruptMode`).
 * Built directly over `RpcSession` (via `SessionsStore.getSession(id)`),
 * exactly like `Transcript` — no React import here; `gui/src/session/
 * use-steering.ts` bridges it into a component.
 *
 * Deliberately kept outside `Transcript`: a landed steer/follow-up message
 * rides the wire as an ordinary, non-synthetic, user-attributed message
 * (the pinned package's `AgentSession#steer`/`#followUp` set
 * `attribution: "user"`, never `synthetic`), and `Transcript.
 * applyMessageStart` only ever renders a user/developer message when the
 * server marks it `synthetic` — i.e. when nothing already showed it
 * optimistically. `Composer` (this controller's only caller) surfaces
 * steering through this controller's own snapshot instead, the same way
 * `Transcript.sendPrompt` shows its own optimistic entry.
 *
 * There is no push event for a queue-mode change (protocol.md §4.2's
 * state-refresh nudges don't list one), so `queueModes` is hydrated by one
 * `get_state` round trip up front, kept current locally the moment each
 * `set_*_mode` call resolves (this controller is the only writer for its
 * session's queue modes), and refreshed from `get_state` again at the turn
 * boundaries where a queued message could have drained — so
 * `queuedMessageCount` visibly drops once a steer/follow-up actually lands.
 */
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcSession } from "./session";
import type { TranscriptImage } from "./transcript";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

/**
 * The two queue-drain strategies shared by the steering and follow-up
 * queues (protocol.md §2.6): `"one-at-a-time"` drains only the oldest
 * queued message at each drain boundary, leaving the rest queued;
 * `"all"` drains and batches the entire queue at once. Default for both
 * queues (`pi-agent-core/src/agent.ts:467-468`).
 */
export type QueueDrainMode = Command<"set_steering_mode">["mode"];

/**
 * When a queued steering message actually interrupts tool execution
 * (protocol.md §2.6, `pi-agent-core`'s `AgentLoopConfig.interruptMode`):
 * `"immediate"` (the default, `agent.ts:469`) checks after every tool
 * call; `"wait"` defers until the current turn's natural boundary.
 */
export type SteeringInterruptMode = Command<"set_interrupt_mode">["mode"];

export interface QueueModes {
  steeringMode: QueueDrainMode;
  followUpMode: QueueDrainMode;
  interruptMode: SteeringInterruptMode;
}

/** Which controller action currently has a command in flight. */
export interface SteeringPending {
  steer: boolean;
  followUp: boolean;
  abort: boolean;
  abortAndPrompt: boolean;
}

export interface SteeringSnapshot {
  /** False until the first `get_state` response resolves; `queueModes`
   * and `queuedMessageCount` are placeholder defaults until then. */
  ready: boolean;
  queueModes: QueueModes;
  /** Mirrors `RpcSessionState.queuedMessageCount` (combined steering +
   * follow-up queue depth). Refreshed after every action this controller
   * takes and at every observed turn boundary. */
  queuedMessageCount: number;
  pending: SteeringPending;
  /** The most recent action's failure message, or `null`. Cleared at the
   * start of the next action. */
  lastError: string | null;
}

export interface SteeringController {
  getSnapshot(): SteeringSnapshot;
  /** External-store-shaped subscription (compatible with React's
   * `useSyncExternalStore`). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Inject `text` into the currently-running turn's steering queue
   * (protocol.md §2.2 — delivery timing depends on `interruptMode`).
   */
  steer(text: string, images?: TranscriptImage[]): Promise<void>;
  /**
   * Queue `text` to run after the current turn completes naturally. When
   * `queueMode` differs from the session's current `followUpMode`, sets
   * it first so the caller's queue-mode selection governs how *this*
   * follow-up drains, keeping the picker's own state in sync.
   */
  followUp(text: string, queueMode: QueueDrainMode, images?: TranscriptImage[]): Promise<void>;
  /** Cancel the in-flight turn. */
  abort(): Promise<void>;
  /**
   * Abort the in-flight turn, then submit `text` as a new prompt, as one
   * server-side action (protocol.md §2.2) — avoids the race a client-side
   * abort-then-prompt would run against the old turn's teardown.
   */
  abortAndPrompt(text: string, images?: TranscriptImage[]): Promise<void>;
  setSteeringMode(mode: QueueDrainMode): Promise<void>;
  setFollowUpMode(mode: QueueDrainMode): Promise<void>;
  setInterruptMode(mode: SteeringInterruptMode): Promise<void>;
  /** Stops listening to `session`'s events. Does not touch the session
   * itself — transport ownership stays with `SessionsStore`. */
  dispose(): void;
}

/** `pi-agent-core`'s own defaults (`agent.ts:467-469`), used until the
 * first `get_state` response hydrates the real values. */
const DEFAULT_QUEUE_MODES: QueueModes = {
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
};

const INITIAL_SNAPSHOT: SteeringSnapshot = {
  ready: false,
  queueModes: DEFAULT_QUEUE_MODES,
  queuedMessageCount: 0,
  pending: { steer: false, followUp: false, abort: false, abortAndPrompt: false },
  lastError: null,
};

/** Builds a controller for `session`, immediately kicking off the initial
 * `get_state` hydration. */
export function createSteeringController(session: RpcSession): SteeringController {
  let snapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<() => void>();

  function publish(next: Partial<SteeringSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }

  /** Re-fetches `get_state` and folds its queue-related fields into the
   * snapshot. Failures are swallowed: a stale queue count/mode is minor
   * UI staleness, not an action failure worth surfacing as `lastError` —
   * the next triggering event or action retries anyway. */
  async function refreshState(): Promise<void> {
    try {
      const { data: state } = await session.command({ type: "get_state" });
      publish({
        ready: true,
        queueModes: {
          steeringMode: state.steeringMode,
          followUpMode: state.followUpMode,
          interruptMode: state.interruptMode,
        },
        queuedMessageCount: state.queuedMessageCount,
      });
    } catch {
      // Leave the last-known snapshot in place.
    }
  }

  void refreshState();

  // `turn_start`/`turn_end`/`agent_end` are the documented boundaries
  // (protocol.md §4.1) where a queued steering/follow-up message can have
  // just drained, so they're where `queuedMessageCount` actually moves
  // without this controller itself having initiated the change.
  const unsubscribeEvents = session.onEvent((frame) => {
    if (frame.type === "turn_start" || frame.type === "turn_end" || frame.type === "agent_end") {
      void refreshState();
    }
  });

  async function runAction(key: keyof SteeringPending, send: () => Promise<unknown>): Promise<void> {
    publish({ pending: { ...snapshot.pending, [key]: true }, lastError: null });
    try {
      await send();
    } catch (error) {
      publish({ lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      publish({ pending: { ...snapshot.pending, [key]: false } });
    }
    await refreshState();
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    steer(text, images) {
      return runAction("steer", () => session.command({ type: "steer", message: text, images }));
    },

    followUp(text, queueMode, images) {
      return runAction("followUp", async () => {
        if (queueMode !== snapshot.queueModes.followUpMode) {
          await session.command({ type: "set_follow_up_mode", mode: queueMode });
          publish({ queueModes: { ...snapshot.queueModes, followUpMode: queueMode } });
        }
        await session.command({ type: "follow_up", message: text, images });
      });
    },

    abort() {
      return runAction("abort", () => session.command({ type: "abort" }));
    },

    abortAndPrompt(text, images) {
      return runAction("abortAndPrompt", () =>
        session.command({ type: "abort_and_prompt", message: text, images }),
      );
    },

    async setSteeringMode(mode) {
      await session.command({ type: "set_steering_mode", mode });
      publish({ queueModes: { ...snapshot.queueModes, steeringMode: mode } });
    },

    async setFollowUpMode(mode) {
      await session.command({ type: "set_follow_up_mode", mode });
      publish({ queueModes: { ...snapshot.queueModes, followUpMode: mode } });
    },

    async setInterruptMode(mode) {
      await session.command({ type: "set_interrupt_mode", mode });
      publish({ queueModes: { ...snapshot.queueModes, interruptMode: mode } });
    },

    dispose(): void {
      unsubscribeEvents();
      listeners.clear();
    },
  };
}
