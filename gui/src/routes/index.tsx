import { createFileRoute, useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { OmpStartInfo } from "@omp-gui/ipc";

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

  return (
    <main className="mx-auto py-8 typeset typeset-docs max-w-[48em]">
      <h1>omp-gui · T1 wire round-trip</h1>
      <p>
        Spawns the pinned <code>omp --mode rpc-ui</code> subprocess, parses the <code>ready</code>{" "}
        frame, negotiates the protocol version, and round-trips a canned <code>get_state</code>{" "}
        command.
      </p>
      <button type="button" onClick={() => void run()} disabled={phase === "starting"}>
        {phase === "starting" ? "Running…" : "Run round-trip"}
      </button>

      {error && <p>{error}</p>}

      {result && (
        <section>
          <h2>
            omp {result.info.version} <small>({result.info.source})</small>
          </h2>
          <p>{result.info.path}</p>
          <h3>ready frame</h3>
          <pre>{JSON.stringify(result.ready, null, 2)}</pre>
          <h3>negotiated protocol version</h3>
          <pre>{result.negotiated}</pre>
          <h3>get_state response (raw)</h3>
          <pre>{JSON.stringify(result.canned, null, 2)}</pre>
        </section>
      )}
    </main>
  );
}
