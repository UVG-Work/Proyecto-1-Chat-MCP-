// The host: owns one client per MCP server, merges their tools, and runs the model/tool loop.

import { EventEmitter } from 'node:events';

import type { McpClient } from '../mcp/client.js';
import type { InteractionLog } from '../mcp/log.js';
import type { CallToolResult, ContentBlock, Tool } from '../mcp/types.js';
import { enabledServers, loadHostConfig, type ServerConfig } from './config.js';
import { connectServer } from './connect.js';
import type { ChatMessage, LlmProvider, LlmTool, LlmToolCall } from './llm/types.js';
import { Conversation } from './conversation.js';

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
  reply: string;
  executions: ToolExecution[];
  iterations: number;
}

export interface HostOptions {
  provider: LlmProvider;
  log: InteractionLog;
  configPath?: string;
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
