/**
 * The ISP / NOC support desk MCP server.
 *
 * This module builds the server object; it deliberately knows nothing about how
 * messages arrive. stdio-main.ts and http-main.ts both call createNocServer(),
 * which is what makes the local and the remote deployment the same server
 * (project requirement 6) rather than two implementations kept in sync by hand.
 */

import { McpServer } from './core.js';
import { NOC_TOOLS } from './tools/noc-tools.js';

export const NOC_SERVER_INFO = {
  name: 'noc-support-desk',
  title: 'ISP NOC Support Desk',
  version: '1.0.0',
} as const;

const INSTRUCTIONS = [
  'This server exposes the first-line support desk of an internet service provider.',
  '',
  'Recommended workflow when a subscriber reports a problem:',
  '  1. lookup_subscriber   - identify the account and obtain its circuit id',
  '  2. get_link_metrics    - read the live telemetry for that circuit',
  '  3. check_zone_outage   - confirm whether a known incident explains the symptom',
  '  4. run_link_diagnostics- evaluate the telemetry against operator thresholds',
  '  5. open_incident_ticket- escalate, but only when the diagnostic reports a fault',
  '     that is not already covered by a known zone outage.',
  '',
  'All data is synthetic and safe to display to the user.',
].join('\n');

export function createNocServer(): McpServer {
  const server = new McpServer({ info: NOC_SERVER_INFO, instructions: INSTRUCTIONS });
  for (const tool of NOC_TOOLS) server.registerTool(tool);
  return server;
}
