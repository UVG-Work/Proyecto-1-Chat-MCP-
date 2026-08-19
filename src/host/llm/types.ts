/**
 * Provider-neutral chat types.
 *
 * The host speaks these types; each adapter translates them into whatever its
 * provider expects. Keeping the seam explicit means swapping OpenRouter for
 * another provider touches one file, and it keeps MCP concepts (tool schemas,
 * tool results) from leaking provider-specific shapes into the host.
 */

import type { JsonSchemaObject } from '../../mcp/types.js';

/** A tool offered to the model, already flattened from its MCP definition. */
export interface LlmTool {
  /** Namespaced as "<server>__<tool>" so two servers can expose the same name. */
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

/** A tool invocation the model asked for. */
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
  /** Assistant prose, if any. Null when the turn is purely tool calls. */
  content: string | null;
  toolCalls: LlmToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmProvider {
  /** Identifier shown in the UI, e.g. the model slug. */
  readonly model: string;
  complete(messages: ChatMessage[], tools: LlmTool[]): Promise<LlmResponse>;
}
