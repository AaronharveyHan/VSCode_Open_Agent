import * as vscode from 'vscode';

/**
 * Shows ✨ Ask Claude | 🔧 Fix | 📖 Explain CodeLens above
 * functions, classes, and methods in the active editor.
 */
export class InlineActionProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // Regex patterns to detect function/class definitions per language
  private static readonly PATTERNS: Record<string, RegExp> = {
    typescript:  /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+\w+|class\s+\w+|\w+\s*[=:]\s*(async\s+)?\(|(?:public|private|protected|static|async)\s+\w+\s*\()/,
    javascript:  /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+\w+|class\s+\w+|\w+\s*[=:]\s*(async\s+)?\()/,
    python:      /^\s*(async\s+)?def\s+\w+|^\s*class\s+\w+/,
    java:        /^\s*(public|private|protected|static|final|abstract|synchronized)[\s\w<>\[\]]+\s+\w+\s*\(/,
    go:          /^\s*func\s+/,
    rust:        /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
    cpp:         /^\s*[\w:*&<>]+\s+\w+\s*\([^;]*$/,
    c:           /^\s*[\w*]+\s+\w+\s*\([^;]*$/,
    csharp:      /^\s*(public|private|protected|internal|static|virtual|override|async)\s+[\w<>\[\]]+\s+\w+\s*\(/,
    php:         /^\s*(public|private|protected|static|abstract|final)?\s*function\s+\w+/,
    ruby:        /^\s*def\s+\w+/,
    swift:       /^\s*(public|private|internal|open|fileprivate)?\s*(static|class)?\s*func\s+\w+/,
    kotlin:      /^\s*(fun\s+\w+|class\s+\w+|object\s+\w+)/,
  };

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('claudeAgent');
    if (!config.get<boolean>('enableCodeLens', true)) return [];

    const lang = document.languageId;
    const pattern = InlineActionProvider.PATTERNS[lang];
    if (!pattern) return [];

    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      if (line.isEmptyOrWhitespace) continue;
      if (!pattern.test(line.text)) continue;

      const range = new vscode.Range(i, 0, i, line.text.length);

      // ✨ Ask Claude — opens chat with selected symbol context
      lenses.push(new vscode.CodeLens(range, {
        title: '✨ Ask Claude',
        command: 'claudeAgent.askAboutSymbol',
        arguments: [document, range]
      }));

      // 📖 Explain
      lenses.push(new vscode.CodeLens(range, {
        title: '📖 Explain',
        command: 'claudeAgent.explainSymbol',
        arguments: [document, range]
      }));

      // 🔧 Fix
      lenses.push(new vscode.CodeLens(range, {
        title: '🔧 Fix',
        command: 'claudeAgent.fixSymbol',
        arguments: [document, range]
      }));
    }

    return lenses;
  }

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }
}

/**
 * Extract a meaningful code block starting from the given line.
 * Reads up to maxLines or until indentation returns to base level.
 */
export function extractSymbolBlock(
  document: vscode.TextDocument,
  startLine: number,
  maxLines = 60
): string {
  const lines: string[] = [];
  const baseLine = document.lineAt(startLine).text;
  const baseIndent = baseLine.match(/^\s*/)?.[0].length ?? 0;

  for (let i = startLine; i < Math.min(startLine + maxLines, document.lineCount); i++) {
    const line = document.lineAt(i);
    lines.push(line.text);
    // Stop if we return to base indent (block ended), but always grab at least 3 lines
    if (i > startLine + 2 && !line.isEmptyOrWhitespace) {
      const indent = line.text.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent && i > startLine) break;
    }
  }

  return lines.join('\n');
}
