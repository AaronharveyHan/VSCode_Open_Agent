import * as vscode from 'vscode';
import { AIClient, Message } from './AIClient';
import { ToolExecutor, ToolName } from './tools';
import { showDiffAndConfirm, diffSummary } from './DiffPreview';

const SYSTEM_PROMPT = `You are an AI coding agent embedded in VS Code.

You have tools to read files, list directories, search code, write files, and apply patches.
Your goal is to help users understand, navigate, and modify their codebase.

## Rules
- Always explore the codebase before making changes (list_directory, read_file)
- Prefer apply_patch for small targeted changes; use write_file for new files or full rewrites
- After modifying files, briefly summarize what changed and why
- Be concise in prose — let code speak for itself
- Never ask unnecessary clarifying questions — act on what you know`;

const HISTORY_KEY = 'claudeAgent.history';
const MAX_HISTORY_MESSAGES = 100; // cap to avoid globalState bloat

export interface AgentCallbacks {
  onAssistantText: (text: string) => void;
  onToolCall: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  onToolResult: (toolName: string, result: string, success: boolean) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

export class AgentRunner {
  private client: AIClient;
  private executor: ToolExecutor;
  private history: Message[] = [];
  private autoApprove: boolean;
  private abortController?: AbortController;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.client = new AIClient();
    this.executor = new ToolExecutor();
    this.autoApprove = vscode.workspace
      .getConfiguration('claudeAgent')
      .get<boolean>('autoApproveTools') ?? false;
    this.history = this.loadHistory();
  }

  get providerLabel(): string {
    return this.client.providerName;
  }

  get isRunning(): boolean {
    return !!this.abortController;
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = undefined;
  }

  clearHistory(): void {
    this.history = [];
    this.context.globalState.update(HISTORY_KEY, []);
  }

  /**
   * Load persisted history from globalState.
   * Only keeps string-content messages (user text + assistant text).
   * Tool-use blocks are stripped to avoid stale references.
   */
  private loadHistory(): Message[] {
    const raw = this.context.globalState.get<Message[]>(HISTORY_KEY, []);
    console.log('[ClaudeAgent] loadHistory raw:', JSON.stringify(
      raw.map(m => ({ role: m.role, type: typeof m.content, isArray: Array.isArray(m.content), len: JSON.stringify(m.content).length }))
    ));
    return raw.slice(-MAX_HISTORY_MESSAGES);
  }

  private saveHistory(): void {
    const toSave = this.history
      .flatMap(m => {
        if (typeof m.content === 'string' && m.content.trim()) {
          return [{ role: m.role, content: m.content }];
        }
        if (Array.isArray(m.content)) {
          const text = (m.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text!)
            .join('');
          return text ? [{ role: m.role, content: text }] : [];
        }
        return [];
      })
      .slice(-MAX_HISTORY_MESSAGES);

    console.log('[ClaudeAgent] saveHistory:', JSON.stringify(
      toSave.map(m => ({ role: m.role, len: (m.content as string).length, preview: (m.content as string).slice(0, 60) }))
    ));

    this.context.globalState.update(HISTORY_KEY, toSave);
  }

  /**
   * Return UI-renderable history: [{role, text}]
   * Handles both string content and ContentBlock[] (assistant streaming format).
   */
  getUIHistory(): Array<{ role: 'user' | 'assistant'; text: string }> {
    const result = this.history.flatMap(m => {
      if (typeof m.content === 'string' && m.content.trim()) {
        return [{ role: m.role, text: m.content }];
      }
      if (Array.isArray(m.content)) {
        const text = (m.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join('');
        return text ? [{ role: m.role, text }] : [];
      }
      return [];
    });
    console.log('[ClaudeAgent] getUIHistory result:', result.map(m => ({ role: m.role, len: m.text.length })));
    return result;
  }

  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    currentFile?: { path: string; content: string; language: string }
  ): Promise<void> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.history.push({ role: 'user', content: userMessage });

    // Build system prompt — optionally inject current file
    const systemPrompt = currentFile
      ? `${SYSTEM_PROMPT}\n\n## Current File\nThe user currently has \`${currentFile.path}\` open in the editor:\n\`\`\`${currentFile.language}\n${currentFile.content}\n\`\`\``
      : SYSTEM_PROMPT;

    this.history = await this.client.runAgentLoop(
      this.history,
      {
        onText: callbacks.onAssistantText,

        onToolUse: async (toolName, input) => {
          if (signal.aborted) return JSON.stringify({ error: 'Cancelled' });

          const isWriteTool = toolName === 'write_file' || toolName === 'apply_patch';
          const approved = this.autoApprove
            ? true
            : await callbacks.onToolCall(toolName, input);

          if (!approved || signal.aborted) {
            return JSON.stringify({ error: signal.aborted ? 'Cancelled' : 'User denied tool execution' });
          }

          const result = await this.executor.execute(toolName as ToolName, input);

          if (!result.success) {
            callbacks.onToolResult(toolName, result.error || 'Failed', false);
            return `ERROR: ${result.error}`;
          }

          if (isWriteTool && result.proposedWrite) {
            const { absPath, relPath, content } = result.proposedWrite;

            if (signal.aborted) return JSON.stringify({ error: 'Cancelled' });

            callbacks.onToolResult(toolName, `Showing diff for ${relPath}…`, true);

            const diffResult = await showDiffAndConfirm(absPath, content, relPath);

            if (!diffResult.approved || signal.aborted) {
              callbacks.onToolResult(toolName, `Rejected: ${relPath}`, false);
              return JSON.stringify({ error: `User rejected changes to ${relPath}` });
            }

            const fs = require('fs') as typeof import('fs');
            const originalContent = fs.existsSync(absPath)
              ? fs.readFileSync(absPath, 'utf-8')
              : '';

            await this.executor.commitWrite(absPath, diffResult.finalContent);

            const summary = diffSummary(originalContent, diffResult.finalContent);
            const msg = `Applied to ${relPath} (${summary})`;
            callbacks.onToolResult(toolName, msg, true);
            return msg;
          }

          callbacks.onToolResult(toolName, result.output || '', true);
          return result.output;
        },

        onDone: () => {
          this.abortController = undefined;
          callbacks.onDone();
        },
        onError: (err) => {
          this.abortController = undefined;
          callbacks.onError(err.message);
        }
      },
      systemPrompt,
      signal
    );

    // Save AFTER history is updated by runAgentLoop's return value
    this.saveHistory();
  }
}
