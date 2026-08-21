// Interaction log recording every JSON-RPC frame in both directions.

import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { classify, isNotification, isRequest, type MessageKind } from './jsonrpc.js';
import type { JsonRpcMessage } from './types.js';

export type Direction = 'sent' | 'received';

export interface LogEntry {
  seq: number;
  timestamp: string;
  direction: Direction;
  server: string;
  transport: string;
  kind: MessageKind;
  method?: string;
  id?: string | number;
  message: JsonRpcMessage;
}

export interface InteractionLogOptions {
  filePath?: string;
  maxEntries?: number;
}

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

  all(limit?: number): LogEntry[] {
    if (limit === undefined || limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - limit);
  }

  forServer(server: string): LogEntry[] {
    return this.entries.filter((entry) => entry.server === server);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

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

export function formatEntry(entry: LogEntry): string {
  const arrow = entry.direction === 'sent' ? '-->' : '<--';
  const time = entry.timestamp.slice(11, 23);
  const label = entry.method ?? (entry.kind === 'error' ? 'error' : 'result');
  const id = entry.id === undefined ? '' : ` #${entry.id}`;
  return `[${time}] ${arrow} ${entry.server} (${entry.transport}) ${entry.kind.padEnd(15)} ${label}${id}`;
}
