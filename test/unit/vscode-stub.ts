// Minimal stand-in for the `vscode` module in unit tests (aliased in vitest.config.ts). Extend as tests need more of the API.
// Tests drive it through `testHooks` (imported from this file directly), which fires workspace events and records what the code under test created.
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {}
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static parse(value: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):(?:\/\/)?(.*)$/i.exec(value);
    return m ? new Uri(m[1], m[2]) : new Uri('file', value);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, nodePath.posix.join(base.fsPath, ...segments));
  }
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
    } else {
      this.start = new Position(startLine as number, startCharacter as number);
      this.end = new Position(endLine ?? (startLine as number), endCharacter ?? (startCharacter as number));
    }
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Location {
  constructor(readonly uri: Uri, readonly range: Range) {}
}

export class DiagnosticRelatedInformation {
  constructor(readonly location: Location, readonly message: string) {}
}

export class Diagnostic {
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error) {}
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// Documents and editors.

/** A text document with the parts of the API the extension uses. */
export class FakeDocument {
  isDirty = false;
  version = 1;
  saved = 0;
  constructor(
    readonly uri: Uri,
    private text: string,
    readonly languageId = uri.fsPath.endsWith('.typ') ? 'typst' : 'plaintext',
  ) {}
  get fileName(): string {
    return this.uri.fsPath;
  }
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
    this.version++;
  }
  private get lines(): string[] {
    return this.text.split(/\r\n|\n|\r/);
  }
  get lineCount(): number {
    return this.lines.length;
  }
  lineAt(line: number): { text: string } {
    return { text: this.lines[line] ?? '' };
  }
  async save(): Promise<boolean> {
    this.saved++;
    this.isDirty = false;
    return true;
  }
}

export class FakeDecorationType {
  disposed = false;
  constructor(readonly options: unknown) {}
  dispose(): void {
    this.disposed = true;
  }
}

/** A text editor with the parts of the API the extension uses. */
export class FakeTextEditor {
  selection = new Selection(new Position(0, 0), new Position(0, 0));
  readonly reveals: { range: Range; type?: TextEditorRevealType }[] = [];
  readonly decorations: { type: FakeDecorationType; ranges: Range[] }[] = [];
  constructor(
    readonly document: FakeDocument,
    public viewColumn: number | undefined = 1,
  ) {}
  revealRange(range: Range, type?: TextEditorRevealType): void {
    this.reveals.push({ range, type });
  }
  setDecorations(type: FakeDecorationType, ranges: Range[]): void {
    this.decorations.push({ type, ranges });
  }
}

// Diagnostics, language features.

export class FakeDiagnosticCollection {
  readonly entries = new Map<string, Diagnostic[]>();
  constructor(readonly name: string) {}
  set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void {
    if (diagnostics === undefined || diagnostics.length === 0) this.entries.delete(uri.toString());
    else this.entries.set(uri.toString(), [...diagnostics]);
  }
  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }
  get(uri: Uri): Diagnostic[] | undefined {
    return this.entries.get(uri.toString());
  }
  clear(): void {
    this.entries.clear();
  }
  dispose(): void {
    this.entries.clear();
  }
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: SymbolKind,
    readonly range: Range,
    readonly selectionRange: Range,
  ) {}
}

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3,
}

export class FoldingRange {
  constructor(readonly start: number, readonly end: number, readonly kind?: FoldingRangeKind) {}
}

export class DocumentLink {
  tooltip?: string;
  constructor(readonly range: Range, readonly target?: Uri) {}
}

export interface RegisteredProvider {
  kind: 'symbols' | 'folding' | 'links';
  selector: unknown;
  provider: any;
  disposed: boolean;
}

function registerProvider(kind: RegisteredProvider['kind'], selector: unknown, provider: unknown): Disposable {
  const entry: RegisteredProvider = { kind, selector, provider, disposed: false };
  testHooks.providers.push(entry);
  return new Disposable(() => {
    entry.disposed = true;
  });
}

export const languages = {
  createDiagnosticCollection(name: string): FakeDiagnosticCollection {
    return new FakeDiagnosticCollection(name);
  },
  registerDocumentSymbolProvider: (selector: unknown, provider: unknown) => registerProvider('symbols', selector, provider),
  registerFoldingRangeProvider: (selector: unknown, provider: unknown) => registerProvider('folding', selector, provider),
  registerDocumentLinkProvider: (selector: unknown, provider: unknown) => registerProvider('links', selector, provider),
};

const extensionsEmitter = new EventEmitter<void>();

export const extensions = {
  getExtension(id: string): { id: string } | undefined {
    return testHooks.installedExtensions.includes(id) ? { id } : undefined;
  },
  onDidChange: extensionsEmitter.event,
};

// Webview panels.

export class FakeWebview {
  html = '';
  options: unknown;
  readonly cspSource = 'vscode-webview://fake';
  readonly posted: any[] = [];
  private readonly receive = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.receive.event;
  asWebviewUri(uri: Uri): Uri {
    return Uri.parse(`vscode-webview://fake${uri.fsPath}`);
  }
  async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return true;
  }
  /** A message from the page. */
  send(message: unknown): void {
    this.receive.fire(message);
  }
}

export class FakeWebviewPanel {
  readonly webview = new FakeWebview();
  active = false;
  visible = true;
  disposed = false;
  readonly reveals: { column?: number; preserveFocus?: boolean }[] = [];
  private readonly disposeEmitter = new EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  private readonly viewStateEmitter = new EventEmitter<{ webviewPanel: FakeWebviewPanel }>();
  readonly onDidChangeViewState = this.viewStateEmitter.event;
  constructor(
    readonly viewType: string,
    public title: string,
    readonly showOptions: unknown,
    readonly options: unknown,
    public viewColumn: number | undefined = 2,
  ) {
    this.webview.options = options;
  }
  reveal(column?: number, preserveFocus?: boolean): void {
    this.reveals.push({ column, preserveFocus });
  }
  setActive(active: boolean): void {
    this.active = active;
    this.viewStateEmitter.fire({ webviewPanel: this });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeEmitter.fire();
  }
}

// Window.

const activeEditorEmitter = new EventEmitter<FakeTextEditor | undefined>();

export const window = {
  activeTextEditor: undefined as FakeTextEditor | undefined,
  onDidChangeActiveTextEditor: activeEditorEmitter.event,
  createStatusBarItem(id: string, alignment: StatusBarAlignment = StatusBarAlignment.Left, priority?: number): FakeStatusBarItem {
    const item = new FakeStatusBarItem(id, alignment, priority);
    testHooks.statusBarItems.push(item);
    return item;
  },
  setStatusBarMessage(text: string, timeout?: number): Disposable {
    testHooks.statusMessages.push({ text, timeout });
    return new Disposable(() => {});
  },
  async showQuickPick<T>(items: readonly T[] | Promise<readonly T[]>, options?: { title?: string; placeHolder?: string }): Promise<T | undefined> {
    const list = await items;
    testHooks.quickPicks.push({ items: list as unknown[], options });
    return testHooks.quickPickAnswer(list as unknown[]) as T | undefined;
  },
  async showTextDocument(target: Uri | FakeDocument, options?: { viewColumn?: number; preserveFocus?: boolean }): Promise<FakeTextEditor> {
    const document = target instanceof Uri ? await workspace.openTextDocument(target) : target;
    const editor = new FakeTextEditor(document, options?.viewColumn ?? 1);
    testHooks.shownDocuments.push({ uri: document.uri, options, editor });
    if (!options?.preserveFocus) testHooks.setActiveEditor(editor);
    return editor;
  },
  createTextEditorDecorationType(options: unknown): FakeDecorationType {
    const type = new FakeDecorationType(options);
    testHooks.decorationTypes.push(type);
    return type;
  },
  createWebviewPanel(viewType: string, title: string, showOptions: unknown, options: unknown): FakeWebviewPanel {
    const panel = new FakeWebviewPanel(viewType, title, showOptions, options);
    testHooks.panels.push(panel);
    return panel;
  },
  registerWebviewPanelSerializer(viewType: string, serializer: { deserializeWebviewPanel(panel: FakeWebviewPanel, state: unknown): Promise<void> }): Disposable {
    testHooks.serializers.set(viewType, serializer);
    return new Disposable(() => testHooks.serializers.delete(viewType));
  },
  async showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
    testHooks.messages.push({ level: 'warning', message, items });
    return undefined;
  },
  async showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
    testHooks.messages.push({ level: 'error', message, items });
    return undefined;
  },
  async showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
    testHooks.messages.push({ level: 'info', message, items });
    return undefined;
  },
  async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    testHooks.inputBoxes.push(options ?? {});
    return testHooks.inputBoxAnswer(options ?? {});
  },
  createTreeView(id: string, options: { treeDataProvider: any }): FakeTreeView {
    const view = new FakeTreeView(id, options.treeDataProvider);
    testHooks.treeViews.push(view);
    return view;
  },
};

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  value?: string;
  validateInput?(value: string): string | undefined | null;
}

/** A tree view; tests call its provider's `getChildren` as VS Code would. */
export class FakeTreeView {
  visible = false;
  disposed = false;
  constructor(
    readonly id: string,
    readonly provider: any,
  ) {}
  dispose(): void {
    this.disposed = true;
  }
}

// Commands.

export const commands = {
  registerCommand(id: string, handler: (...args: any[]) => unknown): Disposable {
    testHooks.commands.set(id, handler);
    return new Disposable(() => testHooks.commands.delete(id));
  },
  /** Records the call and runs the handler registered for it, if any. */
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    testHooks.executedCommands.push({ id, args });
    return testHooks.commands.get(id)?.(...args);
  },
};

// Status bar.

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class FakeStatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  backgroundColor: ThemeColor | undefined;
  visible = false;
  disposed = false;
  constructor(readonly id: string, readonly alignment: StatusBarAlignment, readonly priority: number | undefined) {}
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.disposed = true;
    this.visible = false;
  }
}

// Workspace: folders, documents, configuration, saves, renames and file watchers.

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export class RelativePattern {
  readonly baseUri: Uri;
  constructor(base: Uri | string | WorkspaceFolder, readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
  }
  get base(): string {
    return this.baseUri.fsPath;
  }
}

export class FakeFileSystemWatcher {
  private readonly emitters = { create: new EventEmitter<Uri>(), change: new EventEmitter<Uri>(), delete: new EventEmitter<Uri>() };
  readonly onDidCreate = this.emitters.create.event;
  readonly onDidChange = this.emitters.change.event;
  readonly onDidDelete = this.emitters.delete.event;
  disposed = false;
  constructor(readonly pattern: RelativePattern | string) {}
  fire(kind: 'create' | 'change' | 'delete', path: string): void {
    if (!this.disposed) this.emitters[kind].fire(Uri.file(path));
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A small glob matcher for paths relative to a folder: `**` (any number of segments), `*` and `?` (within a segment), `{a,b}` (alternatives). */
export function globToRegExp(glob: string): RegExp {
  const source = (g: string): string => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else if (c === '*') {
        re += '[^/]*';
      } else if (c === '?') {
        re += '[^/]';
      } else if (c === '{') {
        const close = g.indexOf('}', i);
        re += `(?:${g
          .slice(i + 1, close)
          .split(',')
          .map(source)
          .join('|')})`;
        i = close;
      } else {
        re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
      }
    }
    return re;
  };
  return new RegExp(`^${source(glob)}$`);
}

/** Every file under `base` matching `include` and not `exclude` (both relative globs), as VS Code's findFiles does. */
function findOnDisk(base: string, include: string, exclude: string | undefined, max: number): Uri[] {
  const wanted = globToRegExp(include);
  const unwanted = exclude ? globToRegExp(exclude) : undefined;
  const out: Uri[] = [];
  const walk = (dir: string) => {
    for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max) return;
      const p = nodePath.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = nodePath.relative(base, p).split(nodePath.sep).join('/');
      if (wanted.test(rel) && !unwanted?.test(rel)) out.push(Uri.file(p));
    }
  };
  walk(base);
  return out;
}

const saveEmitter = new EventEmitter<FakeDocument>();
const foldersEmitter = new EventEmitter<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }>();
const renameEmitter = new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>();
const configEmitter = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

export const workspace = {
  workspaceFolders: undefined as WorkspaceFolder[] | undefined,
  get textDocuments(): FakeDocument[] {
    return testHooks.documents;
  },
  onDidSaveTextDocument: saveEmitter.event,
  onDidChangeWorkspaceFolders: foldersEmitter.event,
  onDidRenameFiles: renameEmitter.event,
  onDidChangeConfiguration: configEmitter.event,
  createFileSystemWatcher(pattern: RelativePattern | string): FakeFileSystemWatcher {
    const watcher = new FakeFileSystemWatcher(pattern);
    testHooks.watchers.push(watcher);
    return watcher;
  },
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return (workspace.workspaceFolders ?? []).find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(`${f.uri.fsPath}/`));
  },
  getConfiguration(section?: string, scope?: unknown) {
    const fullKey = (key: string) => (section ? `${section}.${key}` : key);
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const full = fullKey(key);
        return full in testHooks.config ? (testHooks.config[full] as T) : fallback;
      },
      /** The levels set in `testHooks.configLevels`. */
      inspect(key: string): { key: string; globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } {
        const full = fullKey(key);
        return { key: full, ...testHooks.configLevels[full] };
      },
      /** Records the write and sets the value (firing onDidChangeConfiguration); `testHooks.configUpdateError` makes it fail. */
      async update(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
        if (testHooks.configUpdateError) throw new Error(testHooks.configUpdateError);
        testHooks.configUpdates.push({ key: fullKey(key), value, target, scope });
        testHooks.setConfig(fullKey(key), value);
      },
    };
  },
  async openTextDocument(uri: Uri): Promise<FakeDocument> {
    const open = testHooks.documents.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open;
    const doc = new FakeDocument(uri, nodeFs.existsSync(uri.fsPath) ? nodeFs.readFileSync(uri.fsPath, 'utf8') : '');
    testHooks.documents.push(doc);
    return doc;
  },
  async findFiles(include: RelativePattern, exclude?: string | null, maxResults = 10000): Promise<Uri[]> {
    const results = findOnDisk(include.base, include.pattern, exclude ?? undefined, maxResults);
    testHooks.findFilesCalls.push({ base: include.base, exclude: exclude ?? undefined, results: results.map((u) => u.fsPath) });
    return results;
  },
  asRelativePath(path: string | Uri): string {
    const p = typeof path === 'string' ? path : path.fsPath;
    const folder = workspace.getWorkspaceFolder(Uri.file(p));
    return folder ? nodePath.relative(folder.uri.fsPath, p) : p;
  },
};

/** A Memento kept in memory. */
export class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

export const testHooks = {
  watchers: [] as FakeFileSystemWatcher[],
  statusBarItems: [] as FakeStatusBarItem[],
  statusMessages: [] as { text: string; timeout?: number }[],
  quickPicks: [] as { items: unknown[]; options?: { title?: string; placeHolder?: string } }[],
  /** Chooses the quick pick answer; returns undefined (cancelled) unless a test replaces it. */
  quickPickAnswer: (_items: unknown[]): unknown => undefined,
  shownDocuments: [] as { uri: Uri; options?: unknown; editor?: FakeTextEditor }[],
  messages: [] as { level: string; message: string; items: string[] }[],
  documents: [] as FakeDocument[],
  decorationTypes: [] as FakeDecorationType[],
  panels: [] as FakeWebviewPanel[],
  serializers: new Map<string, { deserializeWebviewPanel(panel: FakeWebviewPanel, state: unknown): Promise<void> }>(),
  providers: [] as RegisteredProvider[],
  installedExtensions: [] as string[],
  config: {} as Record<string, unknown>,
  /** What `inspect` reports per full setting name. */
  configLevels: {} as Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>,
  configUpdates: [] as { key: string; value: unknown; target?: ConfigurationTarget; scope?: unknown }[],
  configUpdateError: undefined as string | undefined,
  inputBoxes: [] as InputBoxOptions[],
  /** Chooses the input box answer; returns undefined (cancelled) unless a test replaces it. */
  inputBoxAnswer: (_options: InputBoxOptions): string | undefined => undefined,
  treeViews: [] as FakeTreeView[],
  commands: new Map<string, (...args: any[]) => unknown>(),
  executedCommands: [] as { id: string; args: unknown[] }[],
  findFilesCalls: [] as { base: string; exclude?: string; results: string[] }[],
  setActiveEditor(editor: FakeTextEditor | undefined): void {
    window.activeTextEditor = editor;
    activeEditorEmitter.fire(editor);
  },
  /** An editor for a file (the document is opened with `text`), with the language taken from the extension. */
  editor(path: string, viewColumn = 1, text = ''): FakeTextEditor {
    let doc = testHooks.documents.find((d) => d.uri.fsPath === path);
    if (!doc) {
      doc = new FakeDocument(Uri.file(path), text);
      testHooks.documents.push(doc);
    }
    return new FakeTextEditor(doc, viewColumn);
  },
  /** Opens a document with the given text (it then counts as open in the editor). */
  openDocument(path: string, text: string, languageId?: string): FakeDocument {
    const doc = new FakeDocument(Uri.file(path), text, languageId);
    testHooks.documents = testHooks.documents.filter((d) => d.uri.fsPath !== path).concat(doc);
    return doc;
  },
  /** Live watchers whose relative pattern is based on `base`. */
  watchersOn(base: string): FakeFileSystemWatcher[] {
    return testHooks.watchers.filter((w) => !w.disposed && w.pattern instanceof RelativePattern && w.pattern.base === base);
  },
  activeProviders(kind: RegisteredProvider['kind']): RegisteredProvider[] {
    return testHooks.providers.filter((p) => p.kind === kind && !p.disposed);
  },
  save(path: string, languageId?: string): void {
    saveEmitter.fire(new FakeDocument(Uri.file(path), '', languageId));
  },
  saveUri(uri: Uri): void {
    saveEmitter.fire(new FakeDocument(uri, '', 'typst'));
  },
  rename(oldPath: string, newPath: string): void {
    renameEmitter.fire({ files: [{ oldUri: Uri.file(oldPath), newUri: Uri.file(newPath) }] });
  },
  setWorkspaceFolders(paths: string[]): void {
    const removed = workspace.workspaceFolders ?? [];
    const added = paths.map((p, index) => ({ uri: Uri.file(p), name: nodePath.basename(p), index }));
    workspace.workspaceFolders = added.length > 0 ? added : undefined;
    foldersEmitter.fire({ added, removed });
  },
  /** Sets `section.key` and fires onDidChangeConfiguration for it. */
  setConfig(key: string, value: unknown): void {
    if (value === undefined) delete testHooks.config[key];
    else testHooks.config[key] = value;
    configEmitter.fire({ affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) });
  },
  setInstalledExtensions(ids: string[]): void {
    testHooks.installedExtensions = ids;
    extensionsEmitter.fire();
  },
  /** Forgets every listener, record, document, setting and folder; call in beforeEach. */
  reset(): void {
    testHooks.watchers = [];
    testHooks.statusBarItems = [];
    testHooks.statusMessages = [];
    testHooks.quickPicks = [];
    testHooks.quickPickAnswer = () => undefined;
    testHooks.shownDocuments = [];
    testHooks.messages = [];
    testHooks.documents = [];
    testHooks.decorationTypes = [];
    testHooks.panels = [];
    testHooks.serializers.clear();
    testHooks.providers = [];
    testHooks.installedExtensions = [];
    testHooks.config = {};
    testHooks.configLevels = {};
    testHooks.configUpdates = [];
    testHooks.configUpdateError = undefined;
    testHooks.inputBoxes = [];
    testHooks.inputBoxAnswer = () => undefined;
    testHooks.treeViews = [];
    testHooks.commands.clear();
    testHooks.executedCommands = [];
    testHooks.findFilesCalls = [];
    window.activeTextEditor = undefined;
    workspace.workspaceFolders = undefined;
    for (const emitter of [activeEditorEmitter, saveEmitter, foldersEmitter, renameEmitter, configEmitter, extensionsEmitter]) emitter.dispose();
  },
};
