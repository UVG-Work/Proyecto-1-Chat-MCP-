// Terminal chatbot with commands for inspecting the MCP interaction log.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { config as loadEnv } from 'dotenv';

import { InteractionLog, formatEntry } from '../mcp/log.js';
import { McpHost, type ToolExecution } from '../host/host.js';
import { OpenRouterProvider } from '../host/llm/openrouter.js';

loadEnv();

const useColor = stdout.isTTY && process.env['NO_COLOR'] === undefined;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const blue = paint('34');
const magenta = paint('35');
const cyan = paint('36');

function heading(text: string): void {
  console.log('\n' + bold(text));
}

async function main(): Promise<void> {
  const log = new InteractionLog({ filePath: 'logs/mcp-interactions.jsonl' });

  let provider: OpenRouterProvider;
  try {
    provider = new OpenRouterProvider();
  } catch (error) {
    console.error(red((error as Error).message));
    process.exit(1);
  }

  const host = new McpHost({
    provider,
    log,
    // stdio servers are chatty on stderr during startup; surfacing it only in
    // debug mode keeps the chat readable.
    onStderr: process.env['MCP_DEBUG'] === '1' ? (name, line) => console.log(dim(`  (${name}) ${line}`)) : undefined,
  });

  host.on('server:connected', (name: string, toolCount: number) => {
    console.log(`  ${green('connected')}  ${name} ${dim(`(${toolCount} tools)`)}`);
  });
  host.on('server:failed', (name: string, error: Error) => {
    console.log(`  ${red('failed')}     ${name} ${dim(`- ${error.message.split('\n')[0]}`)}`);
  });
  host.on('tool:start', (server: string, tool: string, args: Record<string, unknown>) => {
    console.log(dim(`  -> ${server}${cyan('__')}${tool}(${compactJson(args)})`));
  });
  host.on('tool:end', (execution: ToolExecution) => {
    const status = execution.error || execution.result?.isError ? red('error') : green('ok');
    console.log(dim(`  <- ${execution.server}__${execution.tool} [${status}${dim('')}] ${execution.durationMs}ms`));
  });

  console.log(bold('\nMCP Chat Host') + dim('  -  UVG CC3067 Redes, Proyecto 1'));
  console.log(dim(`model: ${provider.model}`));
  heading('Connecting to MCP servers');
  await host.start();

  if (host.connectedServers.length === 0) {
    console.log(yellow('\nNo MCP servers connected. The assistant will answer without tools.'));
  }

  console.log(
    dim(`\n${host.toolCatalog.length} tools available. Type /help for commands, /exit to quit.\n`),
  );

  const rl = createInterface({ input: stdin, output: stdout });

  for (;;) {
    let input: string;
    try {
      input = (await rl.question(bold(blue('you > ')))).trim();
    } catch {
      break; // Ctrl+C / Ctrl+D
    }

    if (input.length === 0) continue;

    if (input.startsWith('/')) {
      const done = handleCommand(input, host, log);
      if (done) break;
      continue;
    }

    try {
      const turn = await host.chat(input);
      console.log(`\n${bold(magenta('bot > '))}${turn.reply}\n`);
      if (turn.executions.length > 0) {
        console.log(
          dim(`      (${turn.executions.length} tool call(s), ${turn.iterations} model round trip(s))\n`),
        );
      }
    } catch (error) {
      console.log(red(`\nerror: ${(error as Error).message}\n`));
    }
  }

  rl.close();
  console.log(dim('\nClosing MCP connections...'));
  await host.close();
  console.log(dim('Goodbye.'));
}

function handleCommand(input: string, host: McpHost, log: InteractionLog): boolean {
  const [command = '', ...rest] = input.slice(1).split(/\s+/);
  const argument = rest.join(' ');

  switch (command.toLowerCase()) {
    case 'exit':
    case 'quit':
      return true;

    case 'help':
      heading('Commands');
      console.log(
        [
          '  /servers        connected MCP servers and negotiated protocol versions',
          '  /tools          tool catalogue as the model receives it',
          '  /log [n]        last n MCP frames (default 40)',
          '  /log full       every frame with its complete JSON payload',
          '  /log <server>   frames for one server only',
          '  /stats          frame counts by message kind',
          '  /reset          clear conversation context',
          '  /exit           quit',
        ].join('\n'),
      );
      return false;

    case 'servers':
      heading('Connected MCP servers');
      if (host.connectedServers.length === 0) console.log(dim('  (none)'));
      for (const server of host.connectedServers) {
        console.log(
          `  ${bold(server.config.name)} ${dim(`[${server.config.transport}]`)} ` +
            `${server.client.info?.name ?? '?'} v${server.client.info?.version ?? '?'} ` +
            dim(`protocol ${server.client.protocolVersion}, ${server.tools.length} tools`),
        );
      }
      if (host.failedServers.length > 0) {
        heading('Failed');
        for (const failure of host.failedServers) {
          console.log(`  ${red(failure.config.name)} ${dim(failure.error.message.split('\n')[0] ?? '')}`);
        }
      }
      return false;

    case 'tools': {
      heading(`Tool catalogue (${host.toolCatalog.length})`);
      for (const tool of host.toolCatalog) {
        const summary = tool.description.split('\n')[0] ?? '';
        console.log(`  ${cyan(tool.name)}`);
        console.log(dim(`    ${summary.slice(0, 140)}`));
      }
      return false;
    }

    case 'log': {
      if (argument === 'full') {
        heading(`MCP interaction log (${log.size} frames, full payloads)`);
        for (const entry of log.all()) {
          console.log(formatEntry(entry));
          console.log(dim('    ' + JSON.stringify(entry.message)));
        }
        return false;
      }

      const asNumber = Number(argument);
      if (argument && Number.isNaN(asNumber)) {
        const entries = log.forServer(argument);
        heading(`MCP interaction log for "${argument}" (${entries.length} frames)`);
        for (const entry of entries) console.log(formatEntry(entry));
        return false;
      }

      const limit = argument ? asNumber : 40;
      const entries = log.all(limit);
      heading(`MCP interaction log (last ${entries.length} of ${log.size} frames)`);
      for (const entry of entries) console.log(formatEntry(entry));
      console.log(dim('\n  /log full for complete JSON payloads'));
      return false;
    }

    case 'stats':
      heading('Frames by kind');
      for (const [kind, count] of Object.entries(log.summary())) {
        console.log(`  ${kind.padEnd(16)} ${count}`);
      }
      console.log(dim(`  ${'total'.padEnd(16)} ${log.size}`));
      return false;

    case 'reset':
      host.resetConversation();
      console.log(dim('Conversation context cleared.'));
      return false;

    default:
      console.log(yellow(`Unknown command "/${command}". Try /help.`));
      return false;
  }
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
