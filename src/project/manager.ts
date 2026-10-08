import type { AutoBuildRun } from '../build/autoBuild';
import type { WordCountResult } from '../helper/protocol';
import type { Logger } from '../log';
import { Emitter, type Disposable, type Event } from '../util/emitter';
import { errorText } from '../util/helpers';
import type { BuildOutcome, Project, ProjectPaths } from './project';

function byRecency(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => b.buildSeq - a.buildSeq);
}

/** The open projects, keyed by the entry's absolute path and created on demand. */
export class ProjectManager {
  private readonly projects = new Map<string, Project>();
  private readonly subscriptions = new Map<Project, Disposable[]>();
  private readonly buildEmitter: Emitter<{ project: Project; outcome: BuildOutcome }>;
  private readonly startEmitter: Emitter<{ project: Project; trigger: string }>;
  private readonly countEmitter: Emitter<{ project: Project; result: WordCountResult }>;
  readonly onDidBuild: Event<{ project: Project; outcome: BuildOutcome }>;
  readonly onDidStartBuild: Event<{ project: Project; trigger: string }>;
  readonly onDidCountWords: Event<{ project: Project; result: WordCountResult }>;

  /** Listener errors go to `logger` (or the console without one). */
  constructor(
    private readonly factory: (entry: string) => Project,
    logger?: Logger,
  ) {
    const onError = (what: string) => (err: unknown) => (logger ? logger.error(`${what}: ${errorText(err)}`) : console.error(err));
    this.buildEmitter = new Emitter(onError('A build listener failed'));
    this.startEmitter = new Emitter(onError('A build-start listener failed'));
    this.countEmitter = new Emitter(onError('A word count listener failed'));
    this.onDidBuild = this.buildEmitter.event;
    this.onDidStartBuild = this.startEmitter.event;
    this.onDidCountWords = this.countEmitter.event;
  }

  get(entry: string): Project | undefined {
    return this.projects.get(entry);
  }

  getOrCreate(entry: string): Project {
    let project = this.projects.get(entry);
    if (!project) {
      project = this.factory(entry);
      this.projects.set(entry, project);
      this.subscriptions.set(project, [project.onDidBuild((e) => this.buildEmitter.fire(e)), project.onDidStartBuild((e) => this.startEmitter.fire(e)), project.onDidCountWords((e) => this.countEmitter.fire(e))]);
    }
    return project;
  }

  all(): Project[] {
    return [...this.projects.values()];
  }

  /** The most recently built project writing this PDF. */
  byPdf(pdf: string): Project | undefined {
    return byRecency(this.all().filter((p) => p.pdf === pdf))[0];
  }

  /** Projects whose entry is the file or whose dependency set contains it, most recently built first. */
  projectsContaining(file: string): Project[] {
    return byRecency(this.all().filter((p) => p.entry === file || p.dependencies.has(file)));
  }

  mostRecentFor(file: string): Project | undefined {
    return this.projectsContaining(file)[0];
  }

  /** The candidate entry built most recently, if any of them was built. */
  lastBuiltAmong(entries: string[]): string | undefined {
    const built = entries.map((e) => this.projects.get(e)).filter((p): p is Project => p !== undefined && p.buildSeq > 0);
    return byRecency(built)[0]?.entry;
  }

  stopAll(): void {
    for (const project of this.all()) project.stop();
  }

  /** Applies new paths to every project and shuts their helpers down. Unless `mode` (`autoBuild.run`) is `never`, the projects built before are built again, which starts their helpers; otherwise the helpers start at the next build. */
  async reconfigure(pathsFor: (entry: string) => ProjectPaths, mode: AutoBuildRun): Promise<void> {
    const rebuild = mode !== 'never';
    await Promise.all(this.all().map((p) => p.reconfigure(pathsFor(p.entry), { rebuild })));
  }

  async disposeAll(): Promise<void> {
    const projects = this.all();
    this.projects.clear();
    for (const subs of this.subscriptions.values()) for (const s of subs) s.dispose();
    this.subscriptions.clear();
    await Promise.all(projects.map((p) => p.dispose()));
  }
}
