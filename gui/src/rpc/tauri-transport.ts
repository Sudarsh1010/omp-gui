/**
 * Tauri bridge transport: NDJSON lines ride Tauri commands/events; the Rust
 * core owns the subprocess pipes (ADR-0007).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RpcTransport } from "./session-core";

export interface OmpStartInfo {
  version: string;
  path: string;
  source: "override" | "devBinary" | "bundled";
}

function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: (() => void) | undefined;
  const pending = listen<T>(event, (e) => handler(e.payload)).then((off) => {
    unlisten = off;
  });
  return () => {
    void pending.then(() => unlisten?.());
  };
}

/** Spawn the pinned omp subprocess and return a transport over its pipes. */
export async function startOmp(): Promise<{ info: OmpStartInfo; transport: RpcTransport }> {
  const info = await invoke<OmpStartInfo>("omp_start");
  const transport: RpcTransport = {
    send: (line) => {
      void invoke("omp_send", { line });
    },
    onLine: (handler) => subscribe<string>("omp:frame", handler),
    onExit: (handler) => subscribe("omp:exit", handler),
  };
  return { info, transport };
}

export function killOmp(): Promise<void> {
  return invoke("omp_kill");
}
