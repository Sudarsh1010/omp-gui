/**
 * Accounts section controller (T25, issue #19/#25; ADR-0011 "Bespoke
 * sections"): a framework-agnostic snapshot/subscribe/reload/dispose
 * wrapper joining the Shell Bridge's `authProvidersList`/`authAccountsList`
 * into one row per provider — `{ providerId, label, loggedInAs }` — plus a
 * `logout` action, mirroring `preferences/app-preferences.ts`'s shape for
 * a Shell-Bridge-direct (not `RpcSession`-bound) controller.
 *
 * Login is deliberately not here: it rides the existing rpc-ui pass-through
 * on whichever session is active (`session/login.ts`, ADR-0009) — this
 * controller only owns the read side (the provider catalog and each
 * provider's stored accounts) and the one write omp's CLI can do without a
 * running session, logout. A consumer calls `reload()` after either
 * completes so `loggedInAs` reflects the new state.
 */
import type { AuthAccount, AuthProvider, ShellBridge } from "../bridge/shell-bridge";
import { BridgeCommandError } from "../bridge/shell-bridge";

export type AccountsStatus = "loading" | "ready" | "error";

/** One Accounts section row: a provider from `auth-broker list --json`
 * joined with its first stored account (if any) from `token --list`. */
export interface AccountRow {
  providerId: string;
  label: string;
  /** The stored account's identity (email, account/project id, …), or
   * `null` when nothing is stored for this provider. A provider can have
   * more than one stored account (`token`'s `--account` selects among
   * them); the row surfaces the first so "logged in as" stays a single
   * line — the full set is available from `accounts` on the snapshot. */
  loggedInAs: string | null;
}

export interface AccountsSnapshot {
  status: AccountsStatus;
  rows: readonly AccountRow[];
  /** Every stored account, ungrouped — `rows` derives `loggedInAs` from
   * this, kept on the snapshot too for a consumer that needs the full set
   * (e.g. more than one stored account for a provider). */
  accounts: readonly AuthAccount[];
  /** Failure detail from the most recent `reload`/`logout`, naming the
   * stage omp couldn't be reached at (a `SectionError` degrade trigger,
   * ADR-0011 "Bootstrap independence") — `undefined` once a reload
   * succeeds. */
  error: { stage: string; message: string } | undefined;
}

export const EMPTY_ACCOUNTS_SNAPSHOT: AccountsSnapshot = {
  status: "loading",
  rows: [],
  accounts: [],
  error: undefined,
};

export interface AccountsController {
  snapshot(): AccountsSnapshot;
  /** Register for snapshot changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-read providers and accounts from omp, replacing the snapshot. */
  reload(): Promise<void>;
  /** Log a provider out of omp's own credential store, then reload. */
  logout(providerId: string): Promise<void>;
  dispose(): void;
}

function authBridge(
  bridge: ShellBridge,
): Required<Pick<ShellBridge, "authProvidersList" | "authAccountsList" | "authLogout">> {
  if (!bridge.authProvidersList || !bridge.authAccountsList || !bridge.authLogout) {
    throw new Error("this ShellBridge does not implement Accounts");
  }
  return {
    authProvidersList: bridge.authProvidersList,
    authAccountsList: bridge.authAccountsList,
    authLogout: bridge.authLogout,
  };
}

/** Joins providers with accounts into one row per provider, `loggedInAs`
 * the lowest-`position` (first) stored account's identity or `null`. */
function buildRows(
  providers: readonly AuthProvider[],
  accounts: readonly AuthAccount[],
): AccountRow[] {
  const firstAccountByProvider = new Map<string, AuthAccount>();
  for (const account of accounts) {
    const current = firstAccountByProvider.get(account.providerId);
    if (!current || account.position < current.position) {
      firstAccountByProvider.set(account.providerId, account);
    }
  }
  return providers.map((provider) => ({
    providerId: provider.id,
    label: provider.name,
    loggedInAs: firstAccountByProvider.get(provider.id)?.identity ?? null,
  }));
}

/** Extracts `{ stage, message }` from a `CliError`-carrying
 * `BridgeCommandError`, falling back to a bare message for anything else
 * (a transport-level failure, not omp's own `CliError` shape). */
function describeError(error: unknown): { stage: string; message: string } {
  if (error instanceof BridgeCommandError) {
    const cliError = error.error;
    if (cliError && typeof cliError === "object" && "type" in cliError) {
      if (cliError.type === "unavailable") {
        return { stage: cliError.stage, message: cliError.message };
      }
      if (cliError.type === "rejected") {
        return { stage: "rejected", message: cliError.message };
      }
    }
  }
  return { stage: "unknown", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Creates an `AccountsController` bound to one `ShellBridge`. Fetches
 * providers and accounts immediately; call `dispose()` when the owning
 * Settings route unmounts.
 */
export function createAccountsController(bridge: ShellBridge): AccountsController {
  let snapshot = EMPTY_ACCOUNTS_SNAPSHOT;
  const listeners = new Set<() => void>();

  const emit = (next: Partial<AccountsSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const reload = async () => {
    try {
      const { authProvidersList, authAccountsList } = authBridge(bridge);
      const [providers, accounts] = await Promise.all([authProvidersList(), authAccountsList()]);
      emit({ status: "ready", rows: buildRows(providers, accounts), accounts, error: undefined });
    } catch (error) {
      emit({ status: "error", error: describeError(error) });
    }
  };

  void reload();

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload,
    async logout(providerId) {
      try {
        await authBridge(bridge).authLogout(providerId);
      } catch (error) {
        emit({ error: describeError(error) });
        throw error;
      }
      await reload();
    },
    dispose() {
      listeners.clear();
    },
  };
}
