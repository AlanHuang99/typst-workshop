import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WordCountResult } from './helper/protocol';
import type { Project } from './project/project';
import { formatWords } from './statusText';
import { errorText } from './util/helpers';

interface FileItem extends vscode.QuickPickItem {
  path: string;
}

export const NO_WORD_COUNT = 'No word count: the build failed';

/** The Count Words command: builds first if needed, then a Quick Pick titled `6,543 words in Manuscript.pdf` with each file and its count; picking a file opens it. */
export async function showWordCount(project: Project, root: string): Promise<void> {
  const pdfName = path.basename(project.pdf);
  if (!(await project.ensureBuilt('word count'))) {
    vscode.window.setStatusBarMessage(NO_WORD_COUNT, 3000);
    return;
  }
  let result: WordCountResult;
  try {
    result = await project.wordCount();
  } catch (err) {
    void vscode.window.showWarningMessage(`Typst Workshop: no word count: ${errorText(err)}`);
    return;
  }
  const items: FileItem[] = result.files.map((f) => ({ label: path.relative(root, f.path) || path.basename(f.path), description: formatWords(f.words), path: f.path }));
  const picked = await vscode.window.showQuickPick(items, { title: `${formatWords(result.total)} in ${pdfName}`, placeHolder: 'Open a file' });
  if (picked) await vscode.window.showTextDocument(vscode.Uri.file(picked.path));
}
