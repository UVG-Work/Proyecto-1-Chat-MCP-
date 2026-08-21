// HTTP bridge that lets the web UI drive the same host as the CLI.

import cors from 'cors';
import { config as loadEnv } from 'dotenv';
import express, { type Request, type Response } from 'express';

import { McpHost } from '../host/host.js';
import { OpenRouterProvider } from '../host/llm/openrouter.js';
import { InteractionLog, type LogEntry } from '../mcp/log.js';

loadEnv();

const PORT = Number(process.env['API_PORT'] ?? 3001);

async function main(): Promise<void> {
  const log = new InteractionLog({ filePath: 'logs/mcp-interactions.jsonl' });
  const provider = new OpenRouterProvider();
  const host = new McpHost({ provider, log });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Startup is slow (subprocess spawns), so the UI polls this until ready
  // instead of hanging on its first request.
  let ready = false;
  let startupError: string | undefined;

  app.get('/api/status', (_request: Request, response: Response) => {
    response.json({
      ready,
      startupError,
      model: provider.model,
      servers: host.connectedServers.map((server) => ({
        name: server.config.name,
        transport: server.config.transport,
        description: server.config.description ?? '',
        implementation: server.client.info?.name ?? null,
        version: server.client.info?.version ?? null,
        protocolVersion: server.client.protocolVersion,
        toolCount: server.tools.length,
      })),
      failed: host.failedServers.map((failure) => ({
        name: failure.config.name,
        error: failure.error.message.split('\n')[0],
      })),
      toolCount: host.toolCatalog.length,
    });
  });

  app.get('/api/tools', (_request: Request, response: Response) => {
    response.json({
      tools: host.toolCatalog.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });
  });

  app.get('/api/log', (request: Request, response: Response) => {
    const limit = Number(request.query['limit'] ?? 200);
    response.json({
      entries: log.all(Number.isFinite(limit) ? limit : 200),
      summary: log.summary(),
      total: log.size,
    });
  });

  app.get('/api/log/stream', (request: Request, response: Response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');

    const onEntry = (entry: LogEntry) => {
      response.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    log.on('entry', onEntry);

    // Without a heartbeat, proxies drop an idle SSE connection.
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000);

    request.on('close', () => {
      clearInterval(heartbeat);
      log.off('entry', onEntry);
    });
  });

  app.post('/api/chat', (request: Request, response: Response) => {
    const message = (request.body as { message?: unknown })?.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      response.status(400).json({ error: 'Body must contain a non-empty "message" string' });
      return;
    }
    if (!ready) {
      response.status(503).json({ error: 'The host is still connecting to its MCP servers' });
      return;
    }

    host
      .chat(message)
      .then((turn) => {
        response.json({
          reply: turn.reply,
          iterations: turn.iterations,
          executions: turn.executions.map((execution) => ({
            server: execution.server,
            tool: execution.tool,
            arguments: execution.arguments,
            durationMs: execution.durationMs,
            isError: Boolean(execution.error ?? execution.result?.isError),
            error: execution.error ?? null,
          })),
        });
      })
      .catch((error: Error) => {
        response.status(500).json({ error: error.message });
      });
  });

  app.post('/api/reset', (_request: Request, response: Response) => {
    host.resetConversation();
    response.json({ ok: true });
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`API bridge listening on http://127.0.0.1:${PORT}`);
    console.log(`model: ${provider.model}`);
  });

  try {
    console.log('Connecting to MCP servers...');
    await host.start();
    ready = true;
    for (const server of host.connectedServers) {
      console.log(`  connected  ${server.config.name} (${server.tools.length} tools)`);
    }
    for (const failure of host.failedServers) {
      console.log(`  failed     ${failure.config.name}: ${failure.error.message.split('\n')[0]}`);
    }
    console.log(`Ready with ${host.toolCatalog.length} tools.`);
  } catch (error) {
    startupError = (error as Error).message;
    console.error(`Startup failed: ${startupError}`);
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received, closing MCP connections...`);
      void host.close().finally(() => httpServer.close(() => process.exit(0)));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
