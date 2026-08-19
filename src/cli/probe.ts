/**
 * Connection probe.
 *
 * Connects to every enabled MCP server, completes the handshake and prints the
 * negotiated protocol version, the advertised capabilities and the tool
 * catalogue. Run it after changing config/servers.json, or to prove that the
 * remote deployment answers exactly like the local one.
 *
 *   npm run probe            # every enabled server
 *   npm run probe -- git     # only servers whose name contains "git"
 */

import { config as loadEnv } from 'dotenv';

import { enabledServers, loadHostConfig } from '../host/config.js';
import { connectServer } from '../host/connect.js';
import { InteractionLog, formatEntry } from '../mcp/log.js';

loadEnv();

const filter = process.argv[2];
const verbose = process.argv.includes('--verbose');

async function main(): Promise<void> {
  const config = loadHostConfig();
  const targets = enabledServers(config).filter(
    (server) => !filter || filter.startsWith('--') || server.name.includes(filter),
  );

  if (targets.length === 0) {
    console.error('No enabled servers matched.');
    process.exitCode = 1;
    return;
  }

  const log = new InteractionLog();
  if (verbose) {
    log.on('entry', (entry) => console.log('  ' + formatEntry(entry)));
  }

  let failures = 0;

  for (const server of targets) {
    const target =
      server.transport === 'stdio'
        ? `${server.command} ${(server.args ?? []).join(' ')}`
        : server.url;

    console.log(`\n=== ${server.name} [${server.transport}] ===`);
    console.log(`    ${target}`);

    const startedAt = Date.now();
    try {
      const client = await connectServer(server, {
        log,
        onStderr: verbose ? (name, line) => console.log(`  (${name} stderr) ${line}`) : undefined,
        requestTimeoutMs: 60_000,
      });

      const tools = await client.listTools();
      const elapsed = Date.now() - startedAt;

      console.log(`    server .......... ${client.info?.name ?? '?'} v${client.info?.version ?? '?'}`);
      console.log(`    protocol ........ ${client.protocolVersion}`);
      console.log(`    capabilities .... ${Object.keys(client.capabilities).join(', ') || '(none)'}`);
      console.log(`    tools (${tools.length}) ...... ${tools.map((tool) => tool.name).join(', ')}`);
      console.log(`    connected in .... ${elapsed}ms`);

      await client.close();
    } catch (error) {
      failures += 1;
      console.log(`    FAILED: ${(error as Error).message}`);
    }
  }

  console.log(`\nFrames exchanged: ${log.size}`, log.summary());

  if (failures > 0) {
    console.error(`\n${failures} server(s) failed to connect.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
