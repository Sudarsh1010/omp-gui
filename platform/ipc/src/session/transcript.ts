/**
 * Transcript/turn state machine (ADR-0010 "new modules: TS UI (transcript,
 * composer...) — the session core"). Consumes an `RpcSession`'s event stream
 * (`session.onEvent`) and normalizes it into an ordered, UI-consumable list of
 * entries plus turn/running state. Framework-agnostic on purpose (no React
 * imports): both the React UI and the seam test in `transcript.test.ts`
 * consume the same `Transcript` class, driven by `subscribe`/`getSnapshot`
 * (an external-store shape compatible with React's `useSyncExternalStore`).
 *
 * Wire event/command shapes are imported from the pinned omp package
 * (ADR-0004) exactly like `session.ts` does; nested types (`AgentMessage`,
 * `AssistantMessageEvent`, `ImageContent`, ...) are derived structurally from
 * `RpcSessionEventFrame`/`RpcCommand` via TS utility types rather than
 * imported by name, so this module never adds an import specifier for
 * `@oh-my-pi/pi-agent-core`/`@oh-my-pi/pi-ai` beyond what `platform/ipc`
 * already depends on.
 */
import type {
  RpcCommand,
  RpcSessionEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcEventFrame, RpcSession } from "./session";

type SessionEvent<T extends RpcSessionEventFrame["type"]> = Extract<
  RpcSessionEventFrame,
  { type: T }
>;
type AgentMessageT = SessionEvent<"message_start">["message"];
type AssistantMessageEventT = SessionEvent<"message_update">["assistantMessageEvent"];
type UserLikeMessage = Extract<AgentMessageT, { role: "user" | "developer" }>;
type PromptCommand = Extract<RpcCommand, { type: "prompt" }>;
type ImageContentT = NonNullable<PromptCommand["images"]>[number];
type NoticeLevel = SessionEvent<"notice">["level"];

export type { ImageContentT as TranscriptImage, NoticeLevel };

/** A user (or system-synthesized) message entry. */
export interface UserMessageEntry {
  kind: "user";
  id: string;
  text: string;
  images: ImageContentT[];
  timestamp: number;
  /** True for server-injected messages (e.g. post-compaction auto-continue)
   * that never went through `sendPrompt`/`steer`. */
  synthetic?: boolean;
}

/** One streamed text content block from an assistant message. */
export interface AssistantMessageEntry {
  kind: "assistant";
  id: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

/** One streamed thinking content block from an assistant message. */
export interface ThinkingEntry {
  kind: "thinking";
  id: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

export type ToolExecutionStatus = "running" | "done" | "error" | "aborted";

/**
 * One reconstructed diff line. The wire diff format (`generateDiffString` in
 * the pinned omp source) numbers each row `+42|content` / `-42|content` /
 * ` 42|content` inside `@@ -a,b +c,d @@` hunks; parsing that into kind/line
 * pairs here means the view layer colors lines without re-parsing text.
 */
export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "other";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based source line number. Absent for hunk headers and unrecognized rows. */
  lineNumber?: number;
  content: string;
}

/** One edited file's reconstructed diff. A multi-file edit turn produces one
 * of these per file (from `EditToolDetails.perFileResults`); a single-file
 * edit produces exactly one (from `EditToolDetails.diff`/`.path`). */
export interface FileDiff {
  /** Path reported by the edit tool, when available. */
  path?: string;
  /** Raw unified diff text, as the wire payload carried it. */
  raw: string;
  lines: DiffLine[];
}

/** One tool call end-to-end, keyed by the protocol's own `toolCallId`. */
export interface ToolExecutionEntry {
  kind: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  intent?: string;
  status: ToolExecutionStatus;
  partialResult: unknown;
  result: unknown;
  isError?: boolean;
  /**
   * Reconstructed from `result.details.diff` (single-file edits, alongside
   * `.path`) or `result.details.perFileResults[i].diff` (multi-file edits,
   * one entry per file): the wire protocol has no dedicated diff event,
   * edits ride inside the tool result payload (protocol notes §4.1). Only
   * the edit tool's details carry a `diff` field, so this stays `undefined`
   * for every other tool (bash, read, write, ...) — never a fabricated
   * diff. Populated once a (partial) result carries one, so the core — not
   * the view layer — owns this protocol convention.
   */
  diffs?: FileDiff[];
  timestamp: number;
}

/** Side-channel notice: protocol `notice` events, and transport-level faults
 * (malformed frames, reassembly errors, failed commands, process exit) that
 * would otherwise be silently swallowed. */
export interface NoticeEntry {
  kind: "notice";
  id: string;
  level: NoticeLevel;
  message: string;
  source?: string;
  timestamp: number;
}

export type TranscriptEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ThinkingEntry
  | ToolExecutionEntry
  | NoticeEntry;

export interface TranscriptSnapshot {
  /** Ordered by arrival; this order is the display order. */
  entries: TranscriptEntry[];
  /** True from `agent_start` until the run's terminal `agent_end` (or abort/exit). */
  running: boolean;
  /** True while an `abort` command is in flight. */
  aborting: boolean;
}

const EMPTY_SNAPSHOT: TranscriptSnapshot = { entries: [], running: false, aborting: false };

/**
 * Normalizes one `RpcSession`'s event stream into a live transcript. Owns no
 * transport/negotiation concerns (that stays in `RpcSession`); only
 * interprets already-decoded frames.
 */
export class Transcript {
  private entries: TranscriptEntry[] = [];
  private running = false;
  private aborting = false;
  /** Id prefix shared by the sub-entries (text/thinking blocks) of the
   * assistant message currently streaming, or `null` between messages. */
  private assistantGroup: string | null = null;
  private idCounter = 0;
  private currentSnapshot: TranscriptSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<(snapshot: TranscriptSnapshot) => void>();
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(private readonly session: RpcSession) {
    this.unsubscribeEvent = session.onEvent((frame) => this.onFrame(frame));
    this.unsubscribeExit = session.onExit(() => this.onExit());
  }

  /** Stable reference; call again after every `subscribe` notification. */
  getSnapshot = (): TranscriptSnapshot => this.currentSnapshot;

  /** Register for snapshot-changed notifications. Returns an unsubscribe function. */
  subscribe = (listener: (snapshot: TranscriptSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Detach from the session's event stream. Does not touch the session/process. */
  dispose(): void {
    this.unsubscribeEvent();
    this.unsubscribeExit();
    this.listeners.clear();
  }

  /**
   * Submit a user turn. Appends an optimistic `user` entry immediately (this
   * session is the single writer for its own session file, ADR-0005, so
   * nothing else produces a competing entry for it), then issues the wire
   * `prompt` command. A command failure surfaces as a `notice` entry instead
   * of throwing, so a rejected prompt is visible in the transcript rather
   * than silently lost.
   */
  async sendPrompt(text: string, images: ImageContentT[] = []): Promise<void> {
    this.entries = [
      ...this.entries,
      { kind: "user", id: this.nextId("user"), text, images, timestamp: Date.now() },
    ];
    this.publish();
    try {
      await this.session.command({
        type: "prompt",
        message: text,
        images: images.length > 0 ? images : undefined,
      });
    } catch (error) {
      this.appendNotice("error", error instanceof Error ? error.message : String(error), "prompt");
      this.publish();
    }
  }

  /**
   * Abort the in-flight turn. No-op when nothing is running or an abort is
   * already in flight. The protocol has no dedicated "aborted" event — the
   * resulting `agent_end`/`turn_end` events carry the abort, which is where
   * `running` actually flips back to false (see `handleEvent`).
   */
  async abort(): Promise<void> {
    if (!this.running || this.aborting) return;
    this.aborting = true;
    this.publish();
    try {
      await this.session.command({ type: "abort" });
    } catch (error) {
      this.aborting = false;
      this.appendNotice("error", error instanceof Error ? error.message : String(error), "abort");
      this.publish();
    }
  }

  private onFrame(frame: RpcEventFrame): void {
    // `malformed_frame`/`protocol_error` are session.ts's own synthetic,
    // transport-level frames (not part of the rpc-ui wire protocol), so they
    // are handled here rather than in `handleEvent`'s protocol-shaped switch.
    if (frame.type === "malformed_frame") {
      this.appendNotice(
        "error",
        `malformed frame from omp: ${String(frame.line ?? "")}`,
        "transport",
      );
      this.publish();
      return;
    }
    if (frame.type === "protocol_error") {
      this.appendNotice("error", String(frame.error ?? "protocol error"), "transport");
      this.publish();
      return;
    }
    this.handleEvent(frame as RpcSessionEventFrame);
  }

  private onExit(): void {
    if (!this.running) return;
    this.finalizeInFlight();
    this.running = false;
    this.aborting = false;
    this.appendNotice("error", "the omp session process exited unexpectedly", "session");
    this.publish();
  }

  private handleEvent(event: RpcSessionEventFrame): void {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        this.aborting = false;
        break;
      case "agent_end":
        // False specifically means "an async delivery will resume the
        // session before its true final settle" — not yet idle.
        if (event.isTerminal === false) return;
        this.finalizeInFlight();
        this.running = false;
        this.aborting = false;
        break;
      case "message_start":
        if (!this.applyMessageStart(event.message)) return;
        break;
      case "message_update":
        if (!this.applyMessageUpdate(event.message, event.assistantMessageEvent)) return;
        break;
      case "message_end":
        if (!this.applyMessageEnd(event.message)) return;
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.applyToolEvent(event);
        break;
      case "notice":
        this.appendNotice(event.level, event.message, event.source);
        break;
      default:
        // Subagent frames, extension-UI/host-tool/URI frames, and
        // model/compaction/retry/goal/todo state-refresh nudges belong to
        // other tickets (subagent panel, approvals inbox, ...); safely
        // ignored here.
        return;
    }
    this.publish();
  }

  /** Returns true if a synthetic (server-injected) message was rendered. */
  private applyMessageStart(message: AgentMessageT): boolean {
    if (message.role === "assistant") {
      this.assistantGroup = this.nextId("msg");
      return false; // no visible entry yet; sub-blocks appear as they start
    }
    if (message.role === "user" || message.role === "developer") {
      if (!message.synthetic) return false; // already rendered optimistically by sendPrompt
      this.entries = [
        ...this.entries,
        {
          kind: "user",
          id: this.nextId("sys"),
          text: contentText(message),
          images: [],
          timestamp: message.timestamp,
          synthetic: true,
        },
      ];
      return true;
    }
    // toolResult messages are represented via tool_execution_* instead, to
    // avoid a second, duplicate entry for the same tool call.
    return false;
  }

  private applyMessageUpdate(message: AgentMessageT, event: AssistantMessageEventT): boolean {
    if (message.role !== "assistant") return false;
    const group = this.assistantGroup ?? (this.assistantGroup = this.nextId("msg"));
    switch (event.type) {
      case "text_start":
        this.upsert(`${group}:text:${event.contentIndex}`, (prev) => ({
          kind: "assistant",
          id: `${group}:text:${event.contentIndex}`,
          text: prev && prev.kind === "assistant" ? prev.text : "",
          streaming: true,
          timestamp: prev?.timestamp ?? Date.now(),
        }));
        return true;
      case "text_delta":
        this.upsert(`${group}:text:${event.contentIndex}`, (prev) => ({
          kind: "assistant",
          id: `${group}:text:${event.contentIndex}`,
          text: (prev && prev.kind === "assistant" ? prev.text : "") + event.delta,
          streaming: true,
          timestamp: prev?.timestamp ?? Date.now(),
        }));
        return true;
      case "text_end":
        this.upsert(`${group}:text:${event.contentIndex}`, (prev) => ({
          kind: "assistant",
          id: `${group}:text:${event.contentIndex}`,
          text: event.content,
          streaming: false,
          timestamp: prev?.timestamp ?? Date.now(),
        }));
        return true;
      case "thinking_start":
        this.upsert(`${group}:thinking:${event.contentIndex}`, (prev) => ({
          kind: "thinking",
          id: `${group}:thinking:${event.contentIndex}`,
          text: prev && prev.kind === "thinking" ? prev.text : "",
          streaming: true,
          timestamp: prev?.timestamp ?? Date.now(),
        }));
        return true;
      case "thinking_delta":
        this.upsert(`${group}:thinking:${event.contentIndex}`, (prev) => ({
          kind: "thinking",
          id: `${group}:thinking:${event.contentIndex}`,
          text: (prev && prev.kind === "thinking" ? prev.text : "") + event.delta,
          streaming: true,
          timestamp: prev?.timestamp ?? Date.now(),
        }));
        return true;
      case "thinking_end":
        this.upsert(`${group}:thinking:${event.contentIndex}`, (prev) => ({
          kind: "thinking",
          id: `${group}:thinking:${event.contentIndex}`,
          text: event.content,
          streaming: false,
          timestamp: prev?.timestamp ?? Date.now(),
        }));
        return true;
      case "error":
        this.appendNotice(
          "error",
          event.error.errorMessage ?? `assistant turn ended: ${event.reason}`,
          "assistant",
        );
        return true;
      case "start":
      case "done":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
      case "image_end":
        // Tool calls are tracked via the coarser tool_execution_* AgentEvents
        // (richer payload, stable toolCallId); assistant-generated images are
        // out of scope for the v1 transcript (message/thinking/tool only).
        return false;
      default:
        return false;
    }
  }

  /** Defensive reconciliation against the authoritative final message, in
   * case an individual `_end` sub-event never arrived (e.g. abort mid-stream). */
  private applyMessageEnd(message: AgentMessageT): boolean {
    if (message.role !== "assistant") return false;
    const group = this.assistantGroup;
    this.assistantGroup = null;
    if (group === null) return false;
    let changed = false;
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block = message.content[contentIndex];
      if (block.type === "text") {
        this.upsert(`${group}:text:${contentIndex}`, (prev) => ({
          kind: "assistant",
          id: `${group}:text:${contentIndex}`,
          text: block.text,
          streaming: false,
          timestamp: prev?.timestamp ?? message.timestamp,
        }));
        changed = true;
      } else if (block.type === "thinking") {
        this.upsert(`${group}:thinking:${contentIndex}`, (prev) => ({
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

  private applyToolEvent(
    event: Extract<
      RpcSessionEventFrame,
      { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
    >,
  ): void {
    this.upsert(event.toolCallId, (prev) => {
      const base: ToolExecutionEntry =
        prev && prev.kind === "tool"
          ? prev
          : {
              kind: "tool",
              id: event.toolCallId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: undefined,
              intent: undefined,
              status: "running",
              partialResult: undefined,
              result: undefined,
              isError: undefined,
              diffs: undefined,
              timestamp: Date.now(),
            };
      switch (event.type) {
        case "tool_execution_start":
          return {
            ...base,
            toolName: event.toolName,
            args: event.args,
            intent: event.intent,
            status: "running",
          };
        case "tool_execution_update":
          return {
            ...base,
            toolName: event.toolName,
            args: event.args,
            partialResult: event.partialResult,
            status: "running",
            diffs: extractDiffs(event.partialResult) ?? base.diffs,
          };
        case "tool_execution_end":
          return {
            ...base,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            status: event.isError ? "error" : "done",
            diffs: extractDiffs(event.result) ?? base.diffs,
          };
      }
    });
  }

  /** On a terminal `agent_end`/process exit: stop every still-"live" entry so
   * nothing is left showing a spinner or streaming cursor forever. Tool calls
   * still `"running"` get a distinct `"aborted"` status rather than being
   * guessed as `"error"` — we genuinely don't know how they would have ended. */
  private finalizeInFlight(): void {
    this.entries = this.entries.map((entry) => {
      if ((entry.kind === "assistant" || entry.kind === "thinking") && entry.streaming) {
        return { ...entry, streaming: false };
      }
      if (entry.kind === "tool" && entry.status === "running") {
        return { ...entry, status: "aborted" };
      }
      return entry;
    });
    this.assistantGroup = null;
  }

  private appendNotice(level: NoticeLevel, message: string, source?: string): void {
    this.entries = [
      ...this.entries,
      { kind: "notice", id: this.nextId("notice"), level, message, source, timestamp: Date.now() },
    ];
  }

  /** Replace-in-place-by-id (preserving position) or append. `make` receives
   * the previous entry sharing this id, if any, so deltas can accumulate. */
  private upsert(id: string, make: (prev: TranscriptEntry | undefined) => TranscriptEntry): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    const next = make(index >= 0 ? this.entries[index] : undefined);
    if (index >= 0) {
      const copy = this.entries.slice();
      copy[index] = next;
      this.entries = copy;
    } else {
      this.entries = [...this.entries, next];
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.idCounter}`;
  }

  private publish(): void {
    this.currentSnapshot = {
      entries: this.entries,
      running: this.running,
      aborting: this.aborting,
    };
    for (const listener of this.listeners) listener(this.currentSnapshot);
  }
}

/** Joins the text content of a user/developer message, ignoring images. */
function contentText(message: UserLikeMessage): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/**
 * Protocol notes §4.1: there is no dedicated diff event; edit tools ride
 * their diff inside `result.details.diff` (single-file edits, alongside
 * `details.path`) or `result.details.perFileResults[i].diff` (multi-file
 * edits, one entry per file). `result`/`partialResult` are wire `any`
 * (`EditToolDetails`/`WriteToolDetails`/... vary per tool), so this is
 * necessarily a defensive runtime shape check, not a typed access. Every
 * non-edit tool's details lack a `diff` field entirely, so they correctly
 * fall through to `undefined` here — never a fabricated diff.
 */
function extractDiffs(payload: unknown): FileDiff[] | undefined {
  if (typeof payload !== "object" || payload === null || !("details" in payload)) return undefined;
  const details = payload.details;
  if (typeof details !== "object" || details === null) return undefined;

  const perFile = "perFileResults" in details ? details.perFileResults : undefined;
  if (Array.isArray(perFile) && perFile.length > 0) {
    const diffs: FileDiff[] = [];
    for (const file of perFile as unknown[]) {
      if (typeof file !== "object" || file === null || !("diff" in file)) continue;
      const raw = file.diff;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const path = "path" in file && typeof file.path === "string" ? file.path : undefined;
      diffs.push({ path, raw, lines: parseUnifiedDiff(raw) });
    }
    if (diffs.length > 0) return diffs;
  }

  const direct = "diff" in details ? details.diff : undefined;
  if (typeof direct !== "string" || direct.length === 0) return undefined;
  const path = "path" in details && typeof details.path === "string" ? details.path : undefined;
  return [{ path, raw: direct, lines: parseUnifiedDiff(direct) }];
}

/** Matches one numbered diff row emitted by `generateDiffString` in the
 * pinned omp source: `+42|content` / `-42|content` / ` 42|content`. */
const NUMBERED_DIFF_ROW = /^([+\- ])(\d+)\|(.*)$/s;
/** Matches a unified-diff hunk header, e.g. `@@ -12,3 +12,4 @@`. */
const HUNK_HEADER_ROW = /^@@ .*@@.*$/;

/** Parses the wire diff format into add/remove/context lines the UI can
 * color directly, without re-parsing raw diff text. */
function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const row of diff.split("\n")) {
    const numbered = NUMBERED_DIFF_ROW.exec(row);
    if (numbered) {
      const [, prefix, lineNumber, content] = numbered;
      const kind: DiffLineKind = prefix === "+" ? "add" : prefix === "-" ? "remove" : "context";
      lines.push({ kind, lineNumber: Number(lineNumber), content });
      continue;
    }
    if (HUNK_HEADER_ROW.test(row)) {
      lines.push({ kind: "hunk", content: row });
      continue;
    }
    lines.push({ kind: "other", content: row });
  }
  return lines;
}
