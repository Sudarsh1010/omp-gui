import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Transcript, type RpcSession, type TranscriptSnapshot } from "@omp-gui/ipc";

const EMPTY_SNAPSHOT: TranscriptSnapshot = { entries: [], running: false, aborting: false };

/**
 * Bridges the framework-agnostic `Transcript` core into React via
 * `useSyncExternalStore`. Construction/disposal lives in an effect (not
 * `useMemo`): `Transcript`'s constructor subscribes to the session as a side
 * effect, and only `useEffect`'s mount/cleanup/mount contract (not memo's)
 * guarantees that side effect is torn down before a replacement is created —
 * load-bearing under StrictMode's double-invoke.
 */
export function useTranscript(session: RpcSession | undefined): {
  snapshot: TranscriptSnapshot;
  sendPrompt: (text: string) => void;
  abort: () => void;
} {
  const [transcript, setTranscript] = useState<Transcript | null>(null);

  useEffect(() => {
    if (!session) {
      setTranscript(null);
      return;
    }
    const instance = new Transcript(session);
    setTranscript(instance);
    return () => {
      instance.dispose();
    };
  }, [session]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => (transcript ? transcript.subscribe(onStoreChange) : () => {}),
    [transcript],
  );
  const getSnapshot = useCallback(
    () => (transcript ? transcript.getSnapshot() : EMPTY_SNAPSHOT),
    [transcript],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const sendPrompt = useCallback(
    (text: string) => {
      void transcript?.sendPrompt(text);
    },
    [transcript],
  );
  const abort = useCallback(() => {
    void transcript?.abort();
  }, [transcript]);

  return { snapshot, sendPrompt, abort };
}
