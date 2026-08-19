/**
 * Server configuration loading.
 *
 * Which MCP servers the host connects to is data, not code. That is what makes
 * requirement 6 a one-line change: swapping the custom NOC server from local
 * stdio to the remote deployment means flipping which entry is enabled, with no
 * change to the client, the host, or the server's tool implementations.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location (src/host -> ../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface StdioServerConfig {
  name: string;
  transport: 'stdio';
  enabled?: boolean;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory, relative to the repository root unless absolute. */
  cwd?: string;
}

export interface HttpServerConfig {
  name: string;
  transport: 'http';
  enabled?: boolean;
  description?: string;
  /** Full URL of the MCP endpoint, e.g. https://host.example.com/mcp */
  url: string;
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface HostConfig {
  servers: ServerConfig[];
}

/** Expand ${VAR} references so URLs and headers can come from the environment. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? '');
}

function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/**
 * Read and validate the server list.
 *
 * Path-like arguments are resolved against the repository root so the host
 * behaves identically no matter which directory it was launched from - a real
 * concern here, because the Filesystem and Git servers take directories as
 * arguments and would otherwise silently point somewhere unexpected.
 */
export function loadHostConfig(configPath?: string): HostConfig {
  const path = configPath ?? resolve(REPO_ROOT, 'config', 'servers.json');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read server config at ${path}: ${(cause as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Server config at ${path} is not valid JSON: ${(cause as Error).message}`);
  }

  const servers = (parsed as HostConfig)?.servers;
  if (!Array.isArray(servers)) {
    throw new Error(`Server config at ${path} must contain a "servers" array`);
  }

  const seen = new Set<string>();
  const normalized: ServerConfig[] = servers.map((server, index) => {
    if (!server?.name) throw new Error(`servers[${index}] is missing "name"`);
    if (seen.has(server.name)) throw new Error(`Duplicate server name "${server.name}"`);
    seen.add(server.name);

    if (server.transport === 'stdio') {
      if (!server.command) throw new Error(`servers[${index}] ("${server.name}") is missing "command"`);
      return {
        ...server,
        args: (server.args ?? []).map((arg) => {
          const expanded = expandEnv(arg);
          // Treat ./ and ../ prefixed arguments as paths; leave flags alone.
          return expanded.startsWith('./') || expanded.startsWith('../')
            ? resolveFromRoot(expanded)
            : expanded;
        }),
        cwd: server.cwd ? resolveFromRoot(expandEnv(server.cwd)) : REPO_ROOT,
      };
    }

    if (server.transport === 'http') {
      if (!server.url) throw new Error(`servers[${index}] ("${server.name}") is missing "url"`);
      return { ...server, url: expandEnv(server.url) };
    }

    // Both known transports returned above, so TypeScript narrows `server` to
    // never here; widen it back to read the offending values for the message.
    const unknown = server as { name?: string; transport?: string };
    throw new Error(
      `servers[${index}] ("${unknown.name}") has unknown transport "${unknown.transport}"`,
    );
  });

  return { servers: normalized };
}

/** Only the entries that are switched on. */
export function enabledServers(config: HostConfig): ServerConfig[] {
  return config.servers.filter((server) => server.enabled !== false);
}
