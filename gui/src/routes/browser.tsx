import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "@omp-gui/ui/components/button";
import { Input } from "@omp-gui/ui/components/input";
import { BrowserPane } from "@gui/components/BrowserPane";
import { RelayToggle } from "@gui/components/browser/relay-toggle";

export const Route = createFileRoute("/browser")({
  component: BrowserRoute,
});

function BrowserRoute() {
  // Placeholder for a real omp session id (issue #12's `sessionId`
  // parameter, T8's sessions store): this route predates session wiring,
  // so a stable per-mount id is the best available "which task" key.
  const sessionId = useId();
  const [projectPath, setProjectPath] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);

  return (
    <main className="mx-auto flex max-w-[64em] flex-col gap-4 py-8">
      <div className="typeset typeset-docs">
        <h1>omp-gui · Browser Pane</h1>
        <p>
          Launches an app-owned, per-project Chrome for Testing instance (ADR-0006) with a
          persistent profile and streams its live screencast here over a localhost endpoint — never
          through Tauri events (ADR-0007). omp's builtin browser tool attaches to the same Chromium
          via its <code>connected</code>-CDP path.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setActivePath(projectPath.trim() || null);
        }}
      >
        <label htmlFor="browser-pane-project-path" className="sr-only">
          Project path
        </label>
        <Input
          id="browser-pane-project-path"
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder="/path/to/project"
          className="flex-1"
        />
        <Button type="submit" disabled={!projectPath.trim()}>
          Open pane
        </Button>
      </form>

      {activePath && (
        <div className="flex flex-col gap-3">
          <RelayToggle key={activePath} sessionId={sessionId} />
          <BrowserPane key={activePath} projectPath={activePath} />
        </div>
      )}
    </main>
  );
}
