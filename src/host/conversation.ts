/**
 * Conversation state (project requirement 2).
 *
 * The chatbot has to keep context within a session: asking "Who was Alan
 * Turing?" and then "What date was he born?" must resolve the second question
 * against the first. That works because the entire message history is replayed
 * to the model on every turn - language models are stateless, so "memory" here
 * is simply what we choose to resend.
 */

import type { ChatMessage, LlmToolCall } from './llm/types.js';

export interface ConversationOptions {
  systemPrompt: string;
  /**
   * Maximum non-system messages to retain. Older turns are dropped once the
   * history exceeds this, which bounds both cost and context length on a long
   * session.
   */
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

  /** Full history as sent to the model: the system prompt plus every turn. */
  get history(): ChatMessage[] {
    return [{ role: 'system', content: this.systemPrompt }, ...this.messages];
  }

  /** Turns only, without the system prompt - what the UI renders. */
  get turns(): ChatMessage[] {
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  /**
   * Drop the oldest turns when the history grows too long.
   *
   * A tool result must never survive without the assistant message that
   * requested it - providers reject a tool message whose tool_call_id has no
   * matching call - so after trimming we walk forward past any orphaned tool
   * messages left at the front.
   */
  private trim(): void {
    if (this.messages.length <= this.maxMessages) return;

    let start = this.messages.length - this.maxMessages;
    while (start < this.messages.length && this.messages[start]?.role === 'tool') {
      start += 1;
    }
    this.messages = this.messages.slice(start);
  }
}
