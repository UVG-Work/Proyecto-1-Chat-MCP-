// Non-interactive chat runner for the demonstration scenarios.

import { config as loadEnv } from 'dotenv';

import { McpHost } from '../host/host.js';
import { OpenRouterProvider } from '../host/llm/openrouter.js';
import { InteractionLog, formatEntry } from '../mcp/log.js';

loadEnv({ quiet: true });

const SCENARIOS: Record<string, { title: string; prompts: string[] }> = {
  context: {
    title: 'Requirements 1 and 2 - LLM API and session context',
    prompts: [
      'Who was Alan Turing?',
      'What date was he born?',
      'And in which city?',
    ],
  },
  noc: {
    title: 'Requirement 5/6 - the custom NOC support desk server',
    prompts: [
      'La clienta Maria Elena Ramirez llama porque su internet esta muy lento. ' +
        'Investiga que ocurre con su servicio y, si corresponde, abre un ticket de incidente.',
    ],
  },
  git: {
    title: 'Requirement 4 - official Filesystem and Git MCP servers',
    prompts: [
      'Inside the demo-repo directory, create a file named README.md describing this project ' +
        '(an MCP chat host for a networking course). Then add it to the git repository in that ' +
        'same directory and commit it with a descriptive message. Finally show me the git log.',
    ],
  },
  outage: {
    title: 'NOC server - the zone outage path',
    prompts: [
      'Ana Lucia Estrada reports she has no internet at all. What is going on? ' +
        'Should we send a technician?',
    ],
  },
  suspended: {
    title: 'NOC server - the suspended account path',
    prompts: ['Check what is wrong with the service for subscriber SUB-101204.'],
  },
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const showLog = argv.includes('--log');
  const args = argv.filter((arg) => arg !== '--log');

  let prompts: string[];
  let title = 'Ad-hoc prompts';

  const scenarioIndex = args.indexOf('--scenario');
  if (scenarioIndex !== -1) {
    const name = args[scenarioIndex + 1] ?? '';
    const scenario = SCENARIOS[name];
    if (!scenario) {
      console.error(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(1);
    }
    prompts = scenario.prompts;
    title = scenario.title;
  } else {
    prompts = args;
  }

  if (prompts.length === 0) {
    console.error('Provide prompts, or --scenario <name>. Scenarios: ' + Object.keys(SCENARIOS).join(', '));
    process.exit(1);
  }

  const log = new InteractionLog();
  const provider = new OpenRouterProvider();
  const host = new McpHost({ provider, log });

  console.log(`\n${'='.repeat(78)}`);
  console.log(title);
  console.log(`model: ${provider.model}`);
  console.log('='.repeat(78));

  host.on('server:connected', (name: string, count: number) =>
    console.log(`  connected  ${name} (${count} tools)`),
  );
  host.on('server:failed', (name: string, error: Error) =>
    console.log(`  FAILED     ${name}: ${error.message.split('\n')[0]}`),
  );

  await host.start();
  console.log(`  ${host.toolCatalog.length} tools available\n`);

  for (const prompt of prompts) {
    console.log('-'.repeat(78));
    console.log(`USER: ${prompt}\n`);

    const startedAt = Date.now();
    const turn = await host.chat(prompt);

    for (const execution of turn.executions) {
      const status = execution.error ?? execution.result?.isError ? 'ERROR' : 'ok';
      console.log(
        `  [tool] ${execution.server}__${execution.tool}` +
          ` ${JSON.stringify(execution.arguments)} -> ${status} (${execution.durationMs}ms)`,
      );
    }
    if (turn.executions.length > 0) console.log('');

    console.log(`BOT: ${turn.reply}`);
    console.log(
      `\n  (${turn.executions.length} tool call(s), ${turn.iterations} model round trip(s), ${Date.now() - startedAt}ms)\n`,
    );
  }

  if (showLog) {
    console.log('='.repeat(78));
    console.log(`MCP interaction log - ${log.size} frames`);
    console.log('='.repeat(78));
    for (const entry of log.all()) console.log(formatEntry(entry));
  }

  console.log(`\nframes: ${log.size}`, log.summary());
  await host.close();
}

main().catch((error) => {
  console.error(`\nFAILED: ${(error as Error).message}`);
  process.exit(1);
});
