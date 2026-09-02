import { useCallback, useEffect, useRef, useState } from "react";
import { type RelayInfo } from "@omp-gui/ipc";
import { useBridge } from "@gui/bridge-context";
import { Switch } from "@omp-gui/ui/components/switch";
import { Label } from "@omp-gui/ui/components/label";
import { Badge } from "@omp-gui/ui/components/badge";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { Alert, AlertTitle, AlertDescription } from "@omp-gui/ui/components/alert";
import { WarningIcon } from "@phosphor-icons/react";

type ToggleStatus = "off" | "enabling" | "on" | "disabling" | "error";

/** How often to re-probe while enabled but not yet connected, so the badge
 * flips to "connected" on its own once a reaped extension service worker
 * finishes its handshake (up to ~35s, notes/browser.md §6) instead of
 * requiring the user to retoggle. */
const EXTENSION_POLL_MS = 2_000;

export interface RelayToggleProps {
  /**
   * Opaque per-task key the app tracks relay membership by
   * (`browser_set_relay`'s `sessionId`, ADR-0006's per-task toggle). Pass
   * the owning omp session's id once sessions carry one through this route;
   * any stable string works today — the app only uses it to know which
   * toggles still want relay mode on when deciding whether to tear the
   * shared daemon down.
   */
  sessionId: string;
}

/**
 * Per-task "run in my real browser" toggle (issue #12, ADR-0006
 * §"Human-in-the-loop"): flips a session's browser between the app-owned
 * connected Chromium (T9's Browser Pane) and omp's `relay` kind, which
 * drives the user's own, already-logged-in Chrome through the browser-relay
 * extension — for SSO, hardware-key, password-manager, and payment flows
 * synthesized input mishandles.
 *
 * User-side prerequisite this component cannot satisfy on its own: the OMP
 * Browser Relay Chrome extension must be installed once
 * (`omp browser-relay install`, then "Load unpacked" in
 * `chrome://extensions`). Until it is, enabling shows "waiting for
 * extension" — the relay server is genuinely up (agent tool calls that
 * resolve to it will queue against a real, reachable endpoint), it just has
 * nothing to drive yet.
 */
export function RelayToggle({ sessionId }: RelayToggleProps) {
  const relayBridge = useBridge();
  const [status, setStatus] = useState<ToggleStatus>("off");
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `number`, not `NodeJS.Timeout`: this package's `lib` is `["ES2024",
  // "DOM"]` (no `@types/node`), so `setInterval` resolves to the DOM lib's
  // browser signature here.
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (status !== "on" || info?.extensionConnected) {
      stopPolling();
      return;
    }
    // A quiet background refresh, not a full re-enable: it updates `info`
    // only, so the switch never flickers into a disabled/busy state while
    // this is running.
    pollRef.current = window.setInterval(() => {
      relayBridge.browserSetRelay(sessionId, true).then(setInfo, () => {});
    }, EXTENSION_POLL_MS);
    return stopPolling;
  }, [status, info?.extensionConnected, sessionId, stopPolling]);

  const toggle = useCallback(
    async (next: boolean) => {
      setStatus(next ? "enabling" : "disabling");
      setError(null);
      try {
        const result = await relayBridge.browserSetRelay(sessionId, next);
        setInfo(result);
        setStatus(result.enabled ? "on" : "off");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [sessionId],
  );

  const checked = status === "on" || status === "enabling";
  const busy = status === "enabling" || status === "disabling";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={`relay-toggle-${sessionId}`} className="gap-2 text-sm">
          {busy ? <Spinner className="size-3.5" /> : null}
          Relay: run in my real Chrome
        </Label>
        <Switch
          id={`relay-toggle-${sessionId}`}
          checked={checked}
          disabled={busy}
          onCheckedChange={(next) => void toggle(next)}
        />
        {status === "on" && (
          <Badge variant={info?.extensionConnected ? "secondary" : "outline"}>
            {info?.extensionConnected ? "connected" : "waiting for extension"}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Applies to sessions started after this toggle — a session already running keeps whichever
        browser kind it resolved at its own startup.
      </p>
      {status === "on" && !info?.extensionConnected && (
        <p className="text-xs text-muted-foreground">
          Relay server is up. Install the extension once with <code>omp browser-relay install</code>
          , load it unpacked in Chrome, and keep this task's tabs open there — the agent will drive
          them as soon as it attaches.
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>Relay toggle failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
