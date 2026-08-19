/**
 * stdio entry point for the NOC MCP server (project requirement 5).
 *
 * Framing rules from the MCP transports specification:
 *   - one JSON-RPC message per line on stdin and stdout, UTF-8;
 *   - no embedded newlines;
 *   - stdout carries MCP messages and NOTHING else - a stray console.log here
 *     corrupts the stream, which is why every diagnostic below goes to stderr.
 */

import { makeError, parseMessage } from '../mcp/jsonrpc.js';
import { JsonRpcErrorCode } from '../mcp/types.js';
import { createNocServer } from './noc-server.js';

const server = createNocServer();

function writeToStdout(payload: string): void {
  process.stdout.write(payload + '\n');
}

function logDiagnostic(message: string): void {
  // stderr only. The client is required to treat this as informational.
  process.stderr.write(`[noc-support-desk] ${message}\n`);
}

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk: string) => {
  buffer += chunk;

  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf('\n');

    if (line.length === 0) continue;
    void handleLine(line);
  }
});

async function handleLine(line: string): Promise<void> {
  let message;
  try {
    message = parseMessage(line);
  } catch (error) {
    // A parse failure has no id to correlate against, so the spec's null id
    // applies here.
    logDiagnostic(`parse error: ${(error as Error).message}`);
    writeToStdout(
      JSON.stringify(makeError(null, JsonRpcErrorCode.ParseError, 'Parse error')),
    );
    return;
  }

  try {
    const response = await server.handleMessage(message);
    if (response) writeToStdout(JSON.stringify(response));
  } catch (error) {
    logDiagnostic(`unhandled dispatch failure: ${(error as Error).message}`);
  }
}

process.stdin.on('end', () => {
  // The client closed stdin: shut down cleanly, as the lifecycle spec expects.
  logDiagnostic('stdin closed, exiting');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

logDiagnostic(`ready over stdio with ${server.listToolDescriptors().length} tools`);
