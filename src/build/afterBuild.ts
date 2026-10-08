import * as path from 'node:path';
import type { WorkshopConfig } from '../config';
import type { CompileResult, HelperDiagnostic } from '../helper/protocol';
import type { Logger } from '../log';
import type { BuildOutcome, Project } from '../project/project';
import type { StatusBar } from '../statusBar';
import { statusAfterBuild } from '../statusText';
import { errorText } from '../util/helpers';

/** What the steps after a build act on; `extension.ts` provides them. */
export interface AfterBuildDeps {
  /** The settings for the project's entry file. */
  config(project: Project): WorkshopConfig;
  status: Pick<StatusBar, 'update' | 'setWordCount'>;
  diagnostics: { publish(project: Project, diagnostics: HelperDiagnostic[], enabled: boolean): void };
  viewers: { buildFinished(pdf: string, written: boolean): Promise<void> };
  /** The popup for a failed build (`message.error.show`). */
  showFailure(project: Project, detail: string): void;
  /** Sync after build (`sync.afterBuild`). */
  syncAfterBuild(project: Project, config: WorkshopConfig): Promise<void>;
  logger: Logger;
}

function failureDetail(result: CompileResult): string {
  const first = result.diagnostics.find((d) => d.severity === 'error');
  return first ? first.message : 'see the log';
}

/** The steps after a build: the status item first, then the diagnostics, the open tabs of the PDF, the error popup, the word count and sync after build, each on its own so that one failing step does not hold back the others. The tabs of the PDF hear of the build's end whatever happens before, so that none keeps waiting. `pdf` is the PDF the build wrote, as it was when the build started. */
export async function afterBuild(project: Project, outcome: BuildOutcome, pdf: string, deps: AfterBuildDeps): Promise<void> {
  const result = outcome.result;
  let cfg: WorkshopConfig;
  try {
    cfg = deps.config(project);
    deps.status.update(statusAfterBuild(project.entry, outcome));
    if (result) {
      try {
        deps.diagnostics.publish(project, result.diagnostics, cfg.diagnosticsEnabled);
      } catch (err) {
        deps.logger.error(`Publishing the diagnostics of ${path.basename(project.entry)} failed: ${errorText(err)}`);
      }
    }
  } finally {
    await deps.viewers.buildFinished(pdf, result?.pdfWritten === true);
  }
  if (outcome.stopped) return;
  if (!result) {
    if (cfg.errorPopup) deps.showFailure(project, outcome.error ?? 'see the log');
    return;
  }
  if (!result.success) {
    if (cfg.errorPopup) deps.showFailure(project, failureDetail(result));
    return;
  }
  if (cfg.wordCountStatusBar) {
    try {
      deps.status.setWordCount(await project.wordCount(), project.root, path.basename(project.pdf));
    } catch (err) {
      deps.logger.warn(`Word count failed: ${errorText(err)}`);
    }
  }
  if (cfg.syncAfterBuild) await deps.syncAfterBuild(project, cfg);
}
