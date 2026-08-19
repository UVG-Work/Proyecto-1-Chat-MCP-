/**
 * The host (the "Anfitrion" of the project statement's three-actor model).
 *
 * It owns one MCP client per configured server, merges their tool catalogues
 * into a single list for the language model, and runs the agentic loop: ask the
 * model, execute whatever tools it requests over MCP, feed the results back,
 * repeat until the model answers in prose.
 */

import { EventEmitter } from 'node:events';

import type { McpClient } from '../mcp/client.js';
import type { InteractionLog } from '../mcp/log.js';
import type { CallToolResult, ContentBlock, Tool } from '../mcp/types.js';
import { enabledServers, loadHostConfig, type ServerConfig } from './config.js';
import { connectServer } from './connect.js';
import type { ChatMessage, LlmProvider, LlmTool, LlmToolCall } from './llm/types.js';
import { Conversation } from './conversation.js';

/**
 * Separator between the server name and the tool name.
 *
 * Namespacing is necessary: two servers may expose the same tool name, and the
 * model only ever sees one flat list. Double underscore keeps the result inside
 * the character set providers accept for function names ([a-zA-Z0-9_-]).
 */
const NAMESPACE_SEPARATOR = '__';

export interface ConnectedServer {
  config: ServerConfig;
  client: McpClient;
  tools: Tool[];
}

export interface FailedServer {
  config: ServerConfig;
  error: Error;
}

export interface ToolExecution {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  result?: CallToolResult;
  error?: string;
  durationMs: number;
}

export interface ChatTurn {
  /** Final assistant prose. */
  reply: string;
  /** Every tool executed while producing it, in order. */
  executions: ToolExecution[];
  /** Model round trips consumed. */
  iterations: number;
}

export interface HostOptions {
  provider: LlmProvider;
  log: InteractionLog;
  configPath?: string;
  /** Safety valve on the agentic loop. */
  maxIterations?: number;
  onStderr?: (server: string, line: string) => void;
}

export class McpHost extends EventEmitter {
  readonly log: InteractionLog;
  private readonly provider: LlmProvider;
  private readonly configPath: string | undefined;
  private readonly maxIterations: number;
  private readonly onStderr: ((server: string, line: string) => void) | undefined;

  private readonly servers: ConnectedServer[] = [];
  private readonly failures: FailedServer[] = [];
  private conversation: Conversation | undefined;

  constructor(options: HostOptions) {
    super();
    this.provider = options.provider;
    this.log = options.log;
    this.configPath = options.configPath;
    this.maxIterations = options.maxIterations ?? 16;
    this.onStderr = options.onStderr;
  }

  /* ---------------------------------------------------------------------- */
  /* Startup                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Connect every enabled server.
   *
   * Connections run in parallel and a failure is recorded rather than thrown:
   * one unavailable server (a missing uvx, an unreachable remote) should not
   * stop the chatbot from working with the others.
   */
  async start(): Promise<void> {
    const config = loadHostConfig(this.configPath);
    const targets = enabledServers(config);

    await Promise.all(
      targets.map(async (serverConfig) => {
        try {
          const client = await connectServer(serverConfig, {
            log: this.log,
            onStderr: this.onStderr,
          });
          const tools = await client.listTools();
          this.servers.push({ config: serverConfig, client, tools });
          this.emit('server:connected', serverConfig.name, tools.length);
        } catch (error) {
          this.failures.push({ config: serverConfig, error: error as Error });
          this.emit('server:failed', serverConfig.name, error as Error);
        }
      }),
    );

    // Deterministic order regardless of which connection won the race.
    this.servers.sort((a, b) => a.config.name.localeCompare(b.config.name));
    this.conversation = new Conversation({ systemPrompt: this.buildSystemPrompt() });
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.client.close()));
  }

  /* ---------------------------------------------------------------------- */
  /* Introspection                                                          */
  /* ---------------------------------------------------------------------- */

  get connectedServers(): ConnectedServer[] {
    return [...this.servers];
  }

  get failedServers(): FailedServer[] {
    return [...this.failures];
  }

  get modelName(): string {
    return this.provider.model;
  }

  get history(): ChatMessage[] {
    return this.conversation?.turns ?? [];
  }

  resetConversation(): void {
    this.conversation?.reset();
  }

  /** Flattened, namespaced catalogue exactly as the model sees it. */
  get toolCatalog(): LlmTool[] {
    const catalog: LlmTool[] = [];
    for (const server of this.servers) {
      for (const tool of server.tools) {
        catalog.push({
          name: `${server.config.name}${NAMESPACE_SEPARATOR}${tool.name}`,
          description: tool.description ?? tool.title ?? tool.name,
          parameters: tool.inputSchema,
        });
      }
    }
    return catalog;
  }

  /* ---------------------------------------------------------------------- */
  /* The agentic loop                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Run one user turn to completion.
   *
   * The loop is the heart of the host: the model may need several rounds of
   * tool calls before it can answer, and each round is a real MCP tools/call to
   * the owning server. maxIterations stops a model that keeps calling tools
   * without ever concluding.
   */
  async chat(userInput: string): Promise<ChatTurn> {
    if (!this.conversation) throw new Error('Host is not started; call start() first');

    const conversation = this.conversation;
    conversation.addUser(userInput);

    const tools = this.toolCatalog;
    const executions: ToolExecution[] = [];

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      this.emit('model:request', iteration);
      const response = await this.provider.complete(conversation.history, tools);
      this.emit('model:response', response);

      conversation.addAssistant(response.content, response.toolCalls);

      if (response.toolCalls.length === 0) {
        return {
          reply: response.content ?? '(the model returned an empty response)',
          executions,
          iterations: iteration,
        };
      }

      // Tools within one turn are independent, so they run concurrently; the
      // results are appended in the model's original order regardless.
      const results = await Promise.all(
        response.toolCalls.map((call) => this.executeToolCall(call)),
      );

      for (const [index, execution] of results.entries()) {
        const call = response.toolCalls[index]!;
        executions.push(execution);
        conversation.addToolResult(call.id, call.name, renderExecution(execution));
      }
    }

    return {
      reply:
        `I stopped after ${this.maxIterations} rounds of tool calls without reaching a final ` +
        `answer. The results gathered so far are in the interaction log.`,
      executions,
      iterations: this.maxIterations,
    };
  }

  /** Route one namespaced tool call to the client that owns it. */
  private async executeToolCall(call: LlmToolCall): Promise<ToolExecution> {
    const startedAt = Date.now();
    const separatorIndex = call.name.indexOf(NAMESPACE_SEPARATOR);

    if (separatorIndex === -1) {
      return {
        server: '(unknown)',
        tool: call.name,
        arguments: call.arguments,
        error: `Tool name "${call.name}" is not namespaced as <server>${NAMESPACE_SEPARATOR}<tool>`,
        durationMs: 0,
      };
    }

    const serverName = call.name.slice(0, separatorIndex);
    const toolName = call.name.slice(separatorIndex + NAMESPACE_SEPARATOR.length);
    const server = this.servers.find((candidate) => candidate.config.name === serverName);

    if (!server) {
      return {
        server: serverName,
        tool: toolName,
        arguments: call.arguments,
        error: `No connected server named "${serverName}"`,
        durationMs: Date.now() - startedAt,
      };
    }

    this.emit('tool:start', serverName, toolName, call.arguments);

    try {
      const result = await server.client.callTool(toolName, call.arguments);
      const execution: ToolExecution = {
        server: serverName,
        tool: toolName,
        arguments: call.arguments,
        result,
        durationMs: Date.now() - startedAt,
      };
      this.emit('tool:end', execution);
      return execution;
    } catch (error) {
      const execution: ToolExecution = {
        server: serverName,
        tool: toolName,
        arguments: call.arguments,
        error: (error as Error).message,
        durationMs: Date.now() - startedAt,
      };
      this.emit('tool:end', execution);
      return execution;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Prompting                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Compose the system prompt from what the servers say about themselves.
   *
   * Forwarding each server's `instructions` is the point: a server ships its own
   * usage guidance through MCP, and the host relays it rather than hard-coding
   * knowledge about any particular server.
   */
  private buildSystemPrompt(): string {
    const sections: string[] = [
      'You are an assistant connected to external tools through the Model Context Protocol (MCP).',
      '',
      'Guidelines:',
      '- Answer general questions directly from your own knowledge; do not call a tool when none is needed.',
      '- When a tool is needed, prefer chaining several small calls over guessing values.',
      '- Never invent identifiers, metrics or file contents: read them with a tool first.',
      '- Report tool failures to the user plainly instead of pretending the call succeeded.',
      '- Answer in the language the user writes in.',
      '',
      `Tool names are namespaced as <server>${NAMESPACE_SEPARATOR}<tool>.`,
      '',
      'Connected MCP servers:',
    ];

    if (this.servers.length === 0) {
      sections.push('  (none - no tools are available in this session)');
    }

    for (const server of this.servers) {
      const description = server.config.description ?? server.client.info?.name ?? '';
      sections.push(`- ${server.config.name} (${server.config.transport}): ${description}`);
      sections.push(
        `  tools: ${server.tools.map((tool) => `${server.config.name}${NAMESPACE_SEPARATOR}${tool.name}`).join(', ')}`,
      );
      const instructions = server.client.serverInstructions;
      if (instructions) {
        sections.push(
          ...instructions.split('\n').map((line) => `  | ${line}`),
        );
      }
    }

    return sections.join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** Flatten MCP content blocks into the plain text the model receives back. */
export function renderContent(content: ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text' && typeof block['text'] === 'string') return block['text'];
      if (block.type === 'resource_link') return `[resource] ${String(block['uri'])}`;
      if (block.type === 'image') return '[image omitted]';
      return JSON.stringify(block);
    })
    .join('\n');
}

function renderExecution(execution: ToolExecution): string {
  if (execution.error) return `ERROR: ${execution.error}`;
  if (!execution.result) return 'ERROR: the tool returned no result';

  const text = renderContent(execution.result.content);
  return execution.result.isError ? `TOOL REPORTED AN ERROR: ${text}` : text;
}
