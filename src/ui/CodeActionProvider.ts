import * as vscode from 'vscode';

/**
 * Provides Claude quick-fix actions in the lightbulb / right-click menu
 * whenever the user has a non-empty selection.
 */
export class ClaudeCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    // Only show when something is selected
    if (range.isEmpty) return [];

    const selectedText = document.getText(range);
    if (!selectedText.trim()) return [];

    const actions: vscode.CodeAction[] = [];

    // ✨ Ask Claude (open-ended)
    const ask = new vscode.CodeAction('✨ Ask Claude about selection', vscode.CodeActionKind.QuickFix);
    ask.command = {
      command: 'claudeAgent.askAboutSelection',
      title: 'Ask Claude',
      arguments: [document, range]
    };
    actions.push(ask);

    // 🔧 Fix with Claude
    const fix = new vscode.CodeAction('🔧 Fix with Claude', vscode.CodeActionKind.QuickFix);
    fix.command = {
      command: 'claudeAgent.fixSelection',
      title: 'Fix with Claude',
      arguments: [document, range]
    };
    fix.isPreferred = true;
    actions.push(fix);

    // 📖 Explain with Claude
    const explain = new vscode.CodeAction('📖 Explain with Claude', vscode.CodeActionKind.QuickFix);
    explain.command = {
      command: 'claudeAgent.explainSelection',
      title: 'Explain with Claude',
      arguments: [document, range]
    };
    actions.push(explain);

    // ♻️ Refactor with Claude
    const refactor = new vscode.CodeAction('♻️ Refactor with Claude', vscode.CodeActionKind.RefactorRewrite);
    refactor.command = {
      command: 'claudeAgent.refactorSelection',
      title: 'Refactor with Claude',
      arguments: [document, range]
    };
    actions.push(refactor);

    // 🧪 Write tests
    const test = new vscode.CodeAction('🧪 Write tests with Claude', vscode.CodeActionKind.QuickFix);
    test.command = {
      command: 'claudeAgent.writeTestsForSelection',
      title: 'Write tests with Claude',
      arguments: [document, range]
    };
    actions.push(test);

    return actions;
  }
}
