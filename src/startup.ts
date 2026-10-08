import type { Logger } from './log';
import { errorText } from './util/helpers';

/** The error message for an extension that could not start. A copy of the extension that is still running in the window (an older version, or one that was just replaced) makes the new copy fail when it registers the PDF tab's serializer. */
export function startupFailureMessage(err: unknown): string {
  return `Typst Workshop could not start: ${errorText(err)}. If another copy of Typst Workshop is installed or was just updated, reload the window (Developer: Reload Window).`;
}

export interface StartupReport {
  logger: Logger;
  showError(message: string): void;
}

/** Runs `start`. A failure is logged with its stack, shown as an error message, and thrown again, so that VS Code also records the failed activation. */
export async function guardStartup<T>(start: () => Promise<T>, report: StartupReport): Promise<T> {
  try {
    return await start();
  } catch (err) {
    report.logger.error(`Activation failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    report.showError(startupFailureMessage(err));
    throw err;
  }
}
