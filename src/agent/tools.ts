import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  // Set by write_file / apply_patch before user confirmation
  proposedWrite?: {
    absPath: string;
    relPath: string;
    content: string;
  };
}

// ─── Tool Schemas (sent to Claude) ────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Use relative paths from workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file from workspace root' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file with new content. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to write' },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to a file. Prefer this over write_file for small changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to patch' },
        patch: { type: 'string', description: 'Unified diff patch string (--- a/file, +++ b/file format)' }
      },
      required: ['path', 'patch']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: workspace root)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' }
      },
      required: []
    }
  },
  {
    name: 'search_code',
    description: 'Search for a string or pattern across all workspace files.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex pattern to search for' },
        filePattern: { type: 'string', description: 'Glob pattern to filter files (e.g. "**/*.ts")' }
      },
      required: ['query']
    }
  }
] as const;

export type ToolName = typeof TOOL_DEFINITIONS[number]['name'];

// ─── Tool Executor ─────────────────────────────────────────────────────────────

export class ToolExecutor {
  private workspaceRoot: string;

  constructor() {
    const folders = vscode.workspace.workspaceFolders;
    this.workspaceRoot = folders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private resolve(relativePath: string): string {
    return path.resolve(this.workspaceRoot, relativePath || '.');
  }

  async execute(toolName: ToolName, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'read_file': return this.readFile(input.path as string);
        case 'write_file': return this.writeFile(input.path as string, input.content as string);
        case 'apply_patch': return this.applyPatch(input.path as string, input.patch as string);
        case 'list_directory': return this.listDirectory(input.path as string, input.recursive as boolean);
        case 'search_code': return this.searchCode(input.query as string, input.filePattern as string);
        default:
          return { success: false, output: '', error: `Unknown tool: ${toolName}` };
      }
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  }

  private readFile(filePath: string): ToolResult {
    const abs = this.resolve(filePath);
    if (!fs.existsSync(abs)) {
      return { success: false, output: '', error: `File not found: ${filePath}` };
    }
    const content = fs.readFileSync(abs, 'utf-8');
    return { success: true, output: content };
  }

  // Called by AgentRunner after user approves the diff
  async commitWrite(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const edit = new vscode.WorkspaceEdit();

    if (fs.existsSync(absPath)) {
      // File exists — replace entire content via WorkspaceEdit (undoable)
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      edit.replace(uri, fullRange, content);
    } else {
      // New file — create parent dirs first, then use createFile
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      edit.createFile(uri, { overwrite: true });
      // createFile makes an empty file; follow up with a replace
      edit.insert(uri, new vscode.Position(0, 0), content);
    }

    await vscode.workspace.applyEdit(edit);

    // Open the file so user sees the result
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
  }

  private writeFile(filePath: string, content: string): ToolResult {
    const abs = this.resolve(filePath);
    // Don't write yet — return proposedWrite for diff preview
    return {
      success: true,
      output: `Proposed write to: ${filePath}`,
      proposedWrite: { absPath: abs, relPath: filePath, content }
    };
  }

  private applyPatch(filePath: string, patch: string): ToolResult {
    const abs = this.resolve(filePath);

    // Apply patch in-memory using a line-based algorithm
    const proposed = applyUnifiedPatch(
      fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '',
      patch
    );

    if (proposed === null) {
      return { success: false, output: '', error: `Failed to apply patch to ${filePath}` };
    }

    return {
      success: true,
      output: `Proposed patch to: ${filePath}`,
      proposedWrite: { absPath: abs, relPath: filePath, content: proposed }
    };
  }

  private listDirectory(dirPath: string, recursive: boolean): ToolResult {
    const abs = this.resolve(dirPath || '.');
    if (!fs.existsSync(abs)) {
      return { success: false, output: '', error: `Directory not found: ${dirPath}` };
    }

    const list = (dir: string, prefix = '', depth = 0): string[] => {
      if (recursive && depth > 5) return [];
      return fs.readdirSync(dir).flatMap(entry => {
        if (entry.startsWith('.') || entry === 'node_modules') return [];
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        const line = `${prefix}${stat.isDirectory() ? '📁' : '📄'} ${entry}`;
        if (stat.isDirectory() && recursive) {
          return [line, ...list(full, prefix + '  ', depth + 1)];
        }
        return [line];
      });
    };

    return { success: true, output: list(abs).join('\n') };
  }

  private searchCode(query: string, filePattern?: string): ToolResult {
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      const flags = filePattern ? `--include="${filePattern}"` : '';
      const result = execSync(
        `grep -rn "${query.replace(/"/g, '\\"')}" ${flags} --exclude-dir=node_modules --exclude-dir=.git .`,
        { cwd: this.workspaceRoot, maxBuffer: 1024 * 512 }
      ).toString();
      return { success: true, output: result || '(no matches)' };
    } catch {
      return { success: true, output: '(no matches)' };
    }
  }
}

// ─── Pure JS unified diff applier (Windows-compatible, no shell needed) ───────

/**
 * Apply a unified diff patch string to originalContent.
 * Returns the patched string, or null if the patch cannot be applied.
 *
 * Processes each hunk line-by-line in order:
 *   ' ' context → advance cursor on result
 *   '-' removal → delete line at cursor
 *   '+' addition → insert line at cursor, advance
 */
function applyUnifiedPatch(originalContent: string, patch: string): string | null {
  const result: string[] = originalContent.split('\n');
  const patchLines = patch.split('\n');

  let i = 0;
  let offset = 0; // cumulative shift from previous hunks

  while (i < patchLines.length) {
    // Find next hunk header: @@ -origStart,origCount +newStart,newCount @@
    const hunkMatch = patchLines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!hunkMatch) { i++; continue; }

    // origStart is 1-indexed; convert to 0-indexed, then apply offset
    const origStart0 = parseInt(hunkMatch[1], 10) - 1;
    let cursor = origStart0 + offset; // current position in `result`
    i++;

    // Process hunk body line by line
    while (
      i < patchLines.length &&
      !patchLines[i].startsWith('@@') &&
      !patchLines[i].startsWith('diff ')
    ) {
      const hunkLine = patchLines[i];
      const op = hunkLine[0];       // ' ' | '-' | '+'
      const text = hunkLine.slice(1); // line content without prefix

      if (op === ' ') {
        // Context line — just advance cursor
        cursor++;
      } else if (op === '-') {
        // Remove this line from result
        result.splice(cursor, 1);
        offset--;
        // cursor stays (next line slides into position)
      } else if (op === '+') {
        // Insert new line at cursor
        result.splice(cursor, 0, text);
        offset++;
        cursor++;
      }
      // Ignore '\\' (no newline at end of file markers) and other lines
      i++;
    }
  }

  return result.join('\n');
}


