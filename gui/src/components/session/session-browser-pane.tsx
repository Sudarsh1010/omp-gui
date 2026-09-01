import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { BrowserPane } from "@gui/components/BrowserPane";
import { RelayToggle } from "@gui/components/browser/relay-toggle";

export interface SessionBrowserPaneProps {
  sessionId: string;
}

/**
 * Per-session Browser Pane surface (T9/T10/T11, issue #1 story 18): mounts
 * the app-owned Chromium pane, its Takeover controls, and the relay toggle
 * for ONE real dispatcher-shell session, wired with its actual session id
 * (not a placeholder) so `BrowserPane`'s
 * `denyBrowserApprovalsWhileTakenOver` genuinely suppresses that session's
 * next agent browser-tool call while a human is driving.
 *
 * `SessionsStore` (T8) has no per-session project/cwd concept yet — every
 * omp subprocess spawns with `cwd` = the user's home directory
 * (`crates/shell/src/omp.rs`'s `omp_start`). Until a real per-session
 * project picker exists, this pane mirrors that exact default (resolved
 * via Tauri's own `path` API, already covered by this app's `core:default`
 * capability — no new backend command needed) rather than inventing an
 * unrelated one, so the Browser Pane and the session's own omp process
 * agree on "the project".
 */
export function SessionBrowserPane({ sessionId }: SessionBrowserPaneProps) {
  const [projectPath, setProjectPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void homeDir().then((dir) => {
      if (!cancelled) setProjectPath(dir);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (projectPath === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner />
        Resolving project directory…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <RelayToggle sessionId={sessionId} />
      <BrowserPane projectPath={projectPath} attachedSessionIds={[sessionId]} />
    </div>
  );
}
