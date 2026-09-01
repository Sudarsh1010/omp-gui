import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { OmpStartInfo } from "@omp-gui/ipc";
import { Button } from "@omp-gui/ui/components/button";
import { Spinner } from "@omp-gui/ui/components/spinner";
import { Alert, AlertTitle, AlertDescription } from "@omp-gui/ui/components/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@omp-gui/ui/components/card";

type Phase = "idle" | "starting" | "running" | "error";

interface RoundTrip {
  info: OmpStartInfo;
  ready: unknown;
  negotiated: number;
  canned: unknown;
}

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { ipc } = useRouteContext({ from: "__root__" });
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<RoundTrip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setPhase("starting");
    setResult(null);
    setError(null);
    try {
      const handle = await ipc.startSession();
      // Canned command: proves the full byte path spawn → pipe → parse → render.
      const canned = await handle.session.command({ type: "get_state" });
      setResult({
        info: handle.info,
        ready: handle.session.ready,
        negotiated: handle.session.protocolVersion,
        canned,
      });
      setPhase("running");
      await handle.close();
      setPhase("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [ipc]);

  useEffect(() => {
    void run();
  }, [run]);

  const starting = phase === "starting";

  return (
    <main className="mx-auto flex max-w-[48em] flex-col gap-4 py-8">
      <div className="typeset typeset-docs">
        <h1>omp-gui · T1 wire round-trip</h1>
        <p>
          Spawns the pinned <code>omp --mode rpc-ui</code> subprocess, parses the <code>ready</code>{" "}
          frame, negotiates the protocol version, and round-trips a canned <code>get_state</code>{" "}
          command.
        </p>
      </div>

      <Button type="button" onClick={() => void run()} disabled={starting} className="self-start">
        {starting && <Spinner />}
        {starting ? "Running…" : "Run round-trip"}
      </Button>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Round-trip failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>
              omp {result.info.version} <small>({result.info.source})</small>
            </CardTitle>
            <CardDescription>{result.info.path}</CardDescription>
          </CardHeader>
          <CardContent className="typeset typeset-docs">
            <h3>ready frame</h3>
            <pre>{JSON.stringify(result.ready, null, 2)}</pre>
            <h3>negotiated protocol version</h3>
            <pre>{result.negotiated}</pre>
            <h3>get_state response (raw)</h3>
            <pre>{JSON.stringify(result.canned, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
