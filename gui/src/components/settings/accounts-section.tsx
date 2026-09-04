/**
 * Accounts section (T25, issue #19/#25; ADR-0011 "Bespoke sections"): one
 * 32px `SettingsRow` per OAuth/credential provider omp's auth broker knows
 * about (`auth-broker list --json`), with "logged in as …" from
 * `token --list` and a Log in / Log out action.
 *
 * Login rides the existing rpc-ui login pass-through on the active session
 * (`session/login.ts`, ADR-0009) — the same controller and URL-elicitation
 * card `LoginPanel` uses (`login-elicitation.tsx`), never a second
 * implementation. With no session running, login has nothing to ride on,
 * so the section explains that and offers "Start a session" — the same
 * `store.createSession()` call `app-shell.tsx`'s own empty state uses.
 * Logout needs no session at all (`auth.rs`'s `auth_logout` shells out
 * directly), so it stays enabled regardless.
 *
 * Degrades to `SectionError` when the provider/account listing itself
 * fails (omp unreachable) — independent of whether a session happens to be
 * running, per ADR-0011 "Bootstrap independence".
 */
import { useState } from "react";
import type { SessionsStore } from "@omp-gui/ipc";
import { Button } from "@omp-gui/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@omp-gui/ui/components/empty";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { PlusIcon, SignInIcon } from "@phosphor-icons/react";
import {
  LoginElicitationCard,
  useAutoOpenElicitation,
} from "@gui/components/session/login-elicitation";
import { useLogin } from "@gui/session/use-login";
import { useSessions } from "@gui/session/use-sessions";
import { useAccounts } from "@gui/settings/use-accounts";
import { SectionError } from "./section-error";
import { SectionSkeleton } from "./section-skeleton";
import { SessionsNote } from "./sessions-note";
import { useSettingsContext } from "./settings-context";
import { SettingsGroup } from "./settings-group";
import { SettingsRow } from "./settings-row";

export interface AccountsSectionProps {
  store: SessionsStore;
}

export function AccountsSection({ store }: AccountsSectionProps) {
  const { bridge } = useSettingsContext();
  const accounts = useAccounts(bridge);
  const { activeId, createSession } = useSessions(store);
  const login = useLogin(store, activeId ?? "");
  const [pendingLogoutId, setPendingLogoutId] = useState<string | undefined>(undefined);

  useAutoOpenElicitation(login.elicitation);

  async function handleLogin(providerId: string) {
    try {
      await login.login(providerId);
    } finally {
      void accounts.reload();
    }
  }

  async function handleLogout(providerId: string) {
    setPendingLogoutId(providerId);
    try {
      await accounts.logout(providerId);
    } finally {
      setPendingLogoutId(undefined);
    }
  }

  if (accounts.status === "loading" && accounts.rows.length === 0) {
    return <SectionSkeleton rows={6} />;
  }

  if (accounts.status === "error" && accounts.error) {
    return (
      <SectionError
        title="Accounts unavailable"
        stage={accounts.error.stage}
        message={accounts.error.message}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!activeId && (
        <Empty className="ring-1 ring-foreground/10 py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SignInIcon />
            </EmptyMedia>
            <EmptyTitle>Login needs a running session</EmptyTitle>
            <EmptyDescription>
              Logging in to a provider goes through a session's own connection to omp. Start one to
              sign in — logging out doesn't need a session.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={createSession}>
              <PlusIcon />
              Start a session
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {login.elicitation && (
        <LoginElicitationCard
          elicitation={login.elicitation}
          onDismiss={login.dismissElicitation}
        />
      )}

      <SettingsGroup title="Accounts">
        {accounts.rows.map((row) => (
          <SettingsRow
            key={row.providerId}
            rowKey={`accounts.${row.providerId}`}
            label={row.label}
            description={row.loggedInAs ? `Logged in as ${row.loggedInAs}` : "Not logged in"}
          >
            {row.loggedInAs ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pendingLogoutId === row.providerId}
                onClick={() => void handleLogout(row.providerId)}
              >
                {pendingLogoutId === row.providerId && <Spinner />}
                Log out
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={!activeId || login.pendingProviderId !== undefined}
                onClick={() => void handleLogin(row.providerId)}
              >
                {login.pendingProviderId === row.providerId && <Spinner />}
                Log in
              </Button>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
      <SessionsNote />
    </div>
  );
}
