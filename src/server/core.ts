// Transport-agnostic MCP server core: tool registry and JSON-RPC dispatch.

import {
  JsonRpcError,
  isNotification,
  isRequest,
  makeError,
  makeSuccess,
} from '../mcp/jsonrpc.js';
import {
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpMethod,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type Implementation,
  type JsonRpcMessage,
  type JsonSchemaObject,
  type ServerCapabilities,
  type Tool,
  type ToolAnnotations,
} from '../mcp/types.js';

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

export interface McpServerOptions {
  info: Implementation;
  instructions?: string;
}

export class McpServer {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly info: Implementation;
  private readonly instructions: string | undefined;

  constructor(options: McpServerOptions) {
    this.info = options.info;
    this.instructions = options.instructions;
  }

  registerTool(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    this.tools.set(definition.name, definition);
  }

  get capabilities(): ServerCapabilities {
    // listChanged is false: this catalogue is fixed at startup.
    return { tools: { listChanged: false } };
  }

  listToolDescriptors(): Tool[] {
    return [...this.tools.values()].map(({ handler: _handler, ...descriptor }) => descriptor);
  }

  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    if (isNotification(message)) {
      // notifications/initialized completes the handshake; nothing to answer.
      return null;
    }

    if (!isRequest(message)) {
      // A response arriving at a server that never sent a request is a protocol
      // violation, but silence is the correct handling.
      return null;
    }

    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      return makeSuccess(message.id, result);
    } catch (error) {
      if (error instanceof JsonRpcError) {
        return makeError(message.id, error.code, error.message, error.data);
      }
      return makeError(
        message.id,
        JsonRpcErrorCode.InternalError,
        `Internal error: ${(error as Error).message}`,
      );
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case McpMethod.Initialize:
        return this.handleInitialize(params);

      case McpMethod.Ping:
        // The spec defines ping as an empty request with an empty result.
        return {};

      case McpMethod.ToolsList:
        return { tools: this.listToolDescriptors() };

      case McpMethod.ToolsCall:
        return (await this.handleToolCall(params)) as unknown as Record<string, unknown>;

      default:
        throw JsonRpcError.methodNotFound(method);
    }
  }

  private handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
    const requested = params['protocolVersion'];
    const agreed =
      typeof requested === 'string' &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    const result: Record<string, unknown> = {
      protocolVersion: agreed,
      capabilities: this.capabilities,
      serverInfo: this.info,
    };
    if (this.instructions) result['instructions'] = this.instructions;
    return result;
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<CallToolResult> {
    const name = params['name'];
    if (typeof name !== 'string') {
      throw JsonRpcError.invalidParams('"name" must be a string');
    }

    const tool = this.tools.get(name);
    if (!tool) {
      // An unknown tool name is a protocol-level error, unlike a tool that runs
      // and fails - which returns isError instead.
      throw JsonRpcError.invalidParams(`Unknown tool "${name}"`);
    }

    const args = params['arguments'];
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw JsonRpcError.invalidParams('"arguments" must be an object');
    }

    const argumentsObject = (args ?? {}) as Record<string, unknown>;
    validateAgainstSchema(tool.inputSchema, argumentsObject, tool.name);

    try {
      return await tool.handler(argumentsObject);
    } catch (error) {
      // A tool that throws is reported as a tool-level failure, not a JSON-RPC
      // error, so the model can read the message and try something else.
      return textError(`Tool "${name}" failed: ${(error as Error).message}`);
    }
  }
}

export function validateAgainstSchema(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
  toolName: string,
): void {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw JsonRpcError.invalidParams(`${toolName}: missing required argument "${key}"`);
    }
  }

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(args)) {
    const propertySchema = properties[key];
    if (!propertySchema) continue; // unknown extras are tolerated

    const expected = propertySchema['type'];
    if (typeof expected === 'string' && !matchesJsonType(value, expected)) {
      throw JsonRpcError.invalidParams(
        `${toolName}: argument "${key}" must be of type ${expected}, received ${typeof value}`,
      );
    }

    const allowed = propertySchema['enum'];
    if (Array.isArray(allowed) && !allowed.includes(value)) {
      throw JsonRpcError.invalidParams(
        `${toolName}: argument "${key}" must be one of ${allowed.join(', ')}`,
      );
    }
  }
}

function matchesJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

export function toolResult(summary: string, data?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: summary }] };
  if (data) result.structuredContent = data;
  return result;
}

export function textError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
