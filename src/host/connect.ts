/**
 * Builds a connected McpClient from a configuration entry.
 *
 * This is the only place that knows which transport implementation belongs to
 * which config shape, which keeps the transport choice out of the host, the
 * client and the CLI.
 */

import { McpClient } from '../mcp/client.js';
import { HttpClientTransport } from '../mcp/http-transport.js';
import type { InteractionLog } from '../mcp/log.js';
import { StdioClientTransport } from '../mcp/stdio-transport.js';
import type { Transport } from '../mcp/transport.js';
import type { ServerConfig } from './config.js';

export interface ConnectOptions {
  log: InteractionLog;
  /** Receives stderr lines from stdio servers. Informational only. */
  onStderr?: (server: string, line: string) => void;
  requestTimeoutMs?: number;
}

export function createTransport(config: ServerConfig, options: ConnectOptions): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      onStderr: (line) => options.onStderr?.(config.name, line),
    });
  }

  return new HttpClientTransport({
    url: config.url,
    headers: config.headers,
  });
}

/** Create a client and complete the MCP initialization handshake. */
export async function connectServer(
  config: ServerConfig,
  options: ConnectOptions,
): Promise<McpClient> {
  const client = new McpClient({
    name: config.name,
    transport: createTransport(config, options),
    log: options.log,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  await client.connect();
  return client;
}
