import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentRunner } from '../agent/AgentRunner';

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeAgent.chatView';

  private view?: vscode.WebviewView;
  private agent?: AgentRunner;
  private extensionUri: vscode.Uri;
  private context: vscode.ExtensionContext;

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.extensionUri = extensionUri;
    this.context = context;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      console.log('[ClaudeAgent] WebView message received:', msg.type, msg.text?.substring(0, 50) + (msg.text?.length > 50 ? '...' : ''));

      switch (msg.type) {
        case 'sendMessage':
          await this.handleUserMessage(msg.text);
          break;
        case 'stopGeneration':
          this.resolvePendingApproval(false);
          this.agent?.cancel();
          break;
        case 'clearChat':
          this.agent?.clearHistory();
          this.post({ type: 'clearMessages' });
          break;
        case 'approveToolCall':
          this.resolvePendingApproval(msg.approved);
          break;
        case 'requestFileList':
          this.post({ type: 'fileList', files: this.getWorkspaceFiles(msg.query || '') });
          break;
        case 'ready':
          // WebView finished mounting — send persisted history to render
          this.restoreHistory();
          break;
      }
    });
  }

  // Called from commands (e.g. right-click → Explain Selection)
  async sendMessage(text: string): Promise<void> {
    await vscode.commands.executeCommand('claudeAgent.chatView.focus');
    await new Promise(r => setTimeout(r, 300)); // wait for webview to mount
    await this.handleUserMessage(text);
  }

  private pendingApprovalResolve?: (approved: boolean) => void;

  private resolvePendingApproval(approved: boolean): void {
    this.pendingApprovalResolve?.(approved);
    this.pendingApprovalResolve = undefined;
  }

  private async handleUserMessage(text: string): Promise<void> {
    console.log('[ClaudeAgent] handleUserMessage called with text:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));

    const { message, attachments } = await this.resolveAtFiles(text);

    if (this.agent?.isRunning) {
      this.post({ type: 'error', text: 'Agent is busy. Please wait.' });
      return;
    }

    // Read current active editor file for auto-injection
    const currentFile = this.getCurrentFile();

    this.post({ type: 'userMessage', text, attachments, currentFile: currentFile?.path ?? null });
    this.post({ type: 'assistantStart' });

    try {
      if (!this.agent) {
        this.agent = new AgentRunner(this.context);
      }

      await this.agent.run(message, {
        onAssistantText: (delta) => {
          this.post({ type: 'assistantDelta', text: delta });
        },

        onToolCall: async (toolName, input) => {
          this.post({
            type: 'toolCall',
            toolName,
            input: JSON.stringify(input, null, 2)
          });

          const autoApprove = vscode.workspace
            .getConfiguration('claudeAgent')
            .get<boolean>('autoApproveTools');

          if (autoApprove) return true;

          return new Promise<boolean>((resolve) => {
            this.pendingApprovalResolve = resolve;
          });
        },

        onToolResult: (toolName, result, success) => {
          this.post({ type: 'toolResult', toolName, result, success });
        },

        onDone: () => {
          this.post({ type: 'assistantDone' });
        },

        onError: (msg) => {
          this.post({ type: 'error', text: msg });
        }
      }, currentFile);

    } catch (err) {
      this.post({ type: 'assistantDone' });
      this.post({ type: 'error', text: String(err) });
      if (String(err).includes('API key')) {
        this.agent = undefined;
      }
    }
  }

  /**
   * Send persisted history to the WebView to render on startup.
   */
  private restoreHistory(): void {
    if (!this.agent) {
      this.agent = new AgentRunner(this.context);
    }
    const history = this.agent.getUIHistory();
    if (history.length > 0) {
      this.post({ type: 'restoreHistory', history });
    }
  }

  private post(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Read the currently active editor file for auto-injection into system prompt.
   * Returns undefined if disabled or no suitable file is open.
   */
  private getCurrentFile(): { path: string; content: string; language: string } | undefined {
    const config = vscode.workspace.getConfiguration('claudeAgent');
    if (!config.get<boolean>('autoInjectCurrentFile', true)) {
      console.log('[ClaudeAgent] autoInjectCurrentFile disabled');
      return undefined;
    }

    const editor = vscode.window.activeTextEditor;
    console.log('[ClaudeAgent] activeTextEditor:', editor?.document.uri.fsPath ?? 'none');

    if (!editor) return undefined;

    const doc = editor.document;
    if (doc.isUntitled) return undefined;

    const content = doc.getText();
    if (content.length > 500_000) return undefined;

    const result = {
      path: vscode.workspace.asRelativePath(doc.uri),
      content,
      language: doc.languageId
    };
    console.log('[ClaudeAgent] currentFile injected:', result.path, 'lang:', result.language, 'len:', content.length);
    return result;
  }

  /**
   * Parse @file references in text, read their contents, and return an
   * enriched message with file contents appended as context blocks.
   */
  private async resolveAtFiles(text: string): Promise<{
    message: string;
    attachments: Array<{ path: string; found: boolean }>;
  }> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const refs = [...text.matchAll(/@([\w./\\-]+)/g)];

    if (refs.length === 0) {
      return { message: text, attachments: [] };
    }

    const attachments: Array<{ path: string; found: boolean }> = [];
    const blocks: string[] = [];

    for (const match of refs) {
      const relPath = match[1];
      const absPath = path.resolve(workspaceRoot, relPath);

      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        const content = fs.readFileSync(absPath, 'utf-8');
        const lang = path.extname(relPath).slice(1) || '';
        blocks.push(`### ${relPath}\n\`\`\`${lang}\n${content}\n\`\`\``);
        attachments.push({ path: relPath, found: true });
      } else {
        attachments.push({ path: relPath, found: false });
      }
    }

    const enriched = blocks.length > 0
      ? `${text}\n\n---\n**Attached files:**\n\n${blocks.join('\n\n')}`
      : text;

    return { message: enriched, attachments };
  }

  /**
   * Return workspace file paths matching a query prefix, for @-autocomplete.
   * Excludes node_modules, .git, and binary files.
   */
  private getWorkspaceFiles(query: string): string[] {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!workspaceRoot) return [];

    const results: string[] = [];
    const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '__pycache__', '.venv']);
    const SKIP_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
      '.woff', '.ttf', '.eot', '.mp4', '.zip', '.vsix', '.lock']);

    const walk = (dir: string, prefix: string) => {
      if (results.length > 100) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (!SKIP_EXTS.has(path.extname(entry.name).toLowerCase())) {
          if (!query || rel.toLowerCase().includes(query.toLowerCase())) {
            results.push(rel);
          }
        }
      }
    };

    walk(workspaceRoot, '');
    return results.slice(0, 50);
  }

  private getHtml(_webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'webview', 'chat.html');
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath, 'utf-8');
    }
    // Should never happen in a properly packaged extension
    return `<!DOCTYPE html><html><body>
      <p style="color:red;font-family:monospace;padding:16px">
        Error: webview/chat.html not found at ${htmlPath}
      </p></body></html>`;
  }
}