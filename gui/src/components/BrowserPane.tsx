import { useCallback, useEffect, useRef, useState } from "react";
import { tauriBridge, type BrowserInfo, type ShellBridge } from "@omp-gui/ipc";
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
import { cn } from "@omp-gui/ui/lib/utils";
import {
  GlobeIcon,
  HandPalmIcon,
  HandPointingIcon,
  PlayIcon,
  StopIcon,
  WarningIcon,
} from "@phosphor-icons/react";

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
  /**
   * omp session ids currently attached to this project, whose browser-tool
   * approval prompts get auto-denied while this pane is in Takeover (see
   * `denyBrowserApprovalsWhileTakenOver`) — the concrete half of ADR-0006's
   * "user is driving ... suppressing agent input": CDP itself cannot tell
   * the agent's `Input.dispatch*` calls (via omp's own `connected`-kind CDP
   * client) apart from this pane's (notes/browser.md), so the only real
   * lever is stopping the agent's next browser action from ever being
   * approved. Optional: a pane with no attached session (e.g. this repo's
   * standalone `/browser` dev route) still takes over the Chromium's
   * input; there is just no agent traffic to hold back yet. Sub-wave 2B's
   * multi-session shell is the intended wiring point — pass the ids of
   * every session currently working in `projectPath`.
   */
  attachedSessionIds?: readonly string[];
}

/** The exact text omp's tool-approval gate renders for a pending browser
 * tool call. The pinned package's `formatApprovalPrompt` (`tools/
 * approval.ts`) always starts the prompt with `Allow tool: ${tool.name}`,
 * and the browser tool's `name` is literally `"browser"` — verified
 * directly against the pinned package's `tools/approval.ts` and
 * `extensibility/extensions/wrapper.ts` (see notes/browser.md §8). That
 * wrapper surfaces the prompt as an `extension_ui_request` with
 * `method: "select"` and `options: ["Approve", "Deny"]` — not a bare
 * `method: "confirm"` as an earlier research pass assumed; this matches the
 * pinned protocol source exactly. */
const BROWSER_TOOL_APPROVAL_PREFIX = "Allow tool: browser";

/** True (with the request's correlation id) for a raw omp stdout line that
 * is a pending browser-tool approval prompt. Exported for testability. */
export function isBrowserToolApprovalRequest(line: string): { id: string } | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object") return null;
  if (!("type" in frame) || !("method" in frame)) return null;
  if (frame.type !== "extension_ui_request" || frame.method !== "select") return null;
  if (!("id" in frame) || !("title" in frame) || !("options" in frame)) return null;
  if (typeof frame.id !== "string" || typeof frame.title !== "string" || !Array.isArray(frame.options)) {
    return null;
  }
  if (!frame.title.startsWith(BROWSER_TOOL_APPROVAL_PREFIX) || !frame.options.includes("Deny")) return null;
  return { id: frame.id };
}

/**
 * While Takeover is on, auto-deny the browser tool's approval prompt for
 * every attached session, so the agent's next browser action never lands
 * while a human is driving. This is the only real lever the app has: CDP
 * has no concept of "whose connection sent this `Input.dispatch*` call", so
 * the app cannot suppress the agent's own CDP client (its `connected`-kind
 * attach, entirely separate from this pane's) once a call is already in
 * flight — it can only stop the next one from ever being approved (see
 * `crates/shell/src/browser.rs`'s `browser_set_takeover` doc comment for
 * the other half of this design). Returns an unsubscribe function.
 */
export function denyBrowserApprovalsWhileTakenOver(
  bridge: ShellBridge,
  sessionIds: readonly string[],
  isTakenOver: () => boolean,
): () => void {
  if (sessionIds.length === 0) return () => {};
  const attached = new Set(sessionIds);
  return bridge.onFrame(({ sessionId, line }) => {
    if (!isTakenOver() || !attached.has(sessionId)) return;
    const pending = isBrowserToolApprovalRequest(line);
    if (!pending) return;
    void bridge
      .send(sessionId, JSON.stringify({ type: "extension_ui_response", id: pending.id, value: "Deny" }))
      .catch(() => {
        // Best-effort: a session that has already exited or stopped
        // listening has nothing left to suppress.
      });
  });
}

/** Parses one text message from the pane's frame WebSocket — today just the
 * Takeover state pushed by `crates/shell/src/browser.rs` on connect and on
 * every toggle (`PaneMessage::Takeover`). Returns `null` for anything else,
 * including malformed JSON. */
function parseTakeoverMessage(data: string): boolean | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || !("type" in message) || !("enabled" in message)) {
    return null;
  }
  if (message.type !== "takeover" || typeof message.enabled !== "boolean") return null;
  return message.enabled;
}

/** CDP's `Input.dispatch*` modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
function cdpModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
  );
}

/** CDP's `Input.dispatchMouseEvent` button names, keyed by the DOM
 * `MouseEvent.button` value that produced them; anything else (CDP's
 * `"none"`) covers pointer moves with no button held. */
const CDP_MOUSE_BUTTONS: Record<number, "left" | "middle" | "right"> = {
  0: "left",
  1: "middle",
  2: "right",
};

/**
 * Maps a pointer event's viewport position into the screencast frame's own
 * pixel space — the coordinate space `Input.dispatchMouseEvent` expects.
 * The pane renders the frame with `object-contain` inside a fixed-aspect
 * box, so a frame whose aspect ratio differs from the box (Chrome's actual
 * 1280x800 window vs. this pane's 16:9 `aspect-video` wrapper) is
 * letterboxed; this accounts for that scale + offset, and returns `null`
 * for a point that falls in the letterbox gutter rather than the frame
 * itself.
 *
 * Assumes frame pixels equal viewport CSS pixels 1:1 — true only because
 * `run_cdp_pump`'s `Page.startScreencast` `maxWidth`/`maxHeight` are
 * hardcoded to exactly match `browser_launch`'s `--window-size`. If either
 * changes independent of the other, this needs the frame's own CDP
 * metadata (`pageScaleFactor`/`offsetTop`) instead of a bare
 * naturalWidth/Height ratio.
 */
function paneCoordinates(
  event: { clientX: number; clientY: number },
  img: HTMLImageElement,
): { x: number; y: number } | null {
  const { naturalWidth, naturalHeight } = img;
  if (!naturalWidth || !naturalHeight) return null;
  const rect = img.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const renderedWidth = naturalWidth * scale;
  const renderedHeight = naturalHeight * scale;
  const offsetX = rect.left + (rect.width - renderedWidth) / 2;
  const offsetY = rect.top + (rect.height - renderedHeight) / 2;
  const x = (event.clientX - offsetX) / scale;
  const y = (event.clientY - offsetY) / scale;
  if (x < 0 || y < 0 || x > naturalWidth || y > naturalHeight) return null;
  return { x, y };
}

/** Sends one already-shaped CDP Input params object up the pane's own
 * WebSocket (frames down, input up — see `parse_pane_input` in
 * `crates/shell/src/browser.rs`). Silently drops it if the socket is not
 * currently open; there is no queueing for a pane that has yet to connect. */
function sendPaneInput(ws: WebSocket | null, method: string, params: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ method, params }));
}

/**
 * The app's live view of the agent-driven, app-owned Chromium (ADR-0006):
 * launches (or attaches to) a per-project Chrome for Testing instance and
 * renders its screencast, streamed over the pane's own localhost WebSocket
 * endpoint — never through Tauri events (ADR-0007). The same socket carries
 * Takeover input upstream: while driving, this pane captures mouse/keyboard
 * input and forwards it as `Input.dispatchMouseEvent`/`dispatchKeyEvent`
 * calls the Rust CDP pump dispatches into the live page.
 */
export function BrowserPane({ projectPath, attachedSessionIds = [] }: BrowserPaneProps) {
  const [status, setStatus] = useState<PaneStatus>("idle");
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [takeoverPending, setTakeoverPending] = useState(false);
  const frameUrlRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const takeoverRef = useRef(false);
  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  const paneImgRef = useRef<HTMLImageElement | null>(null);

  const launch = useCallback(async () => {
    setStatus("launching");
    setError(null);
    try {
      const launched = await browserBridge.browserLaunch(projectPath);
      setInfo(launched);
      setTakeover(launched.takeover);
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
    setTakeover(false);
    await browserBridge.browserStop(current.projectPath).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    });
  }, [info]);

  const toggleTakeover = useCallback(async () => {
    if (!info) return;
    setTakeoverPending(true);
    setError(null);
    try {
      await browserBridge.browserSetTakeover(info.projectPath, !takeover);
      // The confirmed state arrives back over the pane WebSocket's
      // `{"type":"takeover"}` push (`serve_frame_client` in
      // `crates/shell/src/browser.rs`) — the single source of truth shared
      // by every pane open on this project — rather than an optimistic
      // local update here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTakeoverPending(false);
    }
  }, [info, takeover]);

  useEffect(() => {
    takeoverRef.current = takeover;
  }, [takeover]);

  // Suppress agent-driven browser use for every attached session while this
  // pane is in Takeover (ADR-0006). Keyed on the joined id list (not the
  // array reference) so callers don't need to memoize `attachedSessionIds`
  // for this subscription to stay stable across renders.
  const attachedSessionsKey = attachedSessionIds.join(",");
  useEffect(
    () => denyBrowserApprovalsWhileTakenOver(browserBridge, attachedSessionIds, () => takeoverRef.current),
    [attachedSessionsKey],
  );

  // The frame subscription is purely a *view* concern: closing it (on
  // unmount, or when `info` changes) never stops the Chromium itself — only
  // an explicit Stop does, since the pane may outlive any one viewer
  // (ADR-0006's persistent-per-project browser is meant to survive that).
  useEffect(() => {
    if (!info) return;
    const ws = new WebSocket(info.frameEndpoint);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const url = URL.createObjectURL(new Blob([event.data], { type: "image/jpeg" }));
        if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = url;
        setFrameUrl(url);
        return;
      }
      if (typeof event.data === "string") {
        const enabled = parseTakeoverMessage(event.data);
        if (enabled !== null) setTakeover(enabled);
      }
    };
    ws.onerror = () => {
      // The pane's *view* lost its connection to the frame endpoint — the
      // Chromium itself is untouched, so status stays "live" (Stop remains
      // correct) rather than implying the browser stopped.
      setError("lost connection to the pane frame endpoint; the browser is still running");
    };
    return () => {
      wsRef.current = null;
      ws.close();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
      setFrameUrl(null);
    };
  }, [info]);

  // Captures pane input and forwards it upstream over the same WebSocket
  // while Takeover is on. Depends on `hasFrame` (not `frameUrl` itself,
  // which changes on every incoming JPEG) so listeners attach the moment a
  // frame — and so `paneImgRef`'s element — actually exists, including when
  // Takeover is switched on before the very first frame arrives.
  const hasFrame = frameUrl !== null;
  useEffect(() => {
    const container = paneContainerRef.current;
    const img = paneImgRef.current;
    if (!takeover || !container || !img) return;

    const dispatchMouse = (event: MouseEvent, type: string, extra?: Record<string, unknown>) => {
      const point = paneCoordinates(event, img);
      if (!point) return;
      event.preventDefault();
      sendPaneInput(wsRef.current, "Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: CDP_MOUSE_BUTTONS[event.button] ?? "none",
        buttons: event.buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
        modifiers: cdpModifiers(event),
        ...extra,
      });
    };

    // Coalesce mousemove to one dispatch per animation frame: raw
    // `mousemove` fires far faster than a CDP round trip is worth paying
    // for, and only the latest position before each paint matters.
    let pendingMove: MouseEvent | null = null;
    let moveHandle: number | null = null;
    const flushMove = () => {
      moveHandle = null;
      if (pendingMove) dispatchMouse(pendingMove, "mouseMoved");
      pendingMove = null;
    };
    const onMouseMove = (event: MouseEvent) => {
      pendingMove = event;
      moveHandle ??= requestAnimationFrame(flushMove);
    };
    const onMouseDown = (event: MouseEvent) => {
      container.focus();
      dispatchMouse(event, "mousePressed");
    };
    const onMouseUp = (event: MouseEvent) => dispatchMouse(event, "mouseReleased");
    const onWheel = (event: WheelEvent) => {
      const point = paneCoordinates(event, img);
      if (!point) return;
      event.preventDefault();
      sendPaneInput(wsRef.current, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: cdpModifiers(event),
      });
    };
    const onContextMenu = (event: Event) => event.preventDefault();
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      const printable = event.key.length === 1;
      sendPaneInput(wsRef.current, "Input.dispatchKeyEvent", {
        type: printable ? "keyDown" : "rawKeyDown",
        key: event.key,
        code: event.code,
        text: printable ? event.key : undefined,
        unmodifiedText: printable ? event.key : undefined,
        modifiers: cdpModifiers(event),
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
        autoRepeat: event.repeat,
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      sendPaneInput(wsRef.current, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: event.key,
        code: event.code,
        modifiers: cdpModifiers(event),
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
      });
    };

    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("keyup", onKeyUp);
    container.focus();

    return () => {
      if (moveHandle !== null) cancelAnimationFrame(moveHandle);
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("keyup", onKeyUp);
    };
  }, [takeover, hasFrame]);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b border-border py-3">
        <CardTitle className="flex items-center gap-1.5">
          <GlobeIcon />
          Browser Pane
          {status === "live" && <Badge variant="secondary">live</Badge>}
          {takeover && (
            <Badge variant="destructive">
              <HandPointingIcon weight="fill" />
              You are driving
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{projectPath}</CardDescription>
        <CardAction className="flex items-center gap-1.5">
          {status === "live" && (
            <Button
              type="button"
              variant={takeover ? "destructive" : "outline"}
              size="sm"
              disabled={takeoverPending}
              onClick={() => void toggleTakeover()}
            >
              {takeoverPending ? <Spinner /> : takeover ? <HandPalmIcon /> : <HandPointingIcon />}
              {takeover ? "Release" : "Take over"}
            </Button>
          )}
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

        <div
          ref={paneContainerRef}
          tabIndex={takeover ? 0 : -1}
          className={cn(
            "relative flex aspect-video w-full items-center justify-center overflow-hidden bg-black outline-none",
            takeover && "cursor-crosshair ring-2 ring-inset ring-destructive",
          )}
        >
          {takeover && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-1.5 border-b border-destructive bg-card/90 py-1 text-xs font-medium text-destructive">
              <HandPointingIcon weight="fill" />
              You are driving — this denies the agent's next browser approval; under
              auto-approve, its current turn may not be interrupted
            </div>
          )}
          {frameUrl ? (
            // The live screencast: a plain <img> fed by successive object
            // URLs from the frame WebSocket (see the effect above) — the
            // MJPEG-over-WebSocket approach ADR-0007's frame endpoint is
            // built for.
            <img
              ref={paneImgRef}
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
