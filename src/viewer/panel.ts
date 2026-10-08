import type * as vscode from 'vscode';
import type { FromViewer, ToViewer } from './messages';

/** A PDF tab: one webview panel showing one PDF file. */
export class PdfPanel {
  constructor(
    readonly pdfPath: string,
    readonly panel: vscode.WebviewPanel,
  ) {}

  post(message: ToViewer): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  onMessage(listener: (message: FromViewer) => void): vscode.Disposable {
    return this.panel.webview.onDidReceiveMessage(listener);
  }

  reveal(preserveFocus: boolean): void {
    this.panel.reveal(this.panel.viewColumn, preserveFocus);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
