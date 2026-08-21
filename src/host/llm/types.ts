// Provider-neutral chat types used by the host.

import type { JsonSchemaObject } from '../../mcp/types.js';

export interface LlmTool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmProvider {
  readonly model: string;
  complete(messages: ChatMessage[], tools: LlmTool[]): Promise<LlmResponse>;
}
