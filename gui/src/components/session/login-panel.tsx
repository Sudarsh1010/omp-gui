/**
 * Provider login popover for a session's header (T14, issue #15;
 * ADR-0009 "credentials are omp's, the app is a pass-through"). Lists
 * every OAuth provider `get_login_providers` returns with a "Log in"
 * action and a read-only "Logged in as…" line, and renders the `open_url`
 * `extension_ui_request` elicitation `login()` triggers via
 * `login-elicitation.tsx`'s shared `LoginElicitationCard` (T25/#25 reuses
 * the same card from the Settings Accounts section rather than a second,
 * differently-styled one-off). Any further interactive step a provider
 * needs mid-flow (pasting a redirect code back) rides the same session's
 * `select`/`confirm`/`input`/`editor` `extension_ui_request` frames
 * `ApprovalInbox` already renders and answers — nothing here duplicates
 * that.
 */
import { useState } from "react";
import type { LoginProvider, SessionsStore } from "@omp-gui/ipc";
import { Badge } from "@omp-gui/ui/components/badge";
import { Button } from "@omp-gui/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@omp-gui/ui/components/item";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@omp-gui/ui/components/popover";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { SignInIcon, UserCircleCheckIcon, UserCircleIcon } from "@phosphor-icons/react";
import {
  LoginElicitationCard,
  useAutoOpenElicitation,
} from "@gui/components/session/login-elicitation";
import { useLogin } from "@gui/session/use-login";

export interface LoginPanelProps {
  store: SessionsStore;
  sessionId: string;
}

/**
 * Header entry point: a popover listing every provider, with the current
 * OAuth elicitation (if any) surfaced above the list.
 */
export function LoginPanel({ store, sessionId }: LoginPanelProps) {
  const [open, setOpen] = useState(false);
  const {
    providers,
    pendingProviderId,
    elicitation,
    loading,
    error,
    login,
    refreshProviders,
    dismissElicitation,
  } = useLogin(store, sessionId);

  // Auto-open the sign-in page as soon as a new elicitation arrives,
  // regardless of whether this popover happens to be open.
  useAutoOpenElicitation(elicitation);

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (nextOpen) void refreshProviders();
  }

  const loggedInCount = providers.filter((provider) => provider.authenticated).length;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm">
            <SignInIcon />
            {loggedInCount > 0 ? `Accounts (${loggedInCount})` : "Log in"}
          </Button>
        }
      />
      <PopoverContent className="w-80">
        <PopoverHeader>
          <PopoverTitle>Provider logins</PopoverTitle>
          <PopoverDescription>
            Credentials live in omp's own store, shared with your terminal omp — this app never
            stores them.
          </PopoverDescription>
        </PopoverHeader>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {elicitation ? (
          <LoginElicitationCard elicitation={elicitation} onDismiss={dismissElicitation} />
        ) : null}

        {loading && providers.length === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner />
            Loading providers…
          </div>
        ) : (
          <ItemGroup>
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                pending={pendingProviderId === provider.id}
                disabled={pendingProviderId !== undefined}
                onLogin={() => void login(provider.id)}
              />
            ))}
          </ItemGroup>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface ProviderRowProps {
  provider: LoginProvider;
  pending: boolean;
  disabled: boolean;
  onLogin: () => void;
}

function ProviderRow({ provider, pending, disabled, onLogin }: ProviderRowProps) {
  return (
    <Item variant="outline" size="sm">
      <ItemMedia variant="icon">
        {provider.authenticated ? (
          <UserCircleCheckIcon className="text-primary" />
        ) : (
          <UserCircleIcon />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{provider.name}</ItemTitle>
        <ItemDescription>
          {provider.authenticated
            ? `Logged in as ${provider.name}`
            : provider.available
              ? "Not logged in"
              : "Unavailable"}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {provider.authenticated ? (
          <Badge variant="outline">Logged in</Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !provider.available}
            onClick={onLogin}
          >
            {pending ? <Spinner /> : <SignInIcon />}
            Log in
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
