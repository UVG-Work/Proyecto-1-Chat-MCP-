// Session conversation state replayed to the model on every turn.

import type { ChatMessage, LlmToolCall } from './llm/types.js';

export interface ConversationOptions {
  systemPrompt: string;
  maxMessages?: number;
}

export class Conversation {
  private readonly systemPrompt: string;
  private readonly maxMessages: number;
  private messages: ChatMessage[] = [];

  constructor(options: ConversationOptions) {
    this.systemPrompt = options.systemPrompt;
    this.maxMessages = options.maxMessages ?? 80;
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
    this.trim();
  }

  addAssistant(content: string | null, toolCalls?: LlmToolCall[]): void {
    const message: ChatMessage = { role: 'assistant', content };
    if (toolCalls && toolCalls.length > 0) message.toolCalls = toolCalls;
    this.messages.push(message);
    this.trim();
  }

  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: 'tool', toolCallId, name, content });
    this.trim();
  }

  get history(): ChatMessage[] {
    return [{ role: 'system', content: this.systemPrompt }, ...this.messages];
  }

  get turns(): ChatMessage[] {
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  private trim(): void {
    if (this.messages.length <= this.maxMessages) return;

    let start = this.messages.length - this.maxMessages;
    while (start < this.messages.length && this.messages[start]?.role === 'tool') {
      start += 1;
    }
    this.messages = this.messages.slice(start);
  }
}
