import * as vscode from 'vscode';
import type { WordCountResult } from './helper/protocol';
import { describeStatus, describeWordCount, type BuildStatus } from './statusText';

export interface StatusBarContext {
  /** Whether a Typst Workshop PDF tab is the active editor. */
  isViewerActive(): boolean;
  /** `typst-workshop.wordCount.statusBar`. */
  wordCountEnabled(): boolean;
}

/** The build item (left) and the word count item (right). The build item shows while a Typst file or a PDF tab is active, or while a build runs or after it failed; the word count item shows with a count, the setting on, and a Typst file or a PDF tab active. */
export class StatusBar implements vscode.Disposable {
  private readonly build: vscode.StatusBarItem;
  private readonly words: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private status: BuildStatus = { kind: 'idle' };
  private hasCount = false;

  constructor(private readonly context: StatusBarContext) {
    this.build = vscode.window.createStatusBarItem('typst-workshop.build', vscode.StatusBarAlignment.Left, -1000);
    this.build.name = 'Typst Workshop Build';
    this.words = vscode.window.createStatusBarItem('typst-workshop.wordCount', vscode.StatusBarAlignment.Right, 100);
    this.words.name = 'Typst Workshop Word Count';
    this.words.command = 'typst-workshop.wordCount';
    this.subscription = vscode.window.onDidChangeActiveTextEditor(() => this.refreshVisibility());
    this.update({ kind: 'idle' });
  }

  update(s: BuildStatus): void {
    this.status = s;
    const d = describeStatus(s);
    this.build.text = d.text;
    this.build.tooltip = d.tooltip;
    this.build.command = d.command;
    this.build.backgroundColor = d.error ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.refreshVisibility();
  }

  setWordCount(r: WordCountResult | undefined, root = '', pdfName = ''): void {
    this.hasCount = r !== undefined;
    if (r) {
      const d = describeWordCount(r, root, pdfName);
      this.words.text = d.text;
      this.words.tooltip = d.tooltip;
    }
    this.refreshVisibility();
  }

  refreshVisibility(): void {
    const relevant = vscode.window.activeTextEditor?.document.languageId === 'typst' || this.context.isViewerActive();
    const busy = this.status.kind === 'building' || this.status.kind === 'failed';
    if (relevant || busy) this.build.show();
    else this.build.hide();
    if (relevant && this.hasCount && this.context.wordCountEnabled()) this.words.show();
    else this.words.hide();
  }

  /** A status bar message for 3 s, for lookups that find nothing. */
  flash(message: string): void {
    vscode.window.setStatusBarMessage(message, 3000);
  }

  dispose(): void {
    this.subscription.dispose();
    this.build.dispose();
    this.words.dispose();
  }
}
