/**
 * rpc-ui session core: framing, protocol-version negotiation, and
 * command/response correlation over one NDJSON line channel (ADR-0001, ADR-0007).
 *
 * Wire types are imported from the pinned omp package (ADR-0004) so the
 * TypeScript compiler is the wire-compat checker on every pin bump. The v2
 * chunk reassembler is reimplemented here rather than imported because omp's
 * `RpcFrameDecoder` depends on Node builtins (`node:util`, `Buffer`) that do
 * not exist in the Tauri webview.
 *
 * The core is transport-agnostic: the UI drives it through the Tauri bridge,
 * tests drive it against the real pinned binary over stdio — the pre-agreed
 * seam from the v1 spec.
 */
import type {
  RpcChunkFrame,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcReadyFrame,
  RpcResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

/** One line-oriented NDJSON channel to an `omp --mode rpc-ui` subprocess. */
export interface RpcTransport {
  /** Write one NDJSON line to the subprocess's stdin. */
  send(line: string): void;
  /** Subscribe to raw NDJSON stdout lines. Returns an unsubscribe function. */
  onLine(handler: (line: string) => void): () => void;
  /** Subscribe to subprocess exit. Returns an unsubscribe function. */
  onExit(handler: () => void): () => void;
}

const READY_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

export class RpcProtocolError extends Error {}

export class RpcCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type RpcEventFrame = Record<string, unknown> & { type: string };

export interface RpcSessionOptions {
  /** Called for every non-response frame (session events, side channels). */
  onEvent?: (frame: RpcEventFrame) => void;
  /** Called when the subprocess exits; all pending commands reject. */
  onExit?: () => void;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Reassembles protocol-v2 `rpc_chunk` sequences per docs/rpc.md: validates
 * chunkId/index/count/byteLength, rejects interleaved sequences, enforces the
 * advertised reassembly ceiling, and decodes strict UTF-8.
 */
class ChunkReassembler {
  private pending: {
    chunkId: string;
    count: number;
    byteLength: number;
    chunks: Uint8Array[];
    receivedBytes: number;
  } | null = null;

  constructor(private readonly maxBytes: number) {}

  /** Returns the reassembled JSON text once the sequence completes. */
  push(chunk: RpcChunkFrame): string {
    const bytes = decodeBase64(chunk.data);
    if (chunk.index === 0) {
      if (this.pending) {
        throw new RpcProtocolError(
          `rpc_chunk sequence ${this.pending.chunkId} interrupted by ${chunk.chunkId}`,
        );
      }
      if (chunk.count <= 0) throw new RpcProtocolError(`rpc_chunk with count ${chunk.count}`);
      this.pending = {
        chunkId: chunk.chunkId,
        count: chunk.count,
        byteLength: chunk.byteLength,
        chunks: [],
        receivedBytes: 0,
      };
    }

    const pending = this.pending;
    if (!pending || chunk.chunkId !== pending.chunkId) {
      throw new RpcProtocolError(`interleaved rpc_chunk ${chunk.chunkId}`);
    }
    if (chunk.count !== pending.count || chunk.byteLength !== pending.byteLength) {
      throw new RpcProtocolError(`rpc_chunk ${chunk.chunkId} changed shape mid-sequence`);
    }
    if (chunk.index !== pending.chunks.length) {
      throw new RpcProtocolError(
        `rpc_chunk ${chunk.chunkId} out of order: expected index ${pending.chunks.length}, got ${chunk.index}`,
      );
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes > this.maxBytes || pending.receivedBytes > pending.byteLength) {
      throw new RpcProtocolError(`rpc_chunk ${chunk.chunkId} exceeds the reassembly limit`);
    }
    if (pending.chunks.length < pending.count) return "";

    if (pending.receivedBytes !== pending.byteLength) {
      throw new RpcProtocolError(
        `rpc_chunk ${chunk.chunkId} reassembled to ${pending.receivedBytes} bytes, expected ${pending.byteLength}`,
      );
    }
    const assembled = new Uint8Array(pending.receivedBytes);
    let offset = 0;
    for (const part of pending.chunks) {
      assembled.set(part, offset);
      offset += part.byteLength;
    }
    this.pending = null;
    return new TextDecoder("utf-8", { fatal: true }).decode(assembled);
  }
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class RpcSession {
  private nextCommandId = 0;
  private protocol = 1;
  private reassembler: ChunkReassembler | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  private readonly eventListeners = new Set<(frame: RpcEventFrame) => void>();
  private readonly exitListeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  private constructor(
    private readonly transport: RpcTransport,
    readonly ready: RpcReadyFrame,
    private readonly options: RpcSessionOptions,
  ) {
    if (options.onEvent) this.eventListeners.add(options.onEvent);
    if (options.onExit) this.exitListeners.add(options.onExit);
    const offLine = transport.onLine((line) => this.handleLine(line));
    const offExit = transport.onExit(() => this.handleExit());
    this.unsubscribe = () => {
      offLine();
      offExit();
    };
  }

  /** The negotiated protocol version (1, or 2 after a successful negotiation). */
  get protocolVersion(): number {
    return this.protocol;
  }

  /**
   * Subscribe to every non-response frame (session events, side channels).
   * Multiple listeners may be registered; the constructor's `options.onEvent`
   * (if provided) is registered as one of them. Returns an unsubscribe function.
   */
  onEvent(handler: (frame: RpcEventFrame) => void): () => void {
    this.eventListeners.add(handler);
    return () => {
      this.eventListeners.delete(handler);
    };
  }

  /** Subscribe to subprocess exit. Returns an unsubscribe function. */
  onExit(handler: () => void): () => void {
    this.exitListeners.add(handler);
    return () => {
      this.exitListeners.delete(handler);
    };
  }

  /**
   * Wait for the `ready` frame, then negotiate protocol v2 (chunked transport)
   * when the server advertises it, per docs/rpc.md. Servers advertising v1
   * only are used as-is: explicit negotiation *to* v1 is rejected by omp.
   */
  static async start(
    transport: RpcTransport,
    options: RpcSessionOptions = {},
  ): Promise<RpcSession> {
    const {
      promise: readyPromise,
      resolve: resolveReady,
      reject: rejectReady,
    } = Promise.withResolvers<RpcReadyFrame>();

    let offLine = () => {};
    let offExit = () => {};
    offLine = transport.onLine((line) => {
      const frame = parseFrame(line);
      if (frame?.type === "ready") {
        resolveReady(frame as unknown as RpcReadyFrame);
      } else if (!frame) {
        options.onEvent?.({ type: "malformed_frame", line });
      }
    });
    offExit = transport.onExit(() => {
      rejectReady(new RpcProtocolError("omp exited before sending the ready frame"));
    });

    const timer = setTimeout(
      () => rejectReady(new RpcProtocolError("timed out waiting for the omp ready frame")),
      options.readyTimeoutMs ?? READY_TIMEOUT_MS,
    );

    let ready: RpcReadyFrame;
    try {
      ready = await readyPromise;
    } finally {
      clearTimeout(timer);
      offLine();
      offExit();
    }

    const session = new RpcSession(transport, ready, options);
    if (ready.supportedProtocolVersions.includes(2)) {
      await session.command({ type: "negotiate_protocol", protocolVersion: 2 });
      session.protocol = 2;
      session.reassembler = new ChunkReassembler(ready.maxReassembledFrameBytes);
    } else if (!ready.supportedProtocolVersions.includes(1)) {
      session.close();
      throw new RpcProtocolError(
        `omp supports protocol versions [${ready.supportedProtocolVersions.join(", ")}], this app requires 1 or 2`,
      );
    }
    return session;
  }

  /** Send a command and await its correlated response. */
  async command<C extends RpcCommand>(
    cmd: C,
  ): Promise<Extract<RpcResponse, { command: C["type"] }>> {
    const id = cmd.id ?? `cmd-${++this.nextCommandId}`;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();

    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new RpcProtocolError(`timed out waiting for response to ${cmd.type}`));
    }, this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);

    this.pending.set(id, { resolve, reject });
    this.transport.send(JSON.stringify({ ...cmd, id }));

    try {
      const response = await promise;
      if (!response.success) {
        throw new RpcCommandError(response.error, response.code);
      }
      return response as Extract<RpcResponse, { command: C["type"] }>;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Answer a pending `extension_ui_request` by sending the correlated
   * `extension_ui_response`. Unlike `command()`, this never waits for a
   * `type: "response"` frame — the server has none to send for it; it
   * resolves the request's own internal pending-dialog map and resumes
   * the turn directly (protocol.md §5.4 "side-channel frames always
   * overtake the queue").
   */
  respondToExtensionUi(response: RpcExtensionUIResponse): void {
    this.transport.send(JSON.stringify(response));
  }

  /** Stop listening; does not kill the subprocess (transport owner's job). */
  close(): void {
    this.unsubscribe();
  }

  private handleLine(line: string): void {
    const frame = parseFrame(line);
    if (!frame) {
      this.emitEvent({ type: "malformed_frame", line });
      return;
    }
    if (frame.type === "rpc_chunk" && this.reassembler) {
      try {
        const assembled = this.reassembler.push(frame as unknown as RpcChunkFrame);
        if (assembled) this.handleLine(assembled);
      } catch (error) {
        this.emitEvent({
          type: "protocol_error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        pending.resolve(frame as unknown as RpcResponse);
        return;
      }
    }
    this.emitEvent(frame as RpcEventFrame);
  }

  private handleExit(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new RpcProtocolError("omp process exited"));
    }
    this.pending.clear();
    for (const listener of this.exitListeners) listener();
  }

  private emitEvent(frame: RpcEventFrame): void {
    for (const listener of this.eventListeners) listener(frame);
  }
}

function parseFrame(line: string): Record<string, unknown> | null {
  try {
    const frame: unknown = JSON.parse(line);
    if (typeof frame === "object" && frame !== null && "type" in frame) {
      return frame as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}
