/**
 * Subagent tracking (T12, issue #13; ADR-0002 rationale — going omp-native
 * means delegated `task`-tool work rides the same protocol as everything
 * else, so it can be surfaced instead of staying a black box). Enables
 * `subagent_lifecycle`/`subagent_progress`/`subagent_event` streaming on a
 * session (protocol notes §4.7) and normalizes the frames into a live
 * roster plus a per-subagent message stream for drill-in.
 *
 * Wire shapes are derived structurally from `RpcSessionEventFrame` (the same
 * union `session.ts`/`transcript.ts` import from the pinned omp package,
 * ADR-0004), exactly like `transcript.ts` does — this module adds no new
 * import specifier for the underlying agent-core types. Subscription level
 * is always `"events"`: the drill-in stream (this ticket's whole point)
 * needs the granular `subagent_event` frames, which `"progress"` alone
 * does not emit.
 *
 * Two layers, mirroring `approvals.ts`'s `ApprovalInbox`/`ApprovalRegistry`
 * split (same architectural role: a per-session normalizer plus a registry
 * that makes it correct for every session, not just the mounted one):
 *
 *  - `SubagentsStore` normalizes one `RpcSession`'s subagent frames.
 *    Framework-agnostic and single-session, same shape as `Transcript`: an
 *    immutable-snapshot `subscribe`/`getSnapshot` pair, plus a per-subagent
 *    stream accessor.
 *  - `SubagentTracker` eagerly builds one `SubagentsStore` per session as
 *    soon as `SessionsStore.getSession(id)` has a live `RpcSession` —
 *    mirroring `ApprovalRegistry` exactly, for the same reason: `AppShell`
 *    mounts the panel for `activeId` only, but a *backgrounded* session's
 *    subagent can spawn and finish without ever being the active session,
 *    and `get_subagents` only ever returns *currently running* subagents
 *    (protocol.md §4.7) — a tracker that only attached once a user opened
 *    that session's panel could miss it entirely. `getSubagentTracker`
 *    caches one tracker per `SessionsStore` (a `WeakMap`) so any mount
 *    point reaches the same live instance without a new prop threaded
 *    through `AppShell`/`SessionView`.
 *
 * Deliberate divergence from the server's own `RpcSubagentRegistry`:
 * terminal subagents are **kept** (status flips to `"completed"`/
 * `"failed"`/`"aborted"`) rather than pruned — the server only needs "list
 * current work", but a drill-in panel wants finished subagents to stay
 * reviewable for the rest of the session's life. Hydration
 * (`get_subagents`, for a subagent already running when a store attaches)
 * only *seeds* ids not already tracked, so hydrate-vs-live-frame ordering
 * is a non-issue: whichever arrives first wins, the other is a no-op.
 */
import type {
  RpcSessionEventFrame,
  RpcSubagentFrame,
  RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcEventFrame, RpcSession } from "./session";
import type { SessionsStore } from "./sessions-store";

type SessionEvent<T extends RpcSessionEventFrame["type"]> = Extract<RpcSessionEventFrame, { type: T }>;
type LifecyclePayload = SessionEvent<"subagent_lifecycle">["payload"];
type ProgressPayload = SessionEvent<"subagent_progress">["payload"];

/** Every `AgentSessionEvent` variant — everything a subagent's *own* nested
 * turn can emit, wrapped one level down inside a `subagent_event` frame's
 * `payload.event`. Derived by subtraction rather than imported by name,
 * matching `transcript.ts`'s own "structural, not nominal" convention for
 * nested wire types. */
type SubagentAgentEvent = Exclude<RpcSessionEventFrame, RpcSubagentFrame>;
type SubagentEvent<T extends SubagentAgentEvent["type"]> = Extract<SubagentAgentEvent, { type: T }>;
type SubagentMessageT = SubagentEvent<"message_start">["message"];
type SubagentAssistantMessageEventT = SubagentEvent<"message_update">["assistantMessageEvent"];
type SubagentUserLikeMessage = Extract<SubagentMessageT, { role: "user" | "developer" }>;

/** Progress tracking for one subagent's run — token/cost counters, current
 * tool, last intent, ... (full shape: pinned `AgentProgress`). */
export type SubagentProgress = ProgressPayload["progress"];

export type SubagentStatus = SubagentProgress["status"];

/** One spawned subagent's roster row: identity, lifecycle status, and its
 * latest progress snapshot. Field-for-field compatible with the wire
 * `RpcSubagentSnapshot` (so `get_subagents` hydration needs no mapping) but
 * declared fresh, matching this codebase's existing convention of owning
 * its processed types rather than re-exporting pinned-package shapes
 * (`SessionSummary` does the same relative to the raw session state). */
export interface SubagentSummary {
  id: string;
  index: number;
  agent: string;
  agentSource: LifecyclePayload["agentSource"];
  description?: string;
  status: SubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  lastUpdate: number;
  progress?: SubagentProgress;
  parentToolCallId?: string;
}

export type SubagentToolStatus = "running" | "done" | "error" | "aborted";

/** One message/prompt entry in a subagent's own stream — its initial task
 * prompt (`role: "user"`), any injected nudge (`role: "developer"`), or a
 * streamed assistant response. */
export interface SubagentMessageEntry {
  kind: "message";
  id: string;
  role: SubagentUserLikeMessage["role"] | "assistant";
  text: string;
  streaming: boolean;
  timestamp: number;
}

/** One streamed thinking block from a subagent's assistant turn. */
export interface SubagentThinkingEntry {
  kind: "thinking";
  id: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

/** One tool call the subagent made, keyed by its own `toolCallId`. */
export interface SubagentToolEntry {
  kind: "tool";
  id: string;
  toolName: string;
  intent?: string;
  status: SubagentToolStatus;
  timestamp: number;
}

/** A subagent-side `notice` event, or a synthesized one for an assistant
 * turn that ended in error. */
export interface SubagentNoticeEntry {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  timestamp: number;
}

export type SubagentStreamEntry =
  | SubagentMessageEntry
  | SubagentThinkingEntry
  | SubagentToolEntry
  | SubagentNoticeEntry;

interface SubagentRecord {
  summary: SubagentSummary;
  stream: SubagentStreamEntry[];
  /** Id prefix shared by the sub-entries (text/thinking blocks) of this
   * subagent's assistant message currently streaming, or `null` between
   * messages — mirrors `Transcript`'s own `assistantGroup` bookkeeping. */
  assistantGroup: string | null;
  idCounter: number;
}

function nextEntryId(record: SubagentRecord, prefix: string): string {
  record.idCounter += 1;
  return `${prefix}-${record.idCounter}`;
}

/** Joins the text content of a user/developer message, ignoring images. */
function contentText(message: SubagentUserLikeMessage): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/** Replaces the stream entry sharing `id` (preserving position) or appends.
 * Lighter analog of `Transcript`'s own upsert-by-id. */
function upsertEntry(
  record: SubagentRecord,
  id: string,
  make: (prev: SubagentStreamEntry | undefined) => SubagentStreamEntry,
): void {
  const index = record.stream.findIndex((entry) => entry.id === id);
  const next = make(index >= 0 ? record.stream[index] : undefined);
  if (index >= 0) {
    const copy = record.stream.slice();
    copy[index] = next;
    record.stream = copy;
  } else {
    record.stream = [...record.stream, next];
  }
}

/** Normalizes one `AgentSessionEvent` from a subagent's own nested turn into
 * `record.stream`. Returns whether the stream actually changed (so the
 * caller only republishes when there's something new to show) — a
 * deliberately smaller vocabulary than `Transcript`'s (message/thinking/tool
 * only, no diff extraction, no image content): a spectator view of
 * delegated work, not a full second transcript renderer. */
function applyAgentEvent(record: SubagentRecord, event: SubagentAgentEvent): boolean {
  switch (event.type) {
    case "message_start": {
      const message = event.message;
      if (message.role === "assistant") {
        record.assistantGroup = nextEntryId(record, "msg");
        return false; // no visible entry yet; sub-blocks appear via message_update
      }
      if (message.role !== "user" && message.role !== "developer") return false;
      record.stream = [
        ...record.stream,
        {
          kind: "message",
          id: nextEntryId(record, "msg"),
          role: message.role,
          text: contentText(message),
          streaming: false,
          timestamp: message.timestamp,
        },
      ];
      return true;
    }
    case "message_update":
      return applySubagentMessageUpdate(record, event.message, event.assistantMessageEvent);
    case "message_end": {
      if (event.message.role !== "assistant") return false;
      const group = record.assistantGroup;
      record.assistantGroup = null;
      if (group === null) return false;
      // Defensive reconciliation against the authoritative final message,
      // in case an individual `_end` sub-event never arrived (e.g. abort
      // mid-stream) — same guard `Transcript.applyMessageEnd` applies.
      let changed = false;
      const message = event.message;
      for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
        const block = message.content[contentIndex];
        if (block.type === "text") {
          upsertEntry(record, `${group}:text:${contentIndex}`, (prev) => ({
            kind: "message",
            id: `${group}:text:${contentIndex}`,
            role: "assistant",
            text: block.text,
            streaming: false,
            timestamp: prev?.timestamp ?? message.timestamp,
          }));
          changed = true;
        } else if (block.type === "thinking") {
          upsertEntry(record, `${group}:thinking:${contentIndex}`, (prev) => ({
            kind: "thinking",
            id: `${group}:thinking:${contentIndex}`,
            text: block.thinking,
            streaming: false,
            timestamp: prev?.timestamp ?? message.timestamp,
          }));
          changed = true;
        }
      }
      return changed;
    }
    case "tool_execution_start":
      upsertEntry(record, event.toolCallId, () => ({
        kind: "tool",
        id: event.toolCallId,
        toolName: event.toolName,
        intent: event.intent,
        status: "running",
        timestamp: Date.now(),
      }));
      return true;
    case "tool_execution_end":
      upsertEntry(record, event.toolCallId, (prev) => ({
        kind: "tool",
        id: event.toolCallId,
        toolName: event.toolName,
        intent: prev?.kind === "tool" ? prev.intent : undefined,
        status: event.isError ? "error" : "done",
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "notice":
      record.stream = [
        ...record.stream,
        {
          kind: "notice",
          id: nextEntryId(record, "notice"),
          level: event.level,
          message: event.message,
          timestamp: Date.now(),
        },
      ];
      return true;
    default:
      // tool_execution_update (only start/end matter for this lighter
      // stream) and every other AgentEvent (agent_start/turn_*/
      // auto_compaction/auto_retry/model_changed/goal_updated/...): no
      // visible effect on a subagent's message stream.
      return false;
  }
}

function applySubagentMessageUpdate(
  record: SubagentRecord,
  message: SubagentMessageT,
  event: SubagentAssistantMessageEventT,
): boolean {
  if (message.role !== "assistant") return false;
  const group = record.assistantGroup ?? (record.assistantGroup = nextEntryId(record, "msg"));
  switch (event.type) {
    case "text_start":
      upsertEntry(record, `${group}:text:${event.contentIndex}`, (prev) => ({
        kind: "message",
        id: `${group}:text:${event.contentIndex}`,
        role: "assistant",
        text: prev?.kind === "message" ? prev.text : "",
        streaming: true,
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "text_delta":
      upsertEntry(record, `${group}:text:${event.contentIndex}`, (prev) => ({
        kind: "message",
        id: `${group}:text:${event.contentIndex}`,
        role: "assistant",
        text: (prev?.kind === "message" ? prev.text : "") + event.delta,
        streaming: true,
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "text_end":
      upsertEntry(record, `${group}:text:${event.contentIndex}`, (prev) => ({
        kind: "message",
        id: `${group}:text:${event.contentIndex}`,
        role: "assistant",
        text: event.content,
        streaming: false,
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "thinking_start":
      upsertEntry(record, `${group}:thinking:${event.contentIndex}`, (prev) => ({
        kind: "thinking",
        id: `${group}:thinking:${event.contentIndex}`,
        text: prev?.kind === "thinking" ? prev.text : "",
        streaming: true,
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "thinking_delta":
      upsertEntry(record, `${group}:thinking:${event.contentIndex}`, (prev) => ({
        kind: "thinking",
        id: `${group}:thinking:${event.contentIndex}`,
        text: (prev?.kind === "thinking" ? prev.text : "") + event.delta,
        streaming: true,
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "thinking_end":
      upsertEntry(record, `${group}:thinking:${event.contentIndex}`, (prev) => ({
        kind: "thinking",
        id: `${group}:thinking:${event.contentIndex}`,
        text: event.content,
        streaming: false,
        timestamp: prev?.timestamp ?? Date.now(),
      }));
      return true;
    case "error":
      record.stream = [
        ...record.stream,
        {
          kind: "notice",
          id: nextEntryId(record, "notice"),
          level: "error",
          message: event.error.errorMessage ?? `subagent turn ended: ${event.reason}`,
          timestamp: Date.now(),
        },
      ];
      return true;
    default:
      // start/done/toolcall_*/image_end: tool calls are tracked via the
      // coarser tool_execution_* events instead; assistant-generated images
      // are out of scope for this lighter stream.
      return false;
  }
}

/** Flips every still-"live" stream entry to a terminal state (streaming
 * cursor off, running tool call marked aborted) so a finished/exited
 * subagent never leaves a spinner or streaming cursor showing forever.
 * Returns whether anything actually changed. */
function finalizeStream(record: SubagentRecord): boolean {
  let changed = false;
  const next = record.stream.map((entry) => {
    if ((entry.kind === "message" || entry.kind === "thinking") && entry.streaming) {
      changed = true;
      return { ...entry, streaming: false };
    }
    if (entry.kind === "tool" && entry.status === "running") {
      changed = true;
      return { ...entry, status: "aborted" as const };
    }
    return entry;
  });
  if (changed) record.stream = next;
  return changed;
}

/**
 * Normalizes one `RpcSession`'s subagent frames into a live roster plus
 * per-subagent message streams. Enables `"events"` subscription
 * immediately (constructor-synchronous `session.onEvent` registration, then
 * the wire command), then hydrates any subagents already running before
 * this store attached via `get_subagents`. Framework-agnostic, same shape
 * as `Transcript`/`ApprovalInbox`: an immutable-snapshot `subscribe`/
 * `getSnapshot` pair over one session.
 */
export class SubagentsStore {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly streamListeners = new Map<string, Set<() => void>>();
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeExit: () => void;
  private currentList: SubagentSummary[] = [];

  /**
   * Resolves once the initial `set_subagent_subscription` enable and
   * `get_subagents` hydration have both settled. Never rejects — a failure
   * (e.g. an omp build predating subagent support) just leaves this store
   * empty instead of throwing. Live push frames never depend on this
   * resolving: `onEvent` is registered synchronously before either command
   * is sent, so nothing emitted after the enable takes effect is missed
   * regardless of when this promise settles.
   */
  readonly ready: Promise<void>;

  constructor(
    session: RpcSession,
    level: RpcSubagentSubscriptionLevel = "events",
  ) {
    this.unsubscribeEvent = session.onEvent((frame) => this.onFrame(frame));
    this.unsubscribeExit = session.onExit(() => this.handleExit());
    this.ready = session
      .command({ type: "set_subagent_subscription", level })
      .then(() => session.command({ type: "get_subagents" }))
      .then((response) => {
        for (const snapshot of response.data.subagents) {
          if (!this.records.has(snapshot.id)) this.upsertSummary(snapshot.id, snapshot);
        }
      })
      .catch(() => {
        // Best-effort enhancement: an omp build without subagent support,
        // or the session closing mid-handshake, just leaves this store
        // empty.
      });
  }

  /** Every subagent spawned this store's lifetime, in spawn order (never
   * re-sorted by activity, so rows don't jump around as progress ticks
   * arrive). Stable reference between notifications. */
  list(): SubagentSummary[] {
    return this.currentList;
  }

  /** One subagent's message stream, or `undefined` if `subagentId` has
   * never been seen. Stable reference between notifications for that id. */
  getStream(subagentId: string): SubagentStreamEntry[] | undefined {
    return this.records.get(subagentId)?.stream;
  }

  /** Register for roster notifications: any subagent's summary changed, or
   * a new one was added. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register for notifications scoped to one subagent's stream. Safe to
   * call before that subagent has appeared — it'll fire once it does.
   * Returns an unsubscribe function. */
  subscribeStream(subagentId: string, listener: () => void): () => void {
    const existing = this.streamListeners.get(subagentId);
    const set = existing ?? new Set<() => void>();
    if (!existing) this.streamListeners.set(subagentId, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Detach from the session's event stream. Does not touch the session or
   * its subprocess. */
  dispose(): void {
    this.unsubscribeEvent();
    this.unsubscribeExit();
    this.listeners.clear();
    this.streamListeners.clear();
  }

  private publish(): void {
    this.currentList = this.order.map((id) => this.records.get(id)!.summary);
    for (const listener of this.listeners) listener();
  }

  private publishStream(id: string): void {
    for (const listener of this.streamListeners.get(id) ?? []) listener();
  }

  private upsertSummary(id: string, summary: SubagentSummary): SubagentRecord {
    const existing = this.records.get(id);
    if (!existing) {
      const record: SubagentRecord = { summary, stream: [], assistantGroup: null, idCounter: 0 };
      this.records.set(id, record);
      this.order.push(id);
      this.publish();
      this.publishStream(id);
      return record;
    }
    existing.summary = summary;
    this.publish();
    return existing;
  }

  private applyLifecycle(payload: LifecyclePayload): void {
    const existing = this.records.get(payload.id)?.summary;
    const record = this.upsertSummary(payload.id, {
      id: payload.id,
      index: payload.index,
      agent: payload.agent,
      agentSource: payload.agentSource,
      description: payload.description ?? existing?.description,
      status: payload.status === "started" ? "running" : payload.status,
      task: existing?.task,
      assignment: existing?.assignment,
      sessionFile: payload.sessionFile ?? existing?.sessionFile,
      parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
      lastUpdate: Date.now(),
      progress: existing?.progress,
    });
    if (payload.status !== "started" && finalizeStream(record)) this.publishStream(payload.id);
  }

  private applyProgress(payload: ProgressPayload): void {
    const id = payload.progress.id;
    const existing = this.records.get(id)?.summary;
    this.upsertSummary(id, {
      id,
      index: payload.index,
      agent: payload.agent,
      agentSource: payload.agentSource,
      description: payload.progress.description ?? existing?.description,
      status: payload.progress.status,
      task: payload.task,
      assignment: payload.assignment ?? existing?.assignment,
      sessionFile: payload.sessionFile ?? existing?.sessionFile,
      parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
      lastUpdate: Date.now(),
      progress: payload.progress,
    });
  }

  private onFrame(frame: RpcEventFrame): void {
    const event = frame as RpcSessionEventFrame;
    switch (event.type) {
      case "subagent_lifecycle":
        this.applyLifecycle(event.payload);
        return;
      case "subagent_progress":
        this.applyProgress(event.payload);
        return;
      case "subagent_event": {
        const record = this.records.get(event.payload.id);
        if (!record) return; // arrived before any lifecycle "started" seeded this id — see module doc
        if (applyAgentEvent(record, event.payload.event)) this.publishStream(event.payload.id);
        return;
      }
      default:
        // Every other session event/side-channel frame belongs to
        // Transcript/the approval inbox/etc.; safely ignored here.
        return;
    }
  }

  private handleExit(): void {
    let listChanged = false;
    for (const id of this.order) {
      const record = this.records.get(id)!;
      if (record.summary.status === "running" || record.summary.status === "pending") {
        record.summary = { ...record.summary, status: "aborted", lastUpdate: Date.now() };
        listChanged = true;
      }
      if (finalizeStream(record)) this.publishStream(id);
    }
    if (listChanged) this.publish();
  }
}

/**
 * Tracks one `SubagentsStore` per session in a `SessionsStore`, created the
 * moment `getSession(id)` first has a live `RpcSession` and disposed the
 * moment the session drops out of `list()` — independent of which
 * session's `SessionView`/panel (if any) happens to be mounted, see the
 * top-of-file comment.
 */
export class SubagentTracker {
  private readonly tracked = new Map<string, SubagentsStore>();
  private readonly unsubscribeStore: () => void;

  constructor(private readonly sessionsStore: SessionsStore) {
    this.unsubscribeStore = sessionsStore.subscribe(() => this.reconcile());
    this.reconcile();
  }

  /** The live subagents store for a session, or `undefined` before its
   * `RpcSession` exists (connecting, start failure) or once the session is
   * closed — mirrors `SessionsStore.getSession`'s own lifecycle. */
  getSubagents(sessionId: string): SubagentsStore | undefined {
    return this.tracked.get(sessionId);
  }

  /** Stop tracking every session. Does not touch the store or its sessions. */
  dispose(): void {
    this.unsubscribeStore();
    for (const store of this.tracked.values()) store.dispose();
    this.tracked.clear();
  }

  private reconcile(): void {
    const live = new Set(this.sessionsStore.list().map((session) => session.id));

    for (const [id, store] of this.tracked) {
      if (live.has(id)) continue;
      store.dispose();
      this.tracked.delete(id);
    }

    for (const id of live) {
      if (this.tracked.has(id)) continue;
      const session = this.sessionsStore.getSession(id);
      if (!session) continue;
      this.tracked.set(id, new SubagentsStore(session));
    }
  }
}

const trackers = new WeakMap<SessionsStore, SubagentTracker>();

/**
 * The per-`SessionsStore` singleton `SubagentTracker`, created on first use
 * and reused for the store's lifetime. The app constructs exactly one
 * `SessionsStore`, so in practice this is an app-wide singleton — without
 * threading a new prop through `AppShell`/`SessionView` (matches
 * `approvals.ts`'s `getApprovalRegistry`).
 */
export function getSubagentTracker(store: SessionsStore): SubagentTracker {
  const existing = trackers.get(store);
  if (existing) return existing;
  const tracker = new SubagentTracker(store);
  trackers.set(store, tracker);
  return tracker;
}
