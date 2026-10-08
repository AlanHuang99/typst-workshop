import * as path from 'node:path';
import { BuildScheduler } from '../build/scheduler';
import type { HelperClient } from '../helper/client';
import type { CompileResult, ForwardParams, ForwardResult, InverseParams, SourceLocation, WordCountResult } from '../helper/protocol';
import type { Logger } from '../log';
import { Emitter, type Disposable, type Event } from '../util/emitter';
import { errorText, plural } from '../util/helpers';

export interface ProjectPaths {
  entry: string;
  root: string;
  pdf: string;
  fontPaths: string[];
  inputs: Record<string, string>;
}

export interface BuildOutcome {
  /** What caused the build, e.g. `save`, `file change`, `manual`; merged requests are joined with `, `. */
  trigger: string;
  /** When the build finished. */
  at: Date;
  result?: CompileResult;
  /** Set when the helper could not compile (it is missing, crashed, timed out or failed to initialize). */
  error?: string;
  /** Set when Stop Build ended the build. */
  stopped?: boolean;
}

export interface ProjectDeps {
  createClient(): HelperClient;
  logger: Logger;
  /** Quiet period before an automatic build (`typst-workshop.autoBuild.delay`). */
  delayMs(): number;
  /** A reason not to start the helper at all (for example a missing binary), checked before each build. */
  preflight?(): string | undefined;
}

let finishedBuilds = 0;

/** One entry file with its helper process, dependency set, last build result and build scheduler. The helper is initialized once per process and again after it ended. */
export class Project {
  readonly entry: string;
  /** The files the last compilations read (replaced after a success, extended after a failure). */
  dependencies = new Set<string>();
  lastOutcome?: BuildOutcome;
  lastSuccessAt?: Date;
  /** The word count of the last successful build, once one was requested; cleared when a newer build succeeds. */
  lastWordCount?: WordCountResult;
  /** Increases with every finished build of any project; orders projects by how recently they were built (0 = never). */
  buildSeq = 0;

  private paths: ProjectPaths;
  private client: HelperClient | undefined;
  private clientExit: Disposable | undefined;
  private initialized = false;
  private initializing: { client: HelperClient; done: Promise<void> } | undefined;
  /** Whether the current helper process holds a successfully compiled document for lookups. */
  private documentReady = false;
  private triggers: string[] = [];
  private stopRequested = false;
  private disposed = false;
  private readonly scheduler: BuildScheduler;
  private readonly startEmitter: Emitter<{ project: Project; trigger: string }>;
  private readonly buildEmitter: Emitter<{ project: Project; outcome: BuildOutcome }>;
  private readonly countEmitter: Emitter<{ project: Project; result: WordCountResult }>;
  readonly onDidStartBuild: Event<{ project: Project; trigger: string }>;
  readonly onDidBuild: Event<{ project: Project; outcome: BuildOutcome }>;
  /** A word count arrived (after a build, or for Count Words). */
  readonly onDidCountWords: Event<{ project: Project; result: WordCountResult }>;

  constructor(
    paths: ProjectPaths,
    private readonly deps: ProjectDeps,
  ) {
    this.entry = paths.entry;
    this.paths = paths;
    this.startEmitter = new Emitter((err) => this.report('A build-start listener failed', err));
    this.buildEmitter = new Emitter((err) => this.report('A build listener failed', err));
    this.countEmitter = new Emitter((err) => this.report('A word count listener failed', err));
    this.onDidStartBuild = this.startEmitter.event;
    this.onDidBuild = this.buildEmitter.event;
    this.onDidCountWords = this.countEmitter.event;
    this.scheduler = new BuildScheduler(
      () => this.runBuild(),
      () => deps.delayMs(),
      (err) => this.report('A build failed', err),
    );
  }

  get pdf(): string {
    return this.paths.pdf;
  }

  get root(): string {
    return this.paths.root;
  }

  get building(): boolean {
    return this.scheduler.building;
  }

  /** An automatic build after the quiet period. */
  requestAuto(trigger: string): void {
    if (this.disposed) return;
    this.addTrigger(trigger);
    this.scheduler.requestAuto();
  }

  /** A build now (or right after the running one); resolves with the outcome of the latest build. */
  async buildNow(trigger: string): Promise<BuildOutcome> {
    if (this.disposed) return { trigger, at: new Date(), error: 'the project was closed' };
    this.addTrigger(trigger);
    await this.scheduler.requestNow();
    return this.lastOutcome ?? { trigger, at: new Date(), error: 'no build ran' };
  }

  async inverse(p: InverseParams): Promise<SourceLocation | null> {
    return (await this.ready()).request('inverse', p);
  }

  async forward(p: ForwardParams): Promise<ForwardResult> {
    return (await this.ready()).request('forward', p);
  }

  /** The helper answers from its last successful document, so the count belongs to the last successful build: the helper handles requests in order, and a count that arrives after a build's result was taken after that build. */
  async wordCount(): Promise<WordCountResult> {
    const result = await (await this.ready()).request('wordCount', {});
    this.lastWordCount = result;
    this.countEmitter.fire({ project: this, result });
    return result;
  }

  /** Whether the running helper holds a successfully compiled document (lookups need one). */
  hasSuccessfulBuild(): boolean {
    return this.documentReady;
  }

  /** True when the running helper holds a successful document, building first when it does not (the helper answers lookups only after a successful compile). */
  async ensureBuilt(trigger: string): Promise<boolean> {
    if (this.documentReady) return true;
    await this.buildNow(trigger);
    return this.documentReady;
  }

  /** Stop Build: drops pending builds and kills the helper; the next build starts a new one. */
  stop(): void {
    this.scheduler.cancel();
    this.triggers = [];
    if (this.scheduler.building) this.stopRequested = true;
    this.client?.kill();
  }

  /** New root, PDF, fonts or inputs: the helper is shut down and starts again with these paths at the next build. A build it interrupts is reported as stopped. With `rebuild`, a project that was built before is built again. */
  async reconfigure(paths: ProjectPaths, options: { rebuild: boolean }): Promise<void> {
    this.paths = { ...paths, entry: this.entry };
    if (this.scheduler.building) this.stopRequested = true;
    await this.dropClient();
    if (options.rebuild && this.buildSeq > 0 && !this.disposed) this.requestAuto('settings change');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    await this.dropClient();
    this.startEmitter.dispose();
    this.buildEmitter.dispose();
    this.countEmitter.dispose();
  }

  private addTrigger(trigger: string): void {
    if (!this.triggers.includes(trigger)) this.triggers.push(trigger);
  }

  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.clientExit?.dispose();
    this.clientExit = undefined;
    this.initialized = false;
    this.initializing = undefined;
    this.documentReady = false;
    await client?.dispose();
  }

  private currentClient(): HelperClient {
    if (this.disposed) throw new Error('the project was closed');
    if (!this.client) {
      const client = this.deps.createClient();
      this.client = client;
      this.initialized = false;
      this.documentReady = false;
      this.clientExit = client.onDidExit(() => {
        if (this.client !== client) return;
        this.initialized = false;
        this.initializing = undefined;
        this.documentReady = false;
      });
    }
    return this.client;
  }

  /** The client with an initialized helper process. */
  private async ready(): Promise<HelperClient> {
    const client = this.currentClient();
    if (!this.initialized) {
      if (this.initializing?.client !== client) {
        const { root, entry, pdf, fontPaths, inputs } = this.paths;
        const done = client.request('initialize', { root, main: entry, output: pdf, fontPaths, inputs }).then(() => {
          if (this.client === client) this.initialized = true;
        });
        const pending = { client, done };
        this.initializing = pending;
        void done.then(
          () => this.initializing === pending && (this.initializing = undefined),
          () => this.initializing === pending && (this.initializing = undefined),
        );
      }
      await this.initializing!.done;
    }
    return client;
  }

  /** Logs an error that would otherwise be lost (the logger itself failing goes to the console). */
  private report(what: string, err: unknown): void {
    try {
      this.deps.logger.error(`${what} (${path.basename(this.entry)}): ${errorText(err)}`);
    } catch {
      console.error(err);
    }
  }

  /** One build. Whatever happens, it ends with `lastOutcome` set and `onDidBuild` fired, so the status item, diagnostics and tabs settle. */
  private async runBuild(): Promise<void> {
    const trigger = this.triggers.join(', ') || 'build';
    this.triggers = [];
    this.stopRequested = false;
    const name = path.basename(this.entry);
    let outcome: BuildOutcome | undefined;
    try {
      this.startEmitter.fire({ project: this, trigger });
      this.deps.logger.info(`Building ${name} (${trigger})`);
      const problem = this.deps.preflight?.();
      if (problem !== undefined) throw new Error(problem);
      const client = await this.ready();
      const result = await client.request('compile', {});
      if (result.success) {
        this.dependencies = new Set(result.dependencies);
        this.lastWordCount = undefined;
        if (this.client === client) this.documentReady = true;
      } else {
        for (const dep of result.dependencies) this.dependencies.add(dep);
      }
      outcome = { trigger, at: new Date(), result };
      if (result.success) this.lastSuccessAt = outcome.at;
    } catch (err) {
      outcome = this.stopRequested
        ? { trigger, at: new Date(), error: 'the build was stopped', stopped: true }
        : { trigger, at: new Date(), error: errorText(err) };
    } finally {
      const settled = outcome ?? { trigger, at: new Date(), error: 'the build ended unexpectedly' };
      this.stopRequested = false;
      this.lastOutcome = settled;
      this.buildSeq = ++finishedBuilds;
      try {
        this.logOutcome(name, settled);
      } catch (err) {
        this.report('Logging the build failed', err);
      }
      this.buildEmitter.fire({ project: this, outcome: settled });
    }
  }

  private logOutcome(name: string, o: BuildOutcome): void {
    const log = this.deps.logger;
    if (o.stopped) return log.info(`Build of ${name} stopped`);
    if (o.error !== undefined || !o.result) return log.error(`Build of ${name} failed: ${o.error ?? 'no result'}`);
    const r = o.result;
    const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = r.diagnostics.length - errors;
    const seconds = (r.durationMs / 1000).toFixed(2);
    const extra = warnings > 0 ? `, ${plural(warnings, 'warning')}` : '';
    if (r.success) {
      const pages = r.pageCount === null ? '' : `, ${plural(r.pageCount, 'page')}`;
      log.info(`Built ${name} in ${seconds} s${pages}${extra}`);
    } else {
      log.warn(`Build of ${name} failed in ${seconds} s: ${plural(errors, 'error')}${extra}`);
    }
  }
}
