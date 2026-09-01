import { useCallback, useEffect, useRef, useState } from "react";
import { tauriBridge, type BrowserInfo } from "@omp-gui/ipc";
import { Button } from "@omp-gui/ui/components/button";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { Badge } from "@omp-gui/ui/components/badge";
import { Alert, AlertTitle, AlertDescription } from "@omp-gui/ui/components/alert";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@omp-gui/ui/components/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@omp-gui/ui/components/empty";
import { GlobeIcon, PlayIcon, StopIcon, WarningIcon } from "@phosphor-icons/react";

/**
 * One `tauriBridge()` instance for every Browser Pane on screen. Constructed
 * once at module scope — mirroring `main.tsx`'s own `tauriBridge()` call —
 * rather than threaded through router context, so this component stays
 * self-contained and collision-free with the app shell (`__root.tsx`) other
 * wave-1 tickets are actively reworking.
 */
const browserBridge = tauriBridge();

type PaneStatus = "idle" | "launching" | "live" | "error";

export interface BrowserPaneProps {
  /** The project whose app-owned Chromium this pane launches and watches. */
  projectPath: string;
}

/**
 * The app's live view of the agent-driven, app-owned Chromium (ADR-0006):
 * launches (or attaches to) a per-project Chrome for Testing instance and
 * renders its screencast, streamed over the pane's own localhost WebSocket
 * endpoint — never through Tauri events (ADR-0007).
 */
export function BrowserPane({ projectPath }: BrowserPaneProps) {
  const [status, setStatus] = useState<PaneStatus>("idle");
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  const launch = useCallback(async () => {
    setStatus("launching");
    setError(null);
    try {
      const launched = await browserBridge.browserLaunch(projectPath);
      setInfo(launched);
      setStatus("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [projectPath]);

  const stop = useCallback(async () => {
    const current = info;
    if (!current) return;
    setInfo(null);
    setStatus("idle");
    setError(null);
    await browserBridge.browserStop(current.projectPath).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    });
  }, [info]);

  // The frame subscription is purely a *view* concern: closing it (on
  // unmount, or when `info` changes) never stops the Chromium itself — only
  // an explicit Stop does, since the pane may outlive any one viewer
  // (ADR-0006's persistent-per-project browser is meant to survive that).
  useEffect(() => {
    if (!info) return;
    const ws = new WebSocket(info.frameEndpoint);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const url = URL.createObjectURL(new Blob([event.data], { type: "image/jpeg" }));
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = url;
      setFrameUrl(url);
    };
    ws.onerror = () => {
      // The pane's *view* lost its connection to the frame endpoint — the
      // Chromium itself is untouched, so status stays "live" (Stop remains
      // correct) rather than implying the browser stopped.
      setError("lost connection to the pane frame endpoint; the browser is still running");
    };
    return () => {
      ws.close();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
      setFrameUrl(null);
    };
  }, [info]);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b border-border py-3">
        <CardTitle className="flex items-center gap-1.5">
          <GlobeIcon />
          Browser Pane
          {status === "live" && <Badge variant="secondary">live</Badge>}
        </CardTitle>
        <CardDescription>{projectPath}</CardDescription>
        <CardAction>
          {status === "live" ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void stop()}>
              <StopIcon />
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={status === "launching"}
              onClick={() => void launch()}
            >
              {status === "launching" ? <Spinner /> : <PlayIcon />}
              {status === "launching" ? "Launching…" : "Launch"}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {error && (
          <Alert variant="destructive" className="m-3 w-auto">
            <WarningIcon />
            <AlertTitle>Browser Pane failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-black">
          {frameUrl ? (
            // The live screencast: a plain <img> fed by successive object
            // URLs from the frame WebSocket (see the effect above) — the
            // MJPEG-over-WebSocket approach ADR-0007's frame endpoint is
            // built for.
            <img
              src={frameUrl}
              alt={`Live view of the agent-driven browser for ${projectPath}`}
              className="h-full w-full object-contain"
            />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {status === "launching" ? (
                    <Spinner className="size-6" />
                  ) : (
                    <GlobeIcon className="size-6" />
                  )}
                </EmptyMedia>
                <EmptyTitle>
                  {status === "launching" ? "Launching Chrome for Testing…" : "No live view yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {status === "launching"
                    ? "Waiting for the app-owned Chromium to report its DevTools endpoint."
                    : "Launch the pane to watch the agent-driven browser here in real time."}
                </EmptyDescription>
              </EmptyHeader>
              {status !== "launching" && (
                <EmptyContent>
                  <Button type="button" onClick={() => void launch()}>
                    <PlayIcon />
                    Launch
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
