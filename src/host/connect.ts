// Builds a connected McpClient from a configuration entry.

import { resolve } from 'node:path';

import { McpClient } from '../mcp/client.js';
import { HttpClientTransport } from '../mcp/http-transport.js';
import type { InteractionLog } from '../mcp/log.js';
import { StdioClientTransport } from '../mcp/stdio-transport.js';
import type { Transport } from '../mcp/transport.js';
import { REPO_ROOT, type ServerConfig } from './config.js';

export interface ConnectOptions {
  log: InteractionLog;
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

  // MCP_TLS_KEYLOG=1 makes the client export its TLS session keys so Wireshark
  // can decrypt a capture of the remote server (requirement 7). Off by default:
  // the file contains live session secrets and is git-ignored.
  const keyLogEnabled = process.env['MCP_TLS_KEYLOG'] === '1';

  return new HttpClientTransport({
    url: config.url,
    headers: config.headers,
    ...(keyLogEnabled
      ? { tlsKeyLogPath: resolve(REPO_ROOT, 'docs', 'captures', 'session.keylog') }
      : {}),
  });
}

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
