/**
 * Shared rendering for omp's OAuth URL elicitation (`open_url`
 * `extension_ui_request`, ADR-0009): the sign-in card and the "open the
 * URL automatically the moment it arrives" behavior `LoginPanel` (session
 * header, T14/#15) and the Settings Accounts section (T25/#25) both need
 * while a `login()` call is mid-flight — extracted here so there is
 * exactly one implementation of each, not two differently-styled copies.
 */
import { useEffect, useRef } from "react";
import { ArrowSquareOutIcon, XIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { OAuthUrlElicitation } from "@omp-gui/ipc";
import { Button } from "@omp-gui/ui/components/button";
import { ExtensionUiCard } from "./approval-inbox";

/**
 * Opens `elicitation`'s sign-in URL automatically the moment it (or a
 * *new* one) arrives, with a manual fallback button still available on the
 * card this pairs with for when the automatic open doesn't reach the user
 * (a popup blocker, an accidentally-closed tab, …). `id` dedupes so a
 * re-render never re-triggers the same one.
 */
export function useAutoOpenElicitation(elicitation: OAuthUrlElicitation | undefined): void {
  const openedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (elicitation && openedId.current !== elicitation.id) {
      openedId.current = elicitation.id;
      void openUrl(elicitation.launchUrl ?? elicitation.url);
    }
  }, [elicitation]);
}

export interface LoginElicitationCardProps {
  elicitation: OAuthUrlElicitation;
  onDismiss: () => void;
}

/** The card itself: `ExtensionUiCard`'s shared chrome plus a manual
 * "Open sign-in page" button and a dismiss action. */
export function LoginElicitationCard({ elicitation, onDismiss }: LoginElicitationCardProps) {
  return (
    <ExtensionUiCard
      icon={ArrowSquareOutIcon}
      title="Continue in your browser"
      badgeLabel="Login"
      description={elicitation.instructions}
    >
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void openUrl(elicitation.launchUrl ?? elicitation.url)}>
          <ArrowSquareOutIcon />
          Open sign-in page
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <XIcon />
          Dismiss
        </Button>
      </div>
    </ExtensionUiCard>
  );
}
