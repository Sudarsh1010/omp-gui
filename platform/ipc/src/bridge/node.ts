/**
 * Node stdio transport: spawns an omp binary directly. Used by the seam tests
 * (and future smoke suites, ADR-0008) to drive the session core against the
 * real pinned binary — never imported by the app bundle.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { listAllSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { ShellBridge, OmpStartInfo } from "./shell-bridge";
import type {
  OmpFrameEvent,
  OmpExitEvent,
  SessionFileEntry,
  SessionPreview,
  SessionPreviewMessage,
} from "../bindings/bindings.gen";

/** Mirrors `crates/shell/src/sessions.rs`'s scan window constants exactly,
 * so the switcher's "view read-only" affordance behaves the same
 * regardless of which bridge backs the app. */
const PREVIEW_SCAN_BYTES = 262_144;
const PREVIEW_MAX_MESSAGES = 40;
const PREVIEW_MAX_TEXT_CHARS = 4000;

/**
 * `listAllSessions`'s own `SessionInfo` (`session-listing.ts`) carries far
 * more than the switcher needs (message counts, full transcript text,
 * derived lifecycle status) — down-mapped here to the same lightweight
 * `SessionFileEntry` shape `crates/shell/src/sessions.rs`'s independent,
 * Tauri-webview-side reimplementation produces, so `session-directory.ts`
 * never has to know which bridge it's talking to.
 */
function toSessionFileEntry(info: {
  path: string;
  id: string;
  cwd: string;
  title?: string;
  created: Date;
  modified: Date;
  size: number;
}): SessionFileEntry {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    title: info.title ?? null,
    createdAt: Number.isNaN(info.created.getTime()) ? null : info.created.toISOString(),
    modifiedAt: Math.floor(info.modified.getTime() / 1000),
    sizeBytes: info.size,
  };
}

/** Reads up to `maxBytes + 1` bytes from the start of `path`; `hitCap` is
 * true when the file is larger than `maxBytes` (a genuine prefix, not the
 * whole file) — mirrors `sessions.rs`'s `read_prefix` exactly. */
async function readPrefix(path: string, maxBytes: number): Promise<{ text: string; hitCap: boolean }> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const hitCap = bytesRead > maxBytes;
    return { text: buf.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"), hitCap };
  } finally {
    await handle.close();
  }
}

/** Narrows an unknown `content` array element to a `{type:"text",text}`
 * block using `in`-checked property access rather than a cast. */
function isTextContentBlock(block: unknown): block is { type: "text"; text: string } {
  if (typeof block !== "object" || block === null) return false;
  if (!("type" in block) || !("text" in block)) return false;
  return block.type === "text" && typeof block.text === "string";
}

/** Concatenates every `type:"text"` content block's text (thinking/
 * toolCall/image blocks skipped — a readable preview, not a faithful
 * replay); `content` may also be a bare string on older/simple messages. */
function extractPreviewText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("\n");
}

async function readSessionPreviewFromDisk(path: string): Promise<SessionPreview> {
  const { text: prefix, hitCap: hitByteCap } = await readPrefix(path, PREVIEW_SCAN_BYTES);
  const messages: SessionPreviewMessage[] = [];
  let hitMessageCap = false;

  for (const line of prefix.split("\n")) {
    if (messages.length >= PREVIEW_MAX_MESSAGES) {
      hitMessageCap = true;
      break;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const { message } = record;
    if (typeof message !== "object" || message === null) continue;
    if (!("role" in message) || !("content" in message)) continue;
    const { role, content } = message;
    if (typeof role !== "string" || (role !== "user" && role !== "assistant")) continue;
    const text = extractPreviewText(content);
    if (!text) continue;
    const clipped =
      text.length > PREVIEW_MAX_TEXT_CHARS ? `${text.slice(0, PREVIEW_MAX_TEXT_CHARS)}\u2026` : text;
    messages.push({ role, text: clipped });
  }

  return { path, messages, truncated: hitMessageCap || hitByteCap };
}

interface Session {
  child: ChildProcess;
  cleanup: () => void;
}

export function nodeBridge(binaryPath: string, cwd: string): ShellBridge {
  const sessions = new Map<string, Session>();
  const frameHandlers = new Set<(e: OmpFrameEvent) => void>();
  const exitHandlers = new Set<(e: OmpExitEvent) => void>();

  const emitFrame = (sessionId: string, line: string) => {
    const event: OmpFrameEvent = { sessionId, line };
    for (const handler of frameHandlers) handler(event);
  };

  const emitExit = (sessionId: string, code: number) => {
    const event: OmpExitEvent = { sessionId, code };
    for (const handler of exitHandlers) handler(event);
  };

  return {
    start(): Promise<OmpStartInfo> {
      const sessionId = randomUUID();
      const version = execFileSync(binaryPath, ["--version"], {
        encoding: "utf8",
      }).trim();
      const child = spawn(binaryPath, ["--mode", "rpc-ui"], {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
      });

      if (!child.stdin || !child.stdout) {
        throw new Error("failed to pipe omp stdio");
      }

      const reader = createInterface({ input: child.stdout });
      const onLine = (line: string) => emitFrame(sessionId, line);
      reader.on("line", onLine);

      const onExit = (code: number | null) => {
        emitExit(sessionId, code ?? 0);
        sessions.delete(sessionId);
      };
      child.on("exit", onExit);

      const cleanup = () => {
        reader.off("line", onLine);
        child.off("exit", onExit);
      };

      sessions.set(sessionId, { child, cleanup });

      return Promise.resolve({
        sessionId,
        version,
        path: binaryPath,
        source: "override",
      });
    },

    send(sessionId, line): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        return Promise.reject(new Error(`unknown session ${sessionId}`));
      }
      if (!session.child.stdin) {
        return Promise.reject(new Error(`stdin closed for session ${sessionId}`));
      }
      session.child.stdin.write(`${line}\n`);
      return Promise.resolve();
    },

    kill(sessionId): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        return Promise.reject(new Error(`unknown session ${sessionId}`));
      }
      session.cleanup();
      session.child.kill();
      sessions.delete(sessionId);
      // `cleanup()` just unsubscribed the child's own "exit" listener (so the
      // natural exit detected later doesn't double-fire this), which means
      // nothing else reports this exit unless it's emitted here explicitly —
      // mirrors `omp_kill`'s unconditional `OmpExitEvent{ code: -1 }.emit(&app)`
      // in `crates/shell/src/omp.rs`, keeping this bridge's `onExit` contract
      // consistent with the Tauri one for any caller that kills a session
      // without first calling `RpcSession.close()` (which itself already
      // detaches from the transport, so a `SessionsStore.closeSession()` ->
      // `IpcSessionHandle.close()` teardown never reaches this regardless —
      // see `session-directory.ts`'s module doc for why that path instead
      // watches `SessionsStore.list()`/status).
      emitExit(sessionId, -1);
      return Promise.resolve();
    },

    onFrame(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },

    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },

    async listSessionFiles(): Promise<SessionFileEntry[]> {
      const infos = await listAllSessions(new FileSessionStorage());
      return infos.map(toSessionFileEntry);
    },

    readSessionPreview: (path: string) => readSessionPreviewFromDisk(path),
  };
}
