/**
 * Scripted MCP session, used to generate traffic for the packet captures
 * (requirement 7) and as a deterministic end-to-end test of a server.
 *
 * It drives a complete session by hand - handshake, discovery, five tool calls,
 * an error case, and an explicit shutdown - with no language model involved, so
 * it needs no API key and produces exactly the same exchange every run. That
 * matters for the capture: the packets can be compared against a known script.
 *
 *   npm run demo:session -- noc-http-local
 *   npm run demo:session -- noc-remote
 */

import { config as loadEnv } from 'dotenv';

import { loadHostConfig } from '../host/config.js';
import { connectServer } from '../host/connect.js';
import { InteractionLog, formatEntry } from '../mcp/log.js';
import { renderContent } from '../host/host.js';

loadEnv();

/** The support-desk scenario from the specification, as explicit calls. */
const SCRIPT: { tool: string; args: Record<string, unknown>; why: string }[] = [
  { tool: 'lookup_subscriber', args: { query: 'Maria Elena Ramirez' }, why: 'identify the account' },
  { tool: 'get_link_metrics', args: { circuit_id: 'GT-CIR-004821' }, why: 'read live telemetry' },
  { tool: 'check_zone_outage', args: { zone: 'ZONA-MIXCO-03' }, why: 'rule out a known outage' },
  { tool: 'run_link_diagnostics', args: { circuit_id: 'GT-CIR-004821' }, why: 'evaluate thresholds' },
  {
    tool: 'open_incident_ticket',
    args: {
      subscriber_id: 'SUB-100482',
      summary: '8.2% packet loss and SNR 14.1 dB on GT-CIR-004821; 11 flaps in 24h',
      severity: 'critical',
    },
    why: 'escalate',
  },
  // Deliberate failure: exercises the -32602 path so the capture contains a
  // JSON-RPC error response as well as successful ones.
  { tool: 'get_link_metrics', args: { circuit_id: 'GT-CIR-000000' }, why: 'error path (unknown circuit)' },
];

async function main(): Promise<void> {
  const target = process.argv[2] ?? 'noc-local';
  const verbose = process.argv.includes('--verbose');

  const config = loadHostConfig();
  const serverConfig = config.servers.find((server) => server.name === target);
  if (!serverConfig) {
    console.error(
      `No server named "${target}" in config/servers.json. Available: ` +
        config.servers.map((server) => server.name).join(', '),
    );
    process.exit(1);
  }

  const log = new InteractionLog();
  if (verbose) log.on('entry', (entry) => console.log('  ' + formatEntry(entry)));

  const where =
    serverConfig.transport === 'stdio'
      ? `${serverConfig.command} ${(serverConfig.args ?? []).join(' ')}`
      : serverConfig.url;

  console.log(`\n=== scripted MCP session against "${target}" [${serverConfig.transport}] ===`);
  console.log(`    ${where}\n`);

  const startedAt = Date.now();
  const client = await connectServer(serverConfig, { log });
  console.log(`handshake complete: ${client.info?.name} v${client.info?.version}, MCP ${client.protocolVersion}`);

  const tools = await client.listTools();
  console.log(`discovered ${tools.length} tools\n`);

  for (const step of SCRIPT) {
    process.stdout.write(`  ${step.tool.padEnd(22)} ${step.why} ... `);
    const result = await client.callTool(step.tool, step.args);
    const text = renderContent(result.content);
    console.log(result.isError ? 'reported an error' : 'ok');
    if (verbose) console.log(text.split('\n').map((line) => `      ${line}`).join('\n'));
  }

  await client.close();

  const elapsed = Date.now() - startedAt;
  console.log(`\nsession closed after ${elapsed}ms`);
  console.log(`frames exchanged: ${log.size}`, log.summary());
}

main().catch((error) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exit(1);
});
