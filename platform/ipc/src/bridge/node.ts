/**
 * Node stdio transport: spawns an omp binary directly. Used by the seam tests
 * (and future smoke suites, ADR-0008) to drive the session core against the
 * real pinned binary — never imported by the app bundle.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { open, readdir, stat, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ShellBridge, OmpStartInfo } from "./shell-bridge";
import type {
  OmpFrameEvent,
  OmpExitEvent,
  SessionFileEntry,
  SessionPreview,
  SessionPreviewMessage,
  AppPreferences,
} from "../bindings/bindings.gen";

/** Mirrors `crates/shell/src/sessions.rs`'s scan window constants exactly,
 * so the switcher's "view read-only" affordance behaves the same
 * regardless of which bridge backs the app. */
const PREVIEW_SCAN_BYTES = 262_144;
const PREVIEW_MAX_MESSAGES = 40;
const PREVIEW_MAX_TEXT_CHARS = 4000;
/** `.jsonl` only — matches `sessions.rs`'s `SESSION_SUFFIX` (GC-compressed
 * `.jsonl.gz` archives and `.bak` backups are excluded). */
const SESSION_SUFFIX = ".jsonl";
/** Header-scan window, matching `sessions.rs`'s `HEADER_SCAN_BYTES`. */
const HEADER_SCAN_BYTES = 4096;

/**
 * The sessions root a spawned `omp` subprocess would itself resolve to,
 * mirroring `sessions.rs`'s `sessions_root` (and `@oh-my-pi/pi-utils`'s
 * `dirs.ts` default): `PI_CODING_AGENT_DIR` wins outright if non-empty,
 * else `$HOME/<PI_CONFIG_DIR or .omp>/agent/sessions`.
 */
function sessionsRoot(): string {
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) return join(explicit, "sessions");
  const configDir = process.env.PI_CONFIG_DIR?.trim() || ".omp";
  return join(homedir(), configDir, "agent", "sessions");
}

/** Mirrors `crates/shell/src/preferences.rs`'s `PREFERENCES_VERSION`. */
const PREFERENCES_VERSION = 1;

/** Mirrors `crates/shell/src/preferences.rs`'s `AppPreferences::default()`. */
const DEFAULT_APP_PREFERENCES: AppPreferences = {
  theme: "system",
  ompPath: null,
  chromiumPath: null,
  defaultWorkingDirectory: null,
};

/**
 * Pure read of the preferences file at `path`, mirroring
 * `preferences.rs`'s `read_file`: a missing file, unparseable JSON, or JSON
 * that isn't an object all yield the defaults. Never writes, so a corrupt
 * file is left exactly as found.
 */
async function readPreferencesFile(path: string): Promise<AppPreferences> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ...DEFAULT_APP_PREFERENCES };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_APP_PREFERENCES };
    }
    const value = parsed as Record<string, unknown>;
    return {
      theme: value.theme === "light" || value.theme === "dark" ? value.theme : "system",
      ompPath: typeof value.ompPath === "string" ? value.ompPath : null,
      chromiumPath: typeof value.chromiumPath === "string" ? value.chromiumPath : null,
      defaultWorkingDirectory:
        typeof value.defaultWorkingDirectory === "string" ? value.defaultWorkingDirectory : null,
    };
  } catch {
    return { ...DEFAULT_APP_PREFERENCES };
  }
}

/**
 * Overlays `prefs`' known fields (plus `version`) onto whatever JSON object
 * already exists on disk at `path`, so unknown keys survive, and writes
 * atomically (tmp file + rename) — mirroring `preferences.rs`'s
 * `write_file`, so the seam test drives the same on-disk contract the Rust
 * shell implements.
 */
async function writePreferencesFile(path: string, prefs: AppPreferences): Promise<AppPreferences> {
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unparseable — start from an empty object, same as the Rust side.
  }

  root = {
    ...root,
    theme: prefs.theme ?? "system",
    ompPath: prefs.ompPath ?? null,
    chromiumPath: prefs.chromiumPath ?? null,
    defaultWorkingDirectory: prefs.defaultWorkingDirectory ?? null,
    version: PREFERENCES_VERSION,
  };

  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(root, null, 2));
  await rename(tmpPath, path);

  return readPreferencesFile(path);
}

interface SessionHeader {
  id: string | null;
  cwd: string | null;
  title: string | null;
  createdAt: string | null;
}

/** Parses a bounded prefix for its `title` override record and `session`
 * header record, mirroring `sessions.rs`'s `parse_session_header`: line 1 is
 * typically a `{"type":"title",...}` cache entry, line 2 the
 * `{"type":"session",...}` header. Scanned defensively across all lines. */
function parseSessionHeader(prefix: string): SessionHeader {
  let id: string | null = null;
  let cwd: string | null = null;
  let sessionTitle: string | null = null;
  let titleOverride: string | null = null;
  let createdAt: string | null = null;
  for (const line of prefix.split("\n")) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "title") {
      if (typeof value.title === "string") titleOverride = value.title;
    } else if (value.type === "session") {
      id = typeof value.id === "string" ? value.id : null;
      cwd = typeof value.cwd === "string" ? value.cwd : null;
      sessionTitle = typeof value.title === "string" ? value.title : null;
      createdAt = typeof value.timestamp === "string" ? value.timestamp : null;
    }
  }
  return { id, cwd, title: titleOverride ?? sessionTitle, createdAt };
}

/** Falls back to the id embedded in a `<timestamp>_<uuid>.jsonl` filename
 * (mirrors `sessions.rs`'s `session_id_from_filename`) when a file's header
 * can't be read or parsed. */
function sessionIdFromFilename(fileName: string): string {
  const stem = fileName.endsWith(SESSION_SUFFIX)
    ? fileName.slice(0, -SESSION_SUFFIX.length)
    : fileName;
  const underscore = stem.lastIndexOf("_");
  const tail = underscore >= 0 ? stem.slice(underscore + 1) : "";
  return tail || stem;
}

/** Builds one `SessionFileEntry` from disk, mirroring `sessions.rs`'s
 * `read_session_entry` (mtime as Unix **seconds**, size clamped to u32,
 * header `timestamp` relayed verbatim). Returns null if the file can't be
 * stat'd, so a single unreadable file never fails the whole scan. */
async function readSessionEntryFromDisk(
  path: string,
  fileName: string,
): Promise<SessionFileEntry | null> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return null;
  const { text: prefix } = await readPrefix(path, HEADER_SCAN_BYTES);
  const header = parseSessionHeader(prefix);
  return {
    path,
    id: header.id ?? sessionIdFromFilename(fileName),
    cwd: header.cwd ?? "",
    title: header.title,
    createdAt: header.createdAt,
    modifiedAt: Math.floor(stats.mtimeMs / 1000),
    sizeBytes: Math.min(stats.size, 0xffffffff),
  };
}

/** Reads up to `maxBytes + 1` bytes from the start of `path`; `hitCap` is
 * true when the file is larger than `maxBytes` (a genuine prefix, not the
 * whole file) — mirrors `sessions.rs`'s `read_prefix` exactly. */
async function readPrefix(
  path: string,
  maxBytes: number,
): Promise<{ text: string; hitCap: boolean }> {
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
      text.length > PREVIEW_MAX_TEXT_CHARS
        ? `${text.slice(0, PREVIEW_MAX_TEXT_CHARS)}\u2026`
        : text;
    messages.push({ role, text: clipped });
  }

  return { path, messages, truncated: hitMessageCap || hitByteCap };
}

interface Session {
  child: ChildProcess;
  cleanup: () => void;
}

/** Constructor options `nodeBridge` accepts beyond the binary path and
 * default cwd. `preferencesPath` is the file the App Preferences seam test
 * (and controller test) point at — a bridge built without it simply has no
 * `preferencesRead`/`preferencesWrite` methods (both optional on
 * `ShellBridge`), and `start()` never consults a `defaultWorkingDirectory`
 * preference either (#22). `agentDir`, when set, becomes `PI_CODING_AGENT_DIR`
 * for every process this bridge spawns, so each seam test gets its own
 * hermetic agent dir instead of sharing (or leaking into) the real
 * `~/.omp` — additive: omitted, spawned processes simply inherit
 * `process.env` unchanged. */
export interface NodeBridgeOptions {
  preferencesPath?: string;
  agentDir?: string;
}

/**
 * Mirrors `crates/shell/src/omp.rs`'s `resolve_start_cwd` precedence
 * exactly (#22), so `nodeBridge.start()` behaves like the real Tauri
 * shell's `omp_start`: an explicit `requested` directory (a resume's
 * recorded cwd) always wins when it exists; otherwise the App Preferences
 * `defaultWorkingDirectory` wins when it names an existing directory (only
 * checked when this bridge was built with a `preferencesPath`); otherwise
 * the constructor's own `fallbackCwd`.
 */
async function resolveStartCwd(
  requested: string | undefined,
  fallbackCwd: string,
  preferencesPath: string | undefined,
): Promise<string> {
  const trimmedRequested = requested?.trim();
  if (trimmedRequested && (await isExistingDirectory(trimmedRequested))) {
    return trimmedRequested;
  }
  if (preferencesPath) {
    const prefs = await readPreferencesFile(preferencesPath);
    const preferred = prefs.defaultWorkingDirectory?.trim();
    if (preferred && (await isExistingDirectory(preferred))) {
      return preferred;
    }
  }
  return fallbackCwd;
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export function nodeBridge(binaryPath: string, cwd: string, options: NodeBridgeOptions = {}): ShellBridge {
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

  const { preferencesPath, agentDir } = options;
  const spawnEnv = agentDir ? { ...process.env, PI_CODING_AGENT_DIR: agentDir } : process.env;

  return {
    async start(cwdOverride?: string): Promise<OmpStartInfo> {
      const sessionId = randomUUID();
      const resolvedCwd = await resolveStartCwd(cwdOverride, cwd, preferencesPath);
      const version = execFileSync(binaryPath, ["--version"], {
        encoding: "utf8",
        env: spawnEnv,
      }).trim();
      const child = spawn(binaryPath, ["--mode", "rpc-ui"], {
        cwd: resolvedCwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv,
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
      // Mirrors `sessions.rs`'s `list_session_files`: walk root/<project>/*.jsonl,
      // a bounded header read per file, newest-first; a missing root yields [].
      const root = sessionsRoot();
      const projectDirs = await readdir(root, { withFileTypes: true }).catch(() => null);
      if (!projectDirs) return [];
      const out: SessionFileEntry[] = [];
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = join(root, projectDir.name);
        const files = await readdir(projectPath).catch(() => null);
        if (!files) continue;
        for (const fileName of files) {
          if (!fileName.endsWith(SESSION_SUFFIX)) continue;
          const entry = await readSessionEntryFromDisk(join(projectPath, fileName), fileName);
          if (entry) out.push(entry);
        }
      }
      out.sort((a, b) => b.modifiedAt - a.modifiedAt);
      return out;
    },

    readSessionPreview: (path: string) => readSessionPreviewFromDisk(path),

    ...(preferencesPath
      ? {
          preferencesRead: () => readPreferencesFile(preferencesPath),
          preferencesWrite: (prefs: AppPreferences) => writePreferencesFile(preferencesPath, prefs),
        }
      : {}),
  };
}
