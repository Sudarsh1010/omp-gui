/**
 * Per-session OAuth login pass-through (T14, issue #15; ADR-0009
 * "credentials are omp's, the app is a pass-through"). Framework-agnostic
 * like `models.ts`/`sessions-store.ts` (no React import here): wraps one
 * live `RpcSession`'s OAuth provider list and drives `get_login_providers`/
 * `login`, surfacing the `open_url` `extension_ui_request` elicitation omp
 * emits mid-flow so the host can render it.
 *
 * Every field on `LoginProvider` is a verbatim projection of omp's own
 * `get_login_providers` response (`rpc-types.ts:332-338`) — this module
 * stores, computes, and caches no credential-adjacent state of its own.
 * "Logged in as…" is exactly `authenticated` + `name`; there is no separate
 * identity field on the wire, and none is invented here.
 *
 * ## Why a `login()` timeout isn't a failure
 *
 * omp does not answer the `login` command until the whole OAuth round trip
 * resolves (`rpc-mode.ts`'s `case "login"` `await`s
 * `authStorage.login(...)` before responding) — routinely minutes for a
 * human to finish a provider's consent screen in their browser, far past
 * `RpcSession.command()`'s fixed 30s `COMMAND_TIMEOUT_MS`. That timeout
 * rejecting client-side does not mean the login failed: omp is still
 * working server-side, and `RpcSession.handleLine` already re-emits any
 * `response` frame whose `id` no longer has a pending entry as a generic
 * event instead of dropping it (session.ts:306-314 — protocol.md §5.4's
 * "side-channel frames always overtake the queue"). This module treats
 * exactly that rejection as "still pending" and finishes the flow off the
 * late event instead of surfacing a false failure.
 *
 * The one interactive step some providers need mid-flow (pasting a
 * redirect URL/code back) rides the same blocking `extension_ui_request`
 * variants (`select`/`confirm`/`input`/`editor`) T4's `ApprovalInbox`
 * already surfaces and answers via `RpcSession.respondToExtensionUi` — as
 * long as it's mounted for the session, that "just works" with zero code
 * here. This module only special-cases `open_url`, the one variant
 * `ApprovalInbox` deliberately excludes from its own blocking-method set
 * (`approvals.ts`'s `BLOCKING_METHOD`).
 */
import type {
  RpcExtensionUIRequest,
  RpcResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { RpcEventFrame, RpcSession } from "./session";

type GetLoginProvidersResponse = Extract<RpcResponse, { command: "get_login_providers" }>;

/** One OAuth provider omp knows about, exactly as `get_login_providers`
 * returns it. Re-exported under this name so consumers never need their
 * own dependency on the pinned `@oh-my-pi/pi-coding-agent` package — same
 * rationale as `models.ts`'s `SessionModel`. */
export type LoginProvider = GetLoginProvidersResponse["data"]["providers"][number];

/** The `open_url` `extension_ui_request` variant (`rpc-types.ts:428-440`)
 * — omp's OAuth URL elicitation, surfaced verbatim like `approvals.ts`'s
 * `ApprovalRequest`. */
export type OAuthUrlElicitation = Extract<RpcExtensionUIRequest, { method: "open_url" }>;

export interface LoginSnapshot {
  providers: readonly LoginProvider[];
  /** The provider id a `login()` call is currently in flight for, or
   * `undefined` when none is. Single-flight: the wire has no id linking
   * an `open_url` frame back to a specific `login` call, so only one
   * login is tracked at a time — a second `login()` call is a no-op
   * while one is already pending. */
  pendingProviderId: string | undefined;
  /** The most recent still-open `open_url` elicitation: `undefined` once
   * the login it belongs to resolves, a matching `cancel` withdraws it,
   * or `dismissElicitation()` hides it locally. */
  elicitation: OAuthUrlElicitation | undefined;
  /** True until the initial `get_login_providers` round trip resolves. */
  loading: boolean;
  /** Message from the most recently failed load or `login()` call;
   * cleared on the next successful operation. */
  error: string | undefined;
}

/** Shared across every `LoginController` until its first `emit` replaces
 * the reference — never mutated, so sharing it is safe (mirrors
 * `models.ts`'s `EMPTY_MODEL_SELECTION_SNAPSHOT`). */
export const EMPTY_LOGIN_SNAPSHOT: LoginSnapshot = {
  providers: [],
  pendingProviderId: undefined,
  elicitation: undefined,
  loading: true,
  error: undefined,
};

export interface LoginController {
  getSnapshot(): LoginSnapshot;
  /** Register for snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Send `get_login_providers` and reflect the returned list. */
  refreshProviders(): Promise<void>;
  /**
   * Send `login` for `providerId`. Resolves once omp answers within
   * `RpcSession`'s command timeout, or immediately once that timeout
   * fires while the flow is still legitimately in progress — see this
   * module's header comment; watch `getSnapshot()` for the eventual
   * outcome rather than this promise in that case. Rejects (after
   * reflecting the error on the snapshot) for a real, fast failure — e.g.
   * an unknown provider id. No-op while another login is already pending.
   */
  login(providerId: string): Promise<void>;
  /** Hide the current elicitation locally without telling omp anything —
   * e.g. the user closed the browser tab. Per ADR-0009, nothing here can
   * cancel or otherwise touch the credential omp is mid-negotiating; the
   * underlying `login` command is left to resolve or time out
   * server-side on its own. */
  dismissElicitation(): void;
  /** Stop listening to the underlying session's events. Call when the
   * owning session closes or the consumer unmounts. */
  dispose(): void;
}

/** Narrows an `open_url`-method `extension_ui_request` frame, or
 * `undefined` if it doesn't match — mirrors `approvals.ts`'s
 * `asApprovalRequest`, for the one variant `ApprovalInbox` deliberately
 * excludes from its own blocking-method set. */
function asOAuthUrlElicitation(frame: RpcEventFrame): OAuthUrlElicitation | undefined {
  if (frame.type !== "extension_ui_request" || frame.method !== "open_url") return undefined;
  if (typeof frame.id !== "string" || typeof frame.url !== "string") return undefined;
  return frame as unknown as OAuthUrlElicitation;
}

/** Narrows a `cancel`-method `extension_ui_request`, returning the
 * withdrawn request's id, or `undefined` if it doesn't match — mirrors
 * `approvals.ts`'s own (private, so re-declared here) `asCancelTargetId`.
 * protocol.md §4.4 documents `cancel` as a general per-request-id
 * withdrawal any host should honor, not something specific to approvals. */
function asCancelTargetId(frame: RpcEventFrame): string | undefined {
  if (frame.type !== "extension_ui_request" || frame.method !== "cancel") return undefined;
  return typeof frame.targetId === "string" ? frame.targetId : undefined;
}

/** Narrows a `login` response frame (fast or late — see this module's
 * header comment) to its outcome, or `undefined` if it doesn't match.
 * Deliberately not `Extract<RpcResponse, {command: "login"}>`: that only
 * ever resolves to the success arm (the generic failure arm's
 * `command: string` isn't assignable to the literal `"login"`), so a
 * hand-rolled shape is the only way to read a *failed* `login` response
 * off the raw event stream here. */
function asLoginOutcome(
  frame: RpcEventFrame,
): { success: boolean; error: string | undefined } | undefined {
  if (frame.type !== "response" || frame.command !== "login" || typeof frame.success !== "boolean") {
    return undefined;
  }
  return {
    success: frame.success,
    error: frame.success ? undefined : typeof frame.error === "string" ? frame.error : "Login failed",
  };
}

/**
 * Creates a `LoginController` bound to one live `RpcSession`. Fetches
 * `get_login_providers` immediately; call `dispose()` once the session
 * goes away.
 */
export function createLoginController(session: RpcSession): LoginController {
  let snapshot = EMPTY_LOGIN_SNAPSHOT;
  const listeners = new Set<() => void>();

  const emit = (next: Partial<LoginSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const refreshProviders = async (): Promise<void> => {
    try {
      const response = await session.command({ type: "get_login_providers" });
      emit({ providers: response.data.providers, loading: false, error: undefined });
    } catch (error) {
      emit({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  void refreshProviders();

  const finishLogin = (providerId: string, success: boolean, error: string | undefined): void => {
    if (snapshot.pendingProviderId !== providerId) return;
    emit({ pendingProviderId: undefined, elicitation: undefined, error });
    if (success) void refreshProviders();
  };

  const unsubscribeEvent = session.onEvent((frame: RpcEventFrame) => {
    const elicitation = asOAuthUrlElicitation(frame);
    if (elicitation) {
      emit({ elicitation });
      return;
    }

    const cancelledId = asCancelTargetId(frame);
    if (cancelledId !== undefined) {
      if (snapshot.elicitation?.id === cancelledId) emit({ elicitation: undefined });
      return;
    }

    const outcome = asLoginOutcome(frame);
    if (outcome && snapshot.pendingProviderId) {
      finishLogin(snapshot.pendingProviderId, outcome.success, outcome.error);
    }
  });

  // If the subprocess exits while a login is still pending past
  // `RpcSession.command()`'s own timeout (the late-response path above
  // never got a chance to fire because there will be no more frames at
  // all), don't leave the snapshot claiming a login is forever in
  // flight — reflect the session going away as the failure it is.
  const unsubscribeExit = session.onExit(() => {
    if (snapshot.pendingProviderId) {
      finishLogin(snapshot.pendingProviderId, false, "omp session closed");
    }
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshProviders,
    async login(providerId) {
      if (snapshot.pendingProviderId !== undefined) return;
      emit({ pendingProviderId: providerId, elicitation: undefined, error: undefined });
      try {
        await session.command({ type: "login", providerId });
        finishLogin(providerId, true, undefined);
      } catch (error) {
        if (error instanceof Error && error.message === "timed out waiting for response to login") return;
        finishLogin(providerId, false, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    dismissElicitation() {
      emit({ elicitation: undefined });
    },
    dispose() {
      unsubscribeEvent();
      unsubscribeExit();
    },
  };
}
