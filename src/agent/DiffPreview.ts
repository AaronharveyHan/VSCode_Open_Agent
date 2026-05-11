import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// In-memory URI scheme for showing "proposed" content without writing to disk
const SCHEME = 'claude-proposed';

/**
 * Provides in-memory file content for the right side of the diff view.
 * Maps key string → proposed content string.
 * Key is stored in URI query to avoid Windows path issues.
 */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private static keyFrom(uri: vscode.Uri): string {
    return uri.query || uri.path;
  }

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(ProposedContentProvider.keyFrom(uri), content);
    this._onDidChange.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    this.contents.delete(ProposedContentProvider.keyFrom(uri));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(ProposedContentProvider.keyFrom(uri)) ?? '';
  }
}

// Singleton provider registered once at extension activation
let provider: ProposedContentProvider | undefined;
let providerDisposable: vscode.Disposable | undefined;

export function registerProposedContentProvider(context: vscode.ExtensionContext): void {
  provider = new ProposedContentProvider();
  providerDisposable = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  context.subscriptions.push(providerDisposable);
}

export interface DiffResult {
  approved: boolean;
  finalContent: string; // the content to actually write (may be edited by user in diff view)
}

/**
 * Show a diff between current file content and proposed content.
 * Opens the native VS Code diff editor and waits for user to Approve or Reject.
 * Returns { approved, finalContent }.
 */
export async function showDiffAndConfirm(
  filePath: string,       // absolute path
  proposedContent: string,
  label: string           // e.g. "utils.py"
): Promise<DiffResult> {
  if (!provider) {
    throw new Error('ProposedContentProvider not registered');
  }

  // Read current content (empty string if new file)
  const currentContent = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';

  // If content identical, skip diff
  if (currentContent === proposedContent) {
    return { approved: true, finalContent: proposedContent };
  }

  // Use a stable numeric key to avoid any path encoding issues (esp. on Windows)
  const key = String(Date.now());

  const proposedUri = vscode.Uri.from({
    scheme: SCHEME,
    path: '/proposed',   // fixed safe path
    query: key
  });
  provider.set(proposedUri, proposedContent);

  const emptyUri = vscode.Uri.from({
    scheme: SCHEME,
    path: '/empty',
    query: key + '_orig'
  });

  const originalUri = fs.existsSync(filePath)
    ? vscode.Uri.file(filePath)
    : emptyUri;

  if (!fs.existsSync(filePath)) {
    provider.set(emptyUri, '');
  }

  // Open diff editor
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    proposedUri,
    `Claude: ${label} (original ↔ proposed)`,
    { preview: true, viewColumn: vscode.ViewColumn.One }
  );

  // Show confirmation dialog
  const choice = await vscode.window.showInformationMessage(
    `Claude wants to write \`${label}\`. Apply this change?`,
    { modal: false },
    'Apply',
    'Reject'
  );

  // Clean up
  provider.delete(proposedUri);
  if (!fs.existsSync(filePath)) provider.delete(emptyUri);

  // Close the diff editor tab
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

  if (choice !== 'Apply') {
    return { approved: false, finalContent: currentContent };
  }

  return { approved: true, finalContent: proposedContent };
}

/**
 * Compute a simple unified-diff-style summary for display in the chat UI.
 * Not a real patch — just +/- line counts for user-facing feedback.
 */
export function diffSummary(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let added = 0;
  let removed = 0;

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  for (const line of newLines) if (!oldSet.has(line)) added++;
  for (const line of oldLines) if (!newSet.has(line)) removed++;

  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} lines`);
  if (removed > 0) parts.push(`-${removed} lines`);
  return parts.length > 0 ? parts.join(', ') : 'no net changes';
}
