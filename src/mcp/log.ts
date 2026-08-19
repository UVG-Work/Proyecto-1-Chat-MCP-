/**
 * Protocol interaction log (project requirement 3).
 *
 * Every JSON-RPC frame that crosses a transport - in either direction, on both
 * stdio and Streamable HTTP - passes through this recorder. Keeping a single
 * tap point means the log is complete by construction rather than by remembering
 * to call it, and it doubles as the evidence used for the Wireshark write-up
 * (requirement 7) since the decoded application-layer messages captured on the
 * wire should match these entries one for one.
 */

import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { classify, isNotification, isRequest, type MessageKind } from './jsonrpc.js';
import type { JsonRpcMessage } from './types.js';

/** Which way the frame was travelling, from the host's point of view. */
export type Direction = 'sent' | 'received';

export interface LogEntry {
  /** Monotonic sequence number, useful when timestamps collide. */
  seq: number;
  timestamp: string;
  direction: Direction;
  /** Logical name of the MCP server this frame belongs to. */
  server: string;
  /** Transport that carried it, e.g. "stdio" or "http". */
  transport: string;
  kind: MessageKind;
  method?: string;
  id?: string | number;
  message: JsonRpcMessage;
}

export interface InteractionLogOptions {
  /** Append every entry as one JSON object per line (JSON Lines). */
  filePath?: string;
  /** Cap on entries held in memory. Older entries are dropped first. */
  maxEntries?: number;
}

/**
 * In-memory interaction log with an optional JSON Lines mirror on disk.
 *
 * Emits an "entry" event per frame so the web UI can stream the log live
 * instead of polling.
 */
export class InteractionLog extends EventEmitter {
  private readonly entries: LogEntry[] = [];
  private readonly maxEntries: number;
  private readonly filePath: string | undefined;
  private seq = 0;

  constructor(options: InteractionLogOptions = {}) {
    super();
    this.maxEntries = options.maxEntries ?? 2000;
    this.filePath = options.filePath;
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
  }

  record(
    direction: Direction,
    server: string,
    transport: string,
    message: JsonRpcMessage,
  ): LogEntry {
    const entry: LogEntry = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      direction,
      server,
      transport,
      kind: classify(message),
      message,
    };

    if (isRequest(message) || isNotification(message)) {
      entry.method = message.method;
    }
    if ('id' in message && message.id !== null && message.id !== undefined) {
      entry.id = message.id;
    }

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    if (this.filePath) {
      // Synchronous append: the log must survive a crash mid-conversation,
      // and the volume here is far too low for the blocking cost to matter.
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    }

    this.emit('entry', entry);
    return entry;
  }

  /** All entries, oldest first. Pass a count to get only the most recent ones. */
  all(limit?: number): LogEntry[] {
    if (limit === undefined || limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - limit);
  }

  /** Entries for one MCP server, oldest first. */
  forServer(server: string): LogEntry[] {
    return this.entries.filter((entry) => entry.server === server);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Counts per message kind - the summary table used in the report. */
  summary(): Record<MessageKind, number> {
    const totals: Record<MessageKind, number> = {
      synchronization: 0,
      request: 0,
      response: 0,
      error: 0,
      notification: 0,
    };
    for (const entry of this.entries) totals[entry.kind] += 1;
    return totals;
  }
}

/** One-line rendering used by the CLI. */
export function formatEntry(entry: LogEntry): string {
  const arrow = entry.direction === 'sent' ? '-->' : '<--';
  const time = entry.timestamp.slice(11, 23);
  const label = entry.method ?? (entry.kind === 'error' ? 'error' : 'result');
  const id = entry.id === undefined ? '' : ` #${entry.id}`;
  return `[${time}] ${arrow} ${entry.server} (${entry.transport}) ${entry.kind.padEnd(15)} ${label}${id}`;
}
