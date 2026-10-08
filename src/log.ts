/** Logging used across the extension; backed by the "Typst Workshop" log output channel. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
}

/** The parts of `vscode.LogOutputChannel` the logger uses. */
export interface LogChannel {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(preserveFocus?: boolean): void;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** The most recent log lines, kept in memory as `<level>: <message>`; the integration tests read them through the extension's API. */
export class LogTap {
  private readonly kept: string[] = [];

  constructor(private readonly limit = 500) {}

  record(level: LogLevel, message: string): void {
    this.kept.push(`${level}: ${message}`);
    if (this.kept.length > this.limit) this.kept.splice(0, this.kept.length - this.limit);
  }

  /** A copy of the kept lines, oldest first. */
  lines(): string[] {
    return [...this.kept];
  }
}

/** A logger writing to `channel`; with a `tap`, every line is also kept in memory. */
export function createLogger(channel: LogChannel, tap?: LogTap): Logger {
  const write = (level: LogLevel) => (message: string) => {
    tap?.record(level, message);
    channel[level](message);
  };
  return {
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    show: () => channel.show(true),
  };
}

/** A logger that keeps its lines in memory (tests). */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    show: () => {},
  };
}
