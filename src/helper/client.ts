import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '../log';
import { Emitter, type Event } from '../util/emitter';
import { errorText } from '../util/helpers';
import type { HelperMethod, HelperMethods, HelperResponse } from './protocol';
import { resultProblem } from './validate';

export type HelperErrorKind = 'remote' | 'exit' | 'timeout' | 'spawn';

export class HelperError extends Error {
  constructor(
    readonly kind: HelperErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

export interface HelperExit {
  code: number | null;
  signal: string | null;
}

export interface HelperClientOptions {
  command: string;
  args?: string[];
  logger: Logger;
  /** Milliseconds; defaults: 120 s for `compile` (first compiles may download packages), 10 s for the rest. */
  timeouts?: { compile: number; other: number };
  env?: NodeJS.ProcessEnv;
}

interface Request {
  id: number;
  method: string;
  params: unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** One spawned helper process. */
interface Connection {
  proc: ChildProcessWithoutNullStreams;
  gone: boolean;
  /** Set once we asked the process to end (shutdown, kill), so its exit is not reported as a crash. */
  ending: boolean;
  inFlight?: Request;
  stdout: string;
  stderr: string;
  exited: Promise<void>;
  markExited(): void;
}

/** JSON-line client of `typst-workshop-helper`. The process starts on the first request and again on the first request after it ended. Requests go out one at a time, as the helper answers them in order anyway; the timeout of a request therefore measures the helper's own work on it. A request that times out stops the process. */
export class HelperClient {
  private conn: Connection | undefined;
  private queue: Request[] = [];
  private nextId = 1;
  private disposed = false;
  private readonly timeouts: { compile: number; other: number };
  private readonly exitEmitter: Emitter<HelperExit>;
  readonly onDidExit: Event<HelperExit>;

  constructor(private readonly opts: HelperClientOptions) {
    this.timeouts = opts.timeouts ?? { compile: 120_000, other: 10_000 };
    this.exitEmitter = new Emitter<HelperExit>((err) => opts.logger.error(`A helper exit listener failed: ${errorText(err)}`));
    this.onDidExit = this.exitEmitter.event;
  }

  get running(): boolean {
    return this.conn !== undefined && !this.conn.gone;
  }

  request<M extends HelperMethod>(method: M, params: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']> {
    if (this.disposed) return Promise.reject(new HelperError('exit', 'the helper client was closed'));
    return new Promise<HelperMethods[M]['result']>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, method, params, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  /** Kills the helper process at once (Stop Build); pending requests fail with kind `exit`. */
  kill(): void {
    if (this.conn && !this.conn.gone) this.killConnection(this.conn, 'the helper was stopped');
  }

  /** Asks the helper to shut down, waits up to 1 s, then kills it. The client cannot be used afterwards. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectQueued(new HelperError('exit', 'the helper client was closed'));
    const conn = this.conn;
    if (conn && !conn.gone) {
      conn.ending = true;
      try {
        conn.proc.stdin.write(`${JSON.stringify({ id: this.nextId++, method: 'shutdown', params: {} })}\n`);
        conn.proc.stdin.end();
      } catch {
        // The process is already going away.
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([conn.exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, 1000)))]);
      clearTimeout(timer);
      if (!conn.gone) this.killConnection(conn, 'the helper did not shut down');
    }
    this.exitEmitter.dispose();
  }

  private pump(): void {
    if (this.disposed || this.queue.length === 0) return;
    if (this.conn && !this.conn.gone && this.conn.inFlight) return;
    const conn = this.conn && !this.conn.gone ? this.conn : this.start();
    if (!conn) return;
    const request = this.queue.shift()!;
    conn.inFlight = request;
    const ms = request.method === 'compile' ? this.timeouts.compile : this.timeouts.other;
    request.timer = setTimeout(() => this.onTimeout(conn, request, ms), ms);
    try {
      conn.proc.stdin.write(`${JSON.stringify({ id: request.id, method: request.method, params: request.params })}\n`);
    } catch {
      // A failed write means the process is gone; its exit handler rejects the request.
    }
  }

  private start(): Connection | undefined {
    const { command, args = [], logger } = this.opts;
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(command, args, { env: this.opts.env ?? process.env });
    } catch (err) {
      this.rejectQueued(new HelperError('spawn', `cannot start the helper ${command}: ${errorText(err)}`));
      return undefined;
    }
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    const conn: Connection = { proc, gone: false, ending: false, stdout: '', stderr: '', exited, markExited };
    this.conn = conn;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(conn, chunk));
    proc.stderr.on('data', (chunk: string) => {
      conn.stderr += chunk;
      const lines = conn.stderr.split('\n');
      conn.stderr = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') logger.info(`[helper] ${line.trimEnd()}`);
    });
    proc.stdin.on('error', () => {
      // EPIPE after the process died; the exit handler reports it.
    });
    const failedToStart = (reason: string) => {
      if (conn.gone) return;
      logger.error(`Cannot start the helper ${command}: ${reason}`);
      this.markGone(conn, { code: null, signal: null }, new HelperError('spawn', `cannot start the helper ${command}: ${reason}`));
    };
    proc.on('error', (err) => {
      if (proc.pid === undefined) failedToStart(err.message);
      else logger.warn(`Helper process error: ${err.message}`);
    });
    proc.on('close', (code, signal) => {
      if (conn.stderr.trim() !== '') logger.info(`[helper] ${conn.stderr.trimEnd()}`);
      conn.stderr = '';
      if (proc.pid === undefined) return failedToStart(`exit ${describeExit(code, signal)}`);
      if (!conn.gone && !conn.ending) logger.error(`The helper exited unexpectedly (${describeExit(code, signal)})`);
      this.markGone(conn, { code, signal }, new HelperError('exit', `the helper exited (${describeExit(code, signal)})`));
    });
    return conn;
  }

  private onStdout(conn: Connection, chunk: string): void {
    conn.stdout += chunk;
    let start = 0;
    let nl: number;
    while ((nl = conn.stdout.indexOf('\n', start)) >= 0) {
      this.onLine(conn, conn.stdout.slice(start, nl));
      start = nl + 1;
    }
    conn.stdout = conn.stdout.slice(start);
  }

  private onLine(conn: Connection, raw: string): void {
    const line = raw.trim();
    if (line === '') return;
    let message: HelperResponse;
    try {
      message = JSON.parse(line) as HelperResponse;
    } catch {
      this.opts.logger.warn(`[helper] unexpected output: ${line.slice(0, 300)}`);
      return;
    }
    const request = conn.inFlight;
    if (!request || message.id !== request.id) {
      if ('error' in message) this.opts.logger.warn(`[helper] ${message.error?.message ?? 'error'} (request ${message.id})`);
      else if (!conn.ending) this.opts.logger.warn(`[helper] answer to an unknown request ${message.id}`);
      return;
    }
    conn.inFlight = undefined;
    clearTimeout(request.timer);
    if ('error' in message) {
      request.reject(new HelperError('remote', message.error?.message ?? 'unknown error'));
    } else {
      const problem = resultProblem(request.method, message.result);
      if (problem === undefined) request.resolve(message.result);
      else request.reject(new HelperError('remote', `the helper sent a malformed ${request.method} result: ${problem}`));
    }
    this.pump();
  }

  private onTimeout(conn: Connection, request: Request, ms: number): void {
    if (conn.inFlight !== request) return;
    conn.inFlight = undefined;
    const seconds = `${ms / 1000} s`;
    this.opts.logger.warn(`The helper did not answer ${request.method} within ${seconds}; stopping it`);
    request.reject(new HelperError('timeout', `the helper did not answer ${request.method} within ${seconds}`));
    this.killConnection(conn, `the helper did not answer ${request.method} within ${seconds}`);
  }

  private killConnection(conn: Connection, reason: string): void {
    conn.ending = true;
    try {
      conn.proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    this.markGone(conn, { code: null, signal: 'SIGKILL' }, new HelperError('exit', reason));
  }

  /** The process ended (or was given up): fail its request and everything queued, and report the exit once. */
  private markGone(conn: Connection, exit: HelperExit, error: HelperError): void {
    if (conn.gone) return;
    conn.gone = true;
    if (this.conn === conn) this.conn = undefined;
    const request = conn.inFlight;
    conn.inFlight = undefined;
    if (request) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.rejectQueued(error);
    conn.markExited();
    this.exitEmitter.fire(exit);
  }

  private rejectQueued(error: HelperError): void {
    const queued = this.queue;
    this.queue = [];
    for (const request of queued) request.reject(error);
  }
}

function describeExit(code: number | null, signal: string | null): string {
  return signal ? `signal ${signal}` : `code ${code}`;
}
