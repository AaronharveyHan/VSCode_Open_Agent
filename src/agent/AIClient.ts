import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TOOL_DEFINITIONS } from './tools';

export interface Message {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlock[];
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onToolUse: (toolName: string, input: Record<string, unknown>) => Promise<string>;
  onDone: () => void;
  onError: (err: Error) => void;
}

type Provider = 'anthropic' | 'openai';

// ─── Config helper ─────────────────────────────────────────────────────────────

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('claudeAgent');
  return {
    provider: cfg.get<Provider>('provider') ?? 'anthropic',
    anthropicKey: cfg.get<string>('apiKey') || process.env.ANTHROPIC_API_KEY || '',
    openaiKey: cfg.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY || '',
    baseUrl: cfg.get<string>('baseUrl') || '',   // 兼容阿里云百炼/Azure等第三方端点
    model: cfg.get<string>('model') || 'claude-opus-4-5',
    maxTokens: cfg.get<number>('maxTokens') ?? 8192
  };
}

// ─── Anthropic backend ────────────────────────────────────────────────────────

async function runAnthropicLoop(
  client: Anthropic,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  history: Message[],
  callbacks: StreamCallbacks,
  signal: AbortSignal
): Promise<Message[]> {
  const mutableHistory = [...history];

  while (true) {
    if (signal.aborted) break;

    let fullText = '';
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let stopReason = 'end_turn';

    const stream = await client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
      messages: mutableHistory as Anthropic.MessageParam[]
    });

    // Abort handler: cancel the stream
    const onAbort = () => stream.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const event of stream) {
        if (signal.aborted) break;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          callbacks.onText(event.delta.text);
          fullText += event.delta.text;
        } else if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason || 'end_turn';
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    if (signal.aborted) break;

    const finalMsg = await stream.finalMessage();
    for (const block of finalMsg.content) {
      if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }

    mutableHistory.push({ role: 'assistant', content: finalMsg.content });

    if (stopReason !== 'tool_use' || toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      if (signal.aborted) break;
      const result = await callbacks.onToolUse(tool.name, tool.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
    }
    if (signal.aborted) break;
    mutableHistory.push({ role: 'user', content: toolResults as unknown as Anthropic.ContentBlock[] });
  }

  return mutableHistory;
}

// ─── OpenAI backend ───────────────────────────────────────────────────────────

// Convert our tool definitions to OpenAI function-calling format
const OPENAI_TOOLS: OpenAI.ChatCompletionTool[] = TOOL_DEFINITIONS.map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema as unknown as Record<string, unknown>
  }
}));

type OAIMessage = OpenAI.ChatCompletionMessageParam;

function toOAIHistory(messages: Message[], system: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        result.push({ role: 'user', content: m.content });
      } else {
        // tool results block
        for (const block of m.content as Anthropic.ContentBlock[]) {
          if ((block as unknown as { type: string }).type === 'tool_result') {
            const tr = block as unknown as { tool_use_id: string; content: string };
            result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
          }
        }
      }
    } else {
      // assistant — may have text + tool_use blocks
      if (typeof m.content === 'string') {
        result.push({ role: 'assistant', content: m.content });
      } else {
        const blocks = m.content as Anthropic.ContentBlock[];
        const textBlock = blocks.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;
        const toolBlocks = blocks.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        result.push({
          role: 'assistant',
          content: textBlock?.text || null,
          tool_calls: toolBlocks.length > 0
            ? toolBlocks.map(tb => ({
                id: tb.id,
                type: 'function' as const,
                function: { name: tb.name, arguments: JSON.stringify(tb.input) }
              }))
            : undefined
        });
      }
    }
  }
  return result;
}

async function runOpenAILoop(
  client: OpenAI,
  model: string,
  maxTokens: number,
  systemPrompt: string,
  history: Message[],
  callbacks: StreamCallbacks,
  signal: AbortSignal
): Promise<Message[]> {
  const mutableHistory = [...history];

  while (true) {
    if (signal.aborted) break;

    const oaiMessages = toOAIHistory(mutableHistory, systemPrompt);

    const stream = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      tools: OPENAI_TOOLS,
      tool_choice: 'auto',
      stream: true,
      messages: oaiMessages
    }, { signal });

    let fullText = '';
    const toolCallAccumulator: Record<string, { id: string; name: string; args: string }> = {};
    let finishReason = 'stop';

    for await (const chunk of stream) {
      if (signal.aborted) break;
      const choice = chunk.choices[0];
      if (!choice) continue;

      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta;

      if (delta.content) {
        callbacks.onText(delta.content);
        fullText += delta.content;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = String(tc.index);
          if (!toolCallAccumulator[idx]) {
            toolCallAccumulator[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
          }
          if (tc.id) toolCallAccumulator[idx].id = tc.id;
          if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallAccumulator[idx].args += tc.function.arguments;
        }
      }
    }

    if (signal.aborted) break;

    const toolCalls = Object.values(toolCallAccumulator);

    // Record assistant turn in our history (Anthropic format for uniformity)
    const assistantBlocks: Anthropic.ContentBlock[] = [];
    if (fullText) assistantBlocks.push({ type: 'text', text: fullText });
    for (const tc of toolCalls) {
      assistantBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: JSON.parse(tc.args || '{}')
      });
    }
    mutableHistory.push({ role: 'assistant', content: assistantBlocks });

    if (finishReason !== 'tool_calls' || toolCalls.length === 0) break;

    // Execute tools
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tc of toolCalls) {
      if (signal.aborted) break;
      const input = JSON.parse(tc.args || '{}') as Record<string, unknown>;
      const result = await callbacks.onToolUse(tc.name, input);
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
    }
    mutableHistory.push({ role: 'user', content: toolResults as unknown as Anthropic.ContentBlock[] });
  }

  return mutableHistory;
}

// ─── Unified AIClient ─────────────────────────────────────────────────────────

export class AIClient {
  private provider: Provider;
  private anthropicClient?: Anthropic;
  private openaiClient?: OpenAI;
  private model: string;
  private maxTokens: number;

  constructor() {
    const cfg = getConfig();
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens;

    if (this.provider === 'anthropic') {
      if (!cfg.anthropicKey) throw new Error('No Anthropic API key. Set claudeAgent.apiKey or ANTHROPIC_API_KEY.');
      this.anthropicClient = new Anthropic({ apiKey: cfg.anthropicKey });
    } else {
      if (!cfg.openaiKey) throw new Error('No OpenAI API key. Set claudeAgent.openaiApiKey or OPENAI_API_KEY.');
      this.openaiClient = new OpenAI({
        apiKey: cfg.openaiKey,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {})
      });
    }
  }

  get providerName(): string {
    return this.provider === 'anthropic' ? `Claude (${this.model})` : `OpenAI (${this.model})`;
  }

  async runAgentLoop(
    messages: Message[],
    callbacks: StreamCallbacks,
    systemPrompt: string,
    signal: AbortSignal
  ): Promise<Message[]> {
    try {
      if (this.provider === 'anthropic') {
        return await runAnthropicLoop(
          this.anthropicClient!, this.model, this.maxTokens, systemPrompt, messages, callbacks, signal
        );
      } else {
        return await runOpenAILoop(
          this.openaiClient!, this.model, this.maxTokens, systemPrompt, messages, callbacks, signal
        );
      }
    } catch (err) {
      // Silently ignore abort errors — user intentionally cancelled
      const isAbort = signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort')));
      if (!isAbort) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
      return messages;
    } finally {
      callbacks.onDone();
    }
  }
}
