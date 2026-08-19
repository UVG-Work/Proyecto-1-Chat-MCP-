/**
 * Transport abstraction.
 *
 * MCP is transport-agnostic: the same JSON-RPC message exchange runs over stdio
 * for local servers and over Streamable HTTP for remote ones. Putting both
 * behind one interface is what lets the custom NOC server move from a local
 * subprocess to a cloud deployment without the client, the host, or the server's
 * tool code changing at all - which is exactly what project requirement 6 asks
 * for ("el mismo servidor MCP pero ahora que se ejecute de forma remota").
 */

import type { JsonRpcMessage } from './types.js';

export interface TransportHandlers {
  /** Called once per well-formed inbound JSON-RPC message. */
  onMessage: (message: JsonRpcMessage) => void;
  /** Transport-level failure (framing, socket, subprocess crash). */
  onError: (error: Error) => void;
  /** The peer went away. */
  onClose: () => void;
}

export interface Transport {
  /** Short label used in the interaction log, e.g. "stdio" or "http". */
  readonly kind: string;

  /** Attach handlers and bring the channel up. Must be called before send(). */
  start(handlers: TransportHandlers): Promise<void>;

  /** Put one JSON-RPC message on the wire. */
  send(message: JsonRpcMessage): Promise<void>;

  /** Shut the channel down cleanly. Must be idempotent. */
  close(): Promise<void>;

  /**
   * Adopt the protocol revision agreed during initialization. Only transports
   * that put the version on the wire implement this - HTTP must send
   * MCP-Protocol-Version on every post-handshake request, while stdio carries
   * no such framing.
   */
  setProtocolVersion?(version: string): void;
}
