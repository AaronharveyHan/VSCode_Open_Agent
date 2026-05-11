import * as vscode from 'vscode';
import { ChatPanel } from './ui/ChatPanel';
import { registerProposedContentProvider } from './agent/DiffPreview';
import { InlineActionProvider, extractSymbolBlock } from './ui/InlineActionProvider';
import { ClaudeCodeActionProvider } from './ui/CodeActionProvider';

let chatPanelProvider: ChatPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('Claude Agent: activate() called');

  try {
    registerProposedContentProvider(context);

    chatPanelProvider = new ChatPanel(context.extensionUri, context);

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ChatPanel.viewType,
        chatPanelProvider,
        { webviewOptions: { retainContextWhenHidden: false } }
      )
    );

    // ── CodeLens Provider (✨ Ask Claude above functions) ──────────────────────
    const codeLensProvider = new InlineActionProvider();
    const ALL_LANGS = [
      'typescript', 'javascript', 'python', 'java', 'go', 'rust',
      'cpp', 'c', 'csharp', 'php', 'ruby', 'swift', 'kotlin',
      'typescriptreact', 'javascriptreact'
    ];
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        ALL_LANGS.map(lang => ({ language: lang })),
        codeLensProvider
      )
    );

    // Refresh CodeLens when config changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeAgent.enableCodeLens')) {
          codeLensProvider.refresh();
        }
      })
    );

    // ── Code Action Provider (💡 lightbulb on selection) ──────────────────────
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        ALL_LANGS.map(lang => ({ language: lang })),
        new ClaudeCodeActionProvider(),
        { providedCodeActionKinds: ClaudeCodeActionProvider.providedCodeActionKinds }
      )
    );

    console.log('Claude Agent: WebView provider registered');
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Agent activation failed: ${String(err)}`);
    console.error('Claude Agent activation error:', err);
    return;
  }

  // ── Helper: get code context from editor ────────────────────────────────────
  function getEditorContext(
    docArg?: vscode.TextDocument,
    rangeArg?: vscode.Range
  ): { code: string; lang: string; file: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    const doc = docArg ?? editor?.document;
    if (!doc) return undefined;

    const lang = doc.languageId;
    const file = vscode.workspace.asRelativePath(doc.uri);

    let code: string;
    if (rangeArg) {
      code = extractSymbolBlock(doc, rangeArg.start.line);
    } else if (editor && !editor.selection.isEmpty) {
      code = doc.getText(editor.selection);
    } else {
      return undefined;
    }

    return { code, lang, file };
  }

  // ── Commands ─────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.openChat', () => {
      vscode.commands.executeCommand('claudeAgent.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.runPrompt', async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: 'What should the agent do?',
        placeHolder: 'e.g. Add type hints to all functions in utils.py',
        ignoreFocusOut: true
      });
      if (!prompt?.trim()) return;
      await chatPanelProvider?.sendMessage(prompt.trim());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.editWithInstruction', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Open a file first.'); return; }
      const instruction = await vscode.window.showInputBox({
        prompt: 'How should this file be modified?',
        placeHolder: 'e.g. Add error handling to all async functions',
        ignoreFocusOut: true
      });
      if (!instruction?.trim()) return;
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      await chatPanelProvider?.sendMessage(`Edit \`${file}\`: ${instruction.trim()}`);
    })
  );

  // Explain — works from right-click, CodeLens, or CodeAction
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.explainSelection',
      async (doc?: vscode.TextDocument, range?: vscode.Range) => {
        const ctx = getEditorContext(doc, range);
        if (!ctx) { vscode.window.showWarningMessage('Select some code first.'); return; }
        const prompt = `Explain this ${ctx.lang} code from \`${ctx.file}\`:\n\n\`\`\`${ctx.lang}\n${ctx.code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Fix
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.fixSelection',
      async (doc?: vscode.TextDocument, range?: vscode.Range) => {
        const ctx = getEditorContext(doc, range);
        if (!ctx) { vscode.window.showWarningMessage('Select some code first.'); return; }
        const prompt = `Fix any bugs or issues in this ${ctx.lang} code from \`${ctx.file}\` and explain what you changed:\n\n\`\`\`${ctx.lang}\n${ctx.code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Explain symbol (CodeLens)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.explainSymbol',
      async (doc: vscode.TextDocument, range: vscode.Range) => {
        const code = extractSymbolBlock(doc, range.start.line);
        const lang = doc.languageId;
        const file = vscode.workspace.asRelativePath(doc.uri);
        const prompt = `Explain this ${lang} function/class from \`${file}\`:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Fix symbol (CodeLens)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.fixSymbol',
      async (doc: vscode.TextDocument, range: vscode.Range) => {
        const code = extractSymbolBlock(doc, range.start.line);
        const lang = doc.languageId;
        const file = vscode.workspace.asRelativePath(doc.uri);
        const prompt = `Fix any bugs or issues in this ${lang} code from \`${file}\`:\n\n\`\`\`${lang}\n${code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Ask about symbol (CodeLens — open-ended)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.askAboutSymbol',
      async (doc: vscode.TextDocument, range: vscode.Range) => {
        const instruction = await vscode.window.showInputBox({
          prompt: 'What do you want to ask Claude about this code?',
          placeHolder: 'e.g. How can I make this more efficient?',
          ignoreFocusOut: true
        });
        if (!instruction?.trim()) return;
        const code = extractSymbolBlock(doc, range.start.line);
        const lang = doc.languageId;
        const file = vscode.workspace.asRelativePath(doc.uri);
        const prompt = `${instruction.trim()}\n\nCode from \`${file}\`:\n\`\`\`${lang}\n${code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Ask about selection (CodeAction)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.askAboutSelection',
      async (doc?: vscode.TextDocument, range?: vscode.Range) => {
        const instruction = await vscode.window.showInputBox({
          prompt: 'What do you want to ask Claude?',
          placeHolder: 'e.g. What does this do? How can I improve it?',
          ignoreFocusOut: true
        });
        if (!instruction?.trim()) return;
        const ctx = getEditorContext(doc, range);
        if (!ctx) return;
        const prompt = `${instruction.trim()}\n\nCode from \`${ctx.file}\`:\n\`\`\`${ctx.lang}\n${ctx.code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Refactor (CodeAction)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.refactorSelection',
      async (doc?: vscode.TextDocument, range?: vscode.Range) => {
        const ctx = getEditorContext(doc, range);
        if (!ctx) return;
        const prompt = `Refactor this ${ctx.lang} code from \`${ctx.file}\` to improve readability, performance, and maintainability. Show the refactored version and explain the changes:\n\n\`\`\`${ctx.lang}\n${ctx.code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Write tests (CodeAction)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgent.writeTestsForSelection',
      async (doc?: vscode.TextDocument, range?: vscode.Range) => {
        const ctx = getEditorContext(doc, range);
        if (!ctx) return;
        const prompt = `Write comprehensive unit tests for this ${ctx.lang} code from \`${ctx.file}\`:\n\n\`\`\`${ctx.lang}\n${ctx.code}\n\`\`\``;
        await chatPanelProvider?.sendMessage(prompt);
      }
    )
  );

  // Show welcome message on first install
  const hasShownWelcome = context.globalState.get('claudeAgent.welcomed');
  if (!hasShownWelcome) {
    vscode.window.showInformationMessage(
      'Claude Agent is ready! Set your API key in settings to get started.',
      'Open Settings'
    ).then(action => {
      if (action === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'claudeAgent.apiKey');
      }
    });
    context.globalState.update('claudeAgent.welcomed', true);
  }

  console.log('Claude Agent: fully activated ✓');
}

export function deactivate(): void {
  console.log('Claude Agent deactivated');
}

