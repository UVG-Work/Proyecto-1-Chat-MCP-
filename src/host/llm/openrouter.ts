// OpenRouter provider adapter over the OpenAI-compatible chat completions API.

import OpenAI from 'openai';

import type { ChatMessage, LlmProvider, LlmResponse, LlmTool, LlmToolCall } from './types.js';

const DEFAULT_MODEL = 'anthropic/claude-3.5-haiku';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  appUrl?: string;
  appTitle?: string;
  temperature?: number;
}

export class OpenRouterProvider implements LlmProvider {
  readonly model: string;
  private readonly client: OpenAI;
  private readonly temperature: number;

  constructor(options: OpenRouterOptions = {}) {
    const apiKey = options.apiKey ?? process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not set. Copy .env.example to .env and add a key from ' +
          'https://openrouter.ai/keys',
      );
    }

    this.model = options.model ?? process.env['OPENROUTER_MODEL'] ?? DEFAULT_MODEL;
    this.temperature = options.temperature ?? 0.2;

    this.client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': options.appUrl ?? process.env['OPENROUTER_APP_URL'] ?? '',
        'X-Title': options.appTitle ?? process.env['OPENROUTER_APP_TITLE'] ?? 'MCP Chat Host',
      },
    });
  }

  async complete(messages: ChatMessage[], tools: LlmTool[]): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.temperature,
      messages: messages.map(toOpenAiMessage),
      // Omit the field entirely when there are no tools: some models reject an
      // empty array outright.
      ...(tools.length > 0 ? { tools: tools.map(toOpenAiTool) } : {}),
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error(`Model "${this.model}" returned no choices`);
    }

    const message = choice.message;
    const toolCalls: LlmToolCall[] = [];

    for (const call of message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        // Arguments arrive as a JSON string the model generated, so malformed
        // JSON is a realistic outcome rather than an impossible one. Surface it
        // as an argument the tool will reject, instead of crashing the turn.
        arguments: safeParseArguments(call.function.arguments),
      });
    }

    const result: LlmResponse = {
      content: message.content ?? null,
      toolCalls,
    };

    if (response.usage) {
      result.usage = {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      };
    }

    return result;
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { __invalid_arguments: raw };
  } catch {
    return { __invalid_arguments: raw };
  }
}

function toOpenAiTool(tool: LlmTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };
}

function toOpenAiMessage(
  message: ChatMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };

    case 'user':
      return { role: 'user', content: message.content };

    case 'assistant': {
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: message.content,
      };
      if (message.toolCalls && message.toolCalls.length > 0) {
        assistant.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
      }
      return assistant;
    }

    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}
