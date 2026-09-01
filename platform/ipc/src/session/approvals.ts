/**
 * Approval inbox (T4, issue #5) — the general `extension_ui_request`
 * blocking-prompt surface described in `gui/CONTEXT.md`'s "Approval" entry:
 * *"A permission prompt surfaced from omp as an `extension_ui_request`
 * frame and answered by the app with `extension_ui_response`."*
 *
 * Two layers:
 *
 *  - `ApprovalInbox` queues one session's blocking `extension_ui_request`
 *    frames (`method` `select`/`confirm`/`input`/`editor` — protocol.md
 *    §4.4; the other seven variants are fire-and-forget chrome/elicitation
 *    frames with nothing to queue) and answers them with the matching
 *    `extension_ui_response`. Framework-agnostic and single-session, same
 *    shape as `Transcript`: an immutable-snapshot `subscribe`/`getSnapshot`
 *    pair over one `RpcSession`.
 *  - `ApprovalRegistry` is the seam that makes the sidebar badge and OS
 *    notification correct for *every* session, not just the one currently
 *    mounted in `SessionView`. `SessionView` only renders the active
 *    session (`app-shell.tsx` mounts it with `key={activeId}`, so it fully
 *    unmounts on every switch) — an `ApprovalInbox` constructed inside that
 *    tree would stop listening the instant its session goes to the
 *    background, silently dropping approvals nobody could then see the
 *    badge for. The registry instead eagerly builds one `ApprovalInbox` per
 *    session as soon as `SessionsStore.getSession(id)` has a live
 *    `RpcSession` — mirroring how the store itself owns `Transcript` — and
 *    keeps it alive for the session's whole lifetime, wiring every count
 *    change into `store.setPendingApprovals`. `getApprovalRegistry` caches
 *    one registry per `SessionsStore` (a `WeakMap`, not a new prop threaded
 *    through `AppShell`/`SessionView`) so any mount point can reach the
 *    same live instance without widening those components' props.
 *
 * `RpcSession` gained one new method for this (`respondToExtensionUi`):
 * `extension_ui_response` is a one-way stdin frame the server never answers
 * with a `type: "response"` line (unlike every `RpcCommand`), so
 * `RpcSession.command()` — which always waits for one — cannot send it.
 * omp's own reference client resolves it the same way it resolves every
 * other side-channel frame: matched against its internal pending-dialog map
 * the instant it's read, never against the `response` queue (protocol.md
 * §5.4 "side-channel frames always overtake the queue").
 */
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcEventFrame, RpcSession } from "./session";
import type { SessionsStore } from "./sessions-store";

/**
 * The four `extension_ui_request` variants that block the agent's turn
 * until answered — the inbox's entire domain. `cancel` (withdrawal, see
 * `onFrame`), `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`
 * (fire-and-forget chrome updates), and `open_url` (non-blocking OAuth
 * elicitation) never reach a pending state and are ignored here.
 */
export type ApprovalRequest = Extract<
  RpcExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

/** One queued approval: the original request plus when this inbox saw it. */
export interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly receivedAt: number;
}

/**
 * What `answer()` accepts per `method` — `RpcExtensionUIResponse` minus
 * `id` (the inbox supplies that from the queued request) and minus the
 * `cancelled` variant (only ever sent by a host answering *late* after a
 * server-side timeout it never actually waited on, not a UI affordance
 * here — see protocol.md §4.4 timeout handling).
 */
export type ApprovalAnswer =
  | { readonly method: "confirm"; readonly confirmed: boolean }
  | { readonly method: "select" | "input" | "editor"; readonly value: string };

export type ApprovalInboxSnapshot = readonly PendingApproval[];

const EMPTY_SNAPSHOT: ApprovalInboxSnapshot = [];

const BLOCKING_METHOD: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
};

/**
 * Narrows a blocking-variant `extension_ui_request` frame, or `undefined`
 * if it doesn't match. Validated to the same depth as the pinned client's
 * own `isRpcExtensionUiRequest` (`type`/`id`/`method` only) — the rest of
 * the shape is trusted, matching this codebase's existing posture toward
 * frames from the pinned binary (`session.ts`'s own frame handling never
 * validates past `type` either).
 */
function asApprovalRequest(frame: RpcEventFrame): ApprovalRequest | undefined {
  if (frame.type !== "extension_ui_request") return undefined;
  if (typeof frame.id !== "string" || typeof frame.method !== "string") return undefined;
  if (!BLOCKING_METHOD[frame.method]) return undefined;
  return frame as unknown as ApprovalRequest;
}

/** Narrows a `cancel`-method `extension_ui_request`, returning the
 * withdrawn request's id, or `undefined` if it doesn't match. */
function asCancelTargetId(frame: RpcEventFrame): string | undefined {
  if (frame.type !== "extension_ui_request") return undefined;
  if (frame.method !== "cancel" || typeof frame.targetId !== "string") return undefined;
  return frame.targetId;
}

/**
 * Normalizes one `RpcSession`'s `extension_ui_request` frames into a
 * queue, and answers them. Owns no transport/negotiation concerns (that
 * stays in `RpcSession`); only interprets already-decoded frames — same
 * division of responsibility as `Transcript`.
 */
export class ApprovalInbox {
  private snapshot: ApprovalInboxSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<(snapshot: ApprovalInboxSnapshot) => void>();
  private readonly requestListeners = new Set<(pending: PendingApproval) => void>();
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(private readonly session: RpcSession) {
    this.unsubscribeEvent = session.onEvent((frame) => this.onFrame(frame));
    this.unsubscribeExit = session.onExit(() => this.onExit());
  }

  /** Stable reference; call again after every `subscribe` notification. */
  getSnapshot = (): ApprovalInboxSnapshot => this.snapshot;

  /** Register for queue-changed notifications (an answer, a withdrawal, or
   * a new request arriving). Returns an unsubscribe function. */
  subscribe = (listener: (snapshot: ApprovalInboxSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable reference to the live pending count, for a consumer (the
   * sidebar badge wiring) that only cares about the number. */
  getCount = (): number => this.snapshot.length;

  /**
   * Fires once per newly queued request — never for an answer or a
   * withdrawal. Distinct from `subscribe`, which fires on every queue
   * change; the OS-notification seam only ever wants to know about
   * arrivals, not departures.
   */
  onRequest = (listener: (pending: PendingApproval) => void): (() => void) => {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  };

  /**
   * Answer a queued request with the matching `extension_ui_response`,
   * dequeuing it and letting the agent's turn resume. No-op if
   * `requestId` is no longer pending (already answered, or withdrawn by
   * the server via a `cancel` request).
   */
  answer(requestId: string, answer: ApprovalAnswer): void {
    if (!this.snapshot.some((pending) => pending.request.id === requestId)) return;
    this.snapshot = this.snapshot.filter((pending) => pending.request.id !== requestId);
    this.notify();
    this.session.respondToExtensionUi(
      answer.method === "confirm"
        ? { type: "extension_ui_response", id: requestId, confirmed: answer.confirmed }
        : { type: "extension_ui_response", id: requestId, value: answer.value },
    );
  }

  /** Detach from the session's event stream. Does not touch the session/process. */
  dispose(): void {
    this.unsubscribeEvent();
    this.unsubscribeExit();
    this.listeners.clear();
    this.requestListeners.clear();
  }

  private onFrame(frame: RpcEventFrame): void {
    const cancelledId = asCancelTargetId(frame);
    if (cancelledId !== undefined) {
      if (!this.snapshot.some((pending) => pending.request.id === cancelledId)) return;
      this.snapshot = this.snapshot.filter((pending) => pending.request.id !== cancelledId);
      this.notify();
      return;
    }

    const request = asApprovalRequest(frame);
    if (!request) return;
    const pending: PendingApproval = { request, receivedAt: Date.now() };
    this.snapshot = [...this.snapshot, pending];
    this.notify();
    for (const listener of this.requestListeners) listener(pending);
  }

  /** A dead subprocess can never resume from an answer, so its still-
   * pending requests are no longer answerable — clear them rather than
   * leaving a stuck badge count on a session that isn't running. */
  private onExit(): void {
    if (this.snapshot.length === 0) return;
    this.snapshot = EMPTY_SNAPSHOT;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

interface TrackedInbox {
  readonly inbox: ApprovalInbox;
  readonly unsubscribeCount: () => void;
  readonly unsubscribeRequest: () => void;
}

/**
 * Tracks one `ApprovalInbox` per session in a `SessionsStore`, created the
 * moment `getSession(id)` first has a live `RpcSession` and disposed the
 * moment the session drops out of `list()` — independent of which
 * session's `SessionView` (if any) happens to be mounted, see the
 * top-of-file comment. Wires every inbox's live count into
 * `store.setPendingApprovals`, and re-broadcasts every session's new
 * requests through one cross-session `onRequest` for the OS-notification
 * hook.
 */
export class ApprovalRegistry {
  private readonly inboxes = new Map<string, TrackedInbox>();
  private readonly requestListeners = new Set<
    (sessionId: string, pending: PendingApproval) => void
  >();
  private readonly unsubscribeStore: () => void;

  constructor(private readonly store: SessionsStore) {
    this.unsubscribeStore = store.subscribe(() => this.reconcile());
    this.reconcile();
  }

  /** The live inbox for a session, or `undefined` before its `RpcSession`
   * exists (connecting, start failure) or once the session is closed —
   * mirrors `SessionsStore.getSession`'s own lifecycle. */
  getInbox(sessionId: string): ApprovalInbox | undefined {
    return this.inboxes.get(sessionId)?.inbox;
  }

  /** Fires once per newly queued request from any tracked session — a
   * blocked background session must draw attention just as loudly as the
   * active one (issue #1 story #15). */
  onRequest(listener: (sessionId: string, pending: PendingApproval) => void): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  /** Stop tracking every session. Does not touch the store or its sessions. */
  dispose(): void {
    this.unsubscribeStore();
    for (const tracked of this.inboxes.values()) {
      tracked.unsubscribeCount();
      tracked.unsubscribeRequest();
      tracked.inbox.dispose();
    }
    this.inboxes.clear();
    this.requestListeners.clear();
  }

  private reconcile(): void {
    const live = new Set(this.store.list().map((session) => session.id));

    for (const [id, tracked] of this.inboxes) {
      if (live.has(id)) continue;
      tracked.unsubscribeCount();
      tracked.unsubscribeRequest();
      tracked.inbox.dispose();
      this.inboxes.delete(id);
    }

    for (const id of live) {
      if (this.inboxes.has(id)) continue;
      const session = this.store.getSession(id);
      if (!session) continue;
      const inbox = new ApprovalInbox(session);
      const unsubscribeCount = inbox.subscribe((snapshot) =>
        this.store.setPendingApprovals(id, snapshot.length),
      );
      const unsubscribeRequest = inbox.onRequest((pending) => {
        for (const listener of this.requestListeners) listener(id, pending);
      });
      this.inboxes.set(id, { inbox, unsubscribeCount, unsubscribeRequest });
    }
  }
}

const registries = new WeakMap<SessionsStore, ApprovalRegistry>();

/**
 * The per-`SessionsStore` singleton `ApprovalRegistry`, created on first
 * use and reused for the store's lifetime. The app constructs exactly one
 * `SessionsStore`, so in practice this is an app-wide singleton — without
 * threading a new prop through `AppShell`/`SessionView` (see the
 * top-of-file comment).
 */
export function getApprovalRegistry(store: SessionsStore): ApprovalRegistry {
  const existing = registries.get(store);
  if (existing) return existing;
  const registry = new ApprovalRegistry(store);
  registries.set(store, registry);
  return registry;
}
