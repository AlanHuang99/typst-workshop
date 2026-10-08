// The sidebar's three views as plain data: what each item shows and what clicking it runs. No VS Code API here; `views.ts` turns the nodes into tree items.
import * as path from 'node:path';
import type { WordCountResult } from '../helper/protocol';
import type { EntryRule } from '../project/entry';
import { SHOW_PROBLEMS, clock, describeStatus, describeWordCount, seconds, type BuildStatus } from '../statusText';
import { plural } from '../util/helpers';

/** One item of a sidebar view. */
export interface SidebarNode {
  /** Unique within the view and the same across refreshes, so VS Code keeps the item expanded or collapsed. */
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id, such as `file-pdf` or `sync~spin`. */
  icon?: string;
  /** Matched by the `view/item/context` menus of the manifest. */
  contextValue?: string;
  /** Runs when the item is clicked. */
  command?: NodeCommand;
  children?: SidebarNode[];
  /** Whether an item with children starts expanded. */
  expanded?: boolean;
  /** Project view: the entry file the item belongs to; the inline buttons pass the item to their command. */
  entry?: string;
  /** Settings view: the setting key without `typst-workshop.`. */
  setting?: string;
}

export interface NodeCommand {
  id: string;
  title: string;
  args?: unknown[];
}

/** VS Code's command that opens a file; in a node its argument is a file path, which `views.ts` passes as a URI. */
export const OPEN_FILE = 'vscode.open';
const SECTION_PREFIX = 'typst-workshop.';

// Project view.

/** What the Project view shows of one entry file. */
export interface ProjectSummary {
  entry: string;
  pdf: string;
  pdfExists: boolean;
  /** `idle` when the entry was not built in this window. */
  status: BuildStatus;
  /** The word count of the last successful build, when known, and the project root its paths are relative to. */
  words?: { result: WordCountResult; root: string };
  /** Whether the entry is the pinned entry of its folder. */
  pinned: boolean;
}

export interface ProjectViewState {
  /** The active Typst editor's file, the rule that decided its entry (`auto` mode), and that entry unless the rule gave none. */
  active?: { file: string; rule: EntryRule; project?: ProjectSummary };
  /** The focused PDF tab's PDF and the entry that writes it; marked before the active Typst editor. */
  activePdf?: { pdf: string; project: ProjectSummary };
  /** The projects built in this window, in the order to list them; the marked entry may be among them. */
  known: ProjectSummary[];
}

export const NO_ENTRY = 'not built automatically; Build Project compiles it on its own';
export const FOCUSED_PDF = 'writes the focused PDF';

/** Each entry rule in plain words, as the entry's description; the tooltip names the rule itself. */
const RULE_WORDS: Record<EntryRule, string> = {
  'magic comment': 'set by // !TYPST root',
  pinned: 'pinned',
  setting: 'set in mainFile',
  'known project': 'built before',
  'include scan': 'found through #include',
  'the file itself': 'entry file',
  'no entry': NO_ENTRY,
};

/** Why the rule chose the entry for `file` (a file name). */
function reason(rule: EntryRule, file: string): string {
  switch (rule) {
    case 'magic comment':
      return `a // !TYPST root comment in ${file} names it`;
    case 'pinned':
      return 'it is pinned as the entry of this folder';
    case 'setting':
      return 'the setting typst-workshop.mainFile names it';
    case 'known project':
      return `its last build read ${file}`;
    case 'include scan':
      return `it includes ${file}, directly or through other files`;
    case 'the file itself':
      return `no other file includes or imports ${file}`;
    case 'no entry':
      return NO_ENTRY;
  }
}

function pdfNode(p: ProjectSummary): SidebarNode {
  return {
    id: `pdf:${p.entry}`,
    label: path.basename(p.pdf),
    description: p.pdfExists ? undefined : 'not built yet',
    tooltip: p.pdfExists ? p.pdf : `${p.pdf}\nView PDF builds it first.`,
    icon: 'file-pdf',
    contextValue: 'pdf',
    command: { id: 'typst-workshop.viewEntry', title: 'View PDF', args: [p.entry] },
    entry: p.entry,
  };
}

/** The last build in this window: building, succeeded (time, duration, pages), failed (error count), stopped, or none yet; clicking opens the Problems panel after a failure with errors and the log otherwise, as the status bar item does. */
function buildNode(p: ProjectSummary): SidebarNode {
  const s = p.status;
  const d = describeStatus(s);
  const node = { id: `build:${p.entry}`, entry: p.entry, tooltip: d.tooltip, command: { id: d.command, title: d.command === SHOW_PROBLEMS ? 'Show Problems' : 'Show Log' } };
  switch (s.kind) {
    case 'idle':
      return { ...node, label: 'Not built in this window', tooltip: 'Not built in this window', icon: 'circle-outline', contextValue: 'build.none' };
    case 'building':
      return { ...node, label: 'Building…', icon: 'sync~spin', contextValue: 'build.running' };
    case 'ok': {
      const description = [`${seconds(s.durationMs)} s`, ...(s.pageCount === null ? [] : [plural(s.pageCount, 'page')])].join(' · ');
      return { ...node, label: `Built at ${clock(s.at)}`, description, icon: 'check', contextValue: 'build.succeeded' };
    }
    case 'failed':
      return { ...node, label: s.errors > 0 ? `Failed with ${plural(s.errors, 'error')}` : 'Failed', description: s.errors > 0 ? undefined : s.message, icon: 'error', contextValue: 'build.failed' };
    case 'stopped':
      return { ...node, label: 'Stopped', tooltip: 'The build was stopped', icon: 'debug-stop', contextValue: 'build.stopped' };
  }
}

function wordsNode(p: ProjectSummary, words: NonNullable<ProjectSummary['words']>): SidebarNode {
  const d = describeWordCount(words.result, words.root, path.basename(p.pdf));
  return { id: `words:${p.entry}`, label: d.text, tooltip: d.tooltip, icon: 'whole-word', contextValue: 'words', command: { id: 'typst-workshop.wordCount', title: 'Count Words', args: [p.entry] }, entry: p.entry };
}

/** An entry file with its PDF, last build and word count; the marked one (the entry of the active editor, or of the focused PDF tab) comes expanded with a description and a reason. */
function entryNode(p: ProjectSummary, mark?: { description: string; reason: string }): SidebarNode {
  return {
    id: `entry:${p.entry}`,
    label: path.basename(p.entry),
    description: mark ? mark.description : p.pinned ? 'pinned' : undefined,
    tooltip: mark ? `${p.entry}\n${mark.reason}` : p.entry,
    icon: mark ? 'target' : 'file',
    contextValue: p.pinned ? 'entry.pinned' : 'entry',
    command: { id: OPEN_FILE, title: 'Open File', args: [p.entry] },
    children: [pdfNode(p), buildNode(p), ...(p.words ? [wordsNode(p, p.words)] : [])],
    expanded: mark !== undefined,
    entry: p.entry,
  };
}

/** The active file when no rule gives it an entry: automatic builds leave it alone; its buttons build it on its own, as Build Project does. */
function noEntryNode(file: string): SidebarNode {
  const name = path.basename(file);
  return {
    id: `file:${file}`,
    label: name,
    description: NO_ENTRY,
    tooltip: `${file}\nNot built automatically: nothing includes or imports ${name}, it includes nothing itself, and the folder has another top-level file that includes files. Build Project compiles it on its own.`,
    icon: 'circle-slash',
    contextValue: 'orphan',
    entry: file,
  };
}

/** The Project view: the entry of the focused PDF tab, or else the active editor's entry (or the note that it has none); then every other project built in this window. */
export function projectNodes(state: ProjectViewState): SidebarNode[] {
  const nodes: SidebarNode[] = [];
  const { active, activePdf } = state;
  let marked: string | undefined;
  if (activePdf) {
    nodes.push(entryNode(activePdf.project, { description: FOCUSED_PDF, reason: `Writes ${path.basename(activePdf.pdf)}, the PDF of the focused tab.` }));
    marked = activePdf.project.entry;
  } else if (active) {
    const file = path.basename(active.file);
    nodes.push(active.project ? entryNode(active.project, { description: RULE_WORDS[active.rule], reason: `Entry of ${file}: ${reason(active.rule, file)} (${active.rule}).` }) : noEntryNode(active.file));
    marked = active.project?.entry;
  }
  for (const p of state.known) if (p.entry !== marked) nodes.push(entryNode(p));
  return nodes;
}

// Commands view.

const COMMANDS: readonly { id: string; title: string; icon: string }[] = [
  { id: 'typst-workshop.build', title: 'Build Project', icon: 'play' },
  { id: 'typst-workshop.view', title: 'View PDF', icon: 'open-preview' },
  { id: 'typst-workshop.syncToPdf', title: 'Show Cursor Position in PDF', icon: 'location' },
  { id: 'typst-workshop.kill', title: 'Stop Build', icon: 'debug-stop' },
  { id: 'typst-workshop.wordCount', title: 'Count Words', icon: 'whole-word' },
  { id: 'typst-workshop.pinEntry', title: 'Set Current File as Entry', icon: 'pin' },
  { id: 'typst-workshop.unpinEntry', title: 'Clear Entry Setting', icon: 'pinned' },
  { id: 'typst-workshop.showLog', title: 'Show Log', icon: 'output' },
];

/** The Commands view: one item per command, running it as the Command Palette does. */
export function commandNodes(): SidebarNode[] {
  return COMMANDS.map((c) => ({ id: `command:${c.id}`, label: c.title, icon: c.icon, contextValue: 'command', command: { id: c.id, title: c.title } }));
}

// Settings view.

/** The frequently changed settings the view lists, in order. */
export const SIDEBAR_SETTINGS = ['autoBuild.run', 'sync.keybinding', 'sync.indicator', 'view.pdf.invertMode', 'sync.afterBuild', 'wordCount.statusBar', 'view.pdf.zoom'] as const;

/** Each listed setting in plain words: its label and the words for its values; booleans read on and off, and numbers of view.pdf.zoom read as percentages. */
const PLAIN_SETTINGS: Readonly<Record<string, { label: string; values?: Readonly<Record<string, string>> }>> = {
  'autoBuild.run': { label: 'Automatic builds', values: { never: 'never', onSave: 'on save', onFileChange: 'on file change' } },
  'sync.keybinding': { label: 'Jump from the PDF', values: { 'ctrl-click': 'Ctrl/Cmd+click', 'double-click': 'double-click' } },
  'sync.indicator': { label: 'Marker in the PDF', values: { circle: 'circle', rectangle: 'rectangle', none: 'none' } },
  'view.pdf.invertMode': { label: 'Dark PDF pages', values: { never: 'never', auto: 'with a dark theme', always: 'always' } },
  'sync.afterBuild': { label: 'Show the cursor after builds' },
  'wordCount.statusBar': { label: 'Word count in the status bar' },
  'view.pdf.zoom': { label: 'PDF zoom', values: { auto: 'automatic', 'page-width': 'page width', 'page-fit': 'page fit', 'page-actual': 'actual size' } },
};

const ZOOM = 'view.pdf.zoom';
const ZOOM_NUMBER = /^[0-9]*\.?[0-9]+$/;

/** `record[key]` when the record has that key itself, so that a name such as `constructor` is not found on Object.prototype. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** The label of a setting in plain words (the key itself for a setting the sidebar does not list). */
export function settingLabel(key: string): string {
  return own(PLAIN_SETTINGS, key)?.label ?? key;
}

/** A setting value in plain words: `on save`, `with a dark theme`, `on`/`off` for booleans, `125 %` for a zoom of `1.25`; any other value as it is. */
export function plainValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === undefined) return 'not set';
  if (typeof value !== 'string') return JSON.stringify(value);
  const word = own(own(PLAIN_SETTINGS, key)?.values, value);
  if (word !== undefined) return word;
  if (key === ZOOM && ZOOM_NUMBER.test(value)) return `${Math.round(Number(value) * 1000) / 10} %`;
  return value;
}

/** One property of the manifest's `contributes.configuration`: the parts the model reads (the Quick Pick shows each value's plain words with the stored value as detail, so `enumDescriptions` is not read). */
export interface SettingSchema {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  pattern?: string;
  scope?: string;
  markdownDescription?: string;
  description?: string;
}

/** `contributes.configuration.properties`, keyed by the full setting name. */
export type SettingsSchema = Readonly<Record<string, SettingSchema>>;

export type ConfigLevel = 'workspaceFolder' | 'workspace' | 'user';

/** The parts of `WorkspaceConfiguration.inspect` used here. */
export interface ConfigInspect {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** Scopes whose settings a workspace folder may set; VS Code refuses folder-level writes of the others (window-scoped settings, the default). */
const FOLDER_SCOPES = ['resource', 'language-overridable', 'machine-overridable'];

/** The level whose value is in effect, the most specific first, or undefined when the setting is not set anywhere. The folder level counts only for settings a folder may set: in a single-folder workspace VS Code reports `.vscode/settings.json` as both the workspace and the folder value. */
export function definedAt(inspect: ConfigInspect | undefined, scope = 'window'): ConfigLevel | undefined {
  if (inspect?.workspaceFolderValue !== undefined && FOLDER_SCOPES.includes(scope)) return 'workspaceFolder';
  if (inspect?.workspaceValue !== undefined) return 'workspace';
  if (inspect?.globalValue !== undefined) return 'user';
  return undefined;
}

/** Where a new value goes: the level where the setting is defined now, else the user settings. */
export function writeTarget(inspect: ConfigInspect | undefined, scope?: string): ConfigLevel {
  return definedAt(inspect, scope) ?? 'user';
}

function schemaOf(schema: SettingsSchema, key: string): SettingSchema | undefined {
  return Object.prototype.hasOwnProperty.call(schema, SECTION_PREFIX + key) ? schema[SECTION_PREFIX + key] : undefined;
}

/** The setting's description as plain text (Markdown code marks dropped). */
function plainDescription(s: SettingSchema | undefined): string {
  return (s?.markdownDescription ?? s?.description ?? '').replace(/`/g, '');
}

/** The description of a setting (key without `typst-workshop.`) as plain text, for the Quick Pick and the input box. */
export function settingDescription(schema: SettingsSchema, key: string): string {
  return plainDescription(schemaOf(schema, key));
}

function isBoolean(s: SettingSchema): boolean {
  return s.type === 'boolean';
}

function kindIcon(s: SettingSchema | undefined): string {
  if (s?.enum) return 'symbol-enum';
  if (s && isBoolean(s)) return 'symbol-boolean';
  return 'symbol-string';
}

/** The Settings view: each setting of `SIDEBAR_SETTINGS` in plain words with its current value (`values`, keyed without `typst-workshop.`) in plain words, the key and its description in the tooltip; then "Open all settings". */
export function settingNodes(values: Readonly<Record<string, unknown>>, schema: SettingsSchema): SidebarNode[] {
  const nodes: SidebarNode[] = SIDEBAR_SETTINGS.map((key) => {
    const s = schemaOf(schema, key);
    return {
      id: `setting:${key}`,
      label: settingLabel(key),
      description: plainValue(key, values[key]),
      tooltip: `${SECTION_PREFIX}${key}\n${plainDescription(s)}`,
      icon: kindIcon(s),
      contextValue: 'setting',
      command: { id: 'typst-workshop.changeSetting', title: 'Change Setting', args: [key] },
      setting: key,
    };
  });
  nodes.push({ id: 'openSettings', label: 'Open all settings', icon: 'settings-gear', contextValue: 'openSettings', command: { id: 'typst-workshop.openSettings', title: 'Open Settings' } });
  return nodes;
}

/** One entry of a setting's Quick Pick. */
export interface SettingChoice {
  label: string;
  /** The value to write; absent for "Other value…". */
  value?: unknown;
  description?: string;
  detail?: string;
  /** "Other value…": the value is typed into an input box. */
  other?: boolean;
}

export const OTHER_VALUE = 'Other value…';

/** The plain words of a pattern `^(a|b|…)$`: `view.pdf.zoom`'s presets `auto`, `page-width`, …; `other` tells whether the pattern allows more than these words. */
function patternWords(pattern: string): { words: string[]; other: boolean } {
  const m = /^\^\((.*)\)\$$/.exec(pattern);
  if (!m) return { words: [], other: true };
  const alternatives = m[1].split('|');
  const words = alternatives.filter((a) => /^[A-Za-z0-9_-]+$/.test(a));
  return { words, other: words.length < alternatives.length };
}

/** The values a setting's Quick Pick offers, from the manifest: an enum's values, on and off for a boolean, the plain words of a string pattern plus "Other value…". Each reads in plain words with the stored value as detail; the current value and the default are marked. */
export function settingChoices(schema: SettingsSchema, key: string, current: unknown): SettingChoice[] {
  const s = schemaOf(schema, key);
  if (!s) return [];
  const choice = (value: unknown): SettingChoice => {
    const marks = [value === current ? 'current' : undefined, value === s.default ? 'default' : undefined].filter((m) => m !== undefined);
    const c: SettingChoice = { label: plainValue(key, value), value };
    if (marks.length > 0) c.description = marks.join(' · ');
    c.detail = String(value);
    return c;
  };
  if (s.enum) return s.enum.map(choice);
  if (isBoolean(s)) return [choice(true), choice(false)];
  const { words, other } = s.pattern ? patternWords(s.pattern) : { words: [], other: true };
  const choices = words.map(choice);
  if (other) {
    const custom: SettingChoice = { label: OTHER_VALUE, other: true };
    if (typeof current === 'string' && !words.includes(current)) custom.description = `current: ${plainValue(key, current)}`;
    choices.push(custom);
  }
  return choices;
}

/** A zoom typed in percent: `125`, `125 %`, `133.3`. */
const PERCENT = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*%?\s*$/;
const ZOOM_PERCENT_MIN = 10;
const ZOOM_PERCENT_MAX = 1000;
export const ZOOM_PROMPT = 'Zoom in percent, for example 125';

function percentOf(text: string): number | undefined {
  const m = PERCENT.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** What the "Other value…" input box asks and the text it starts with: for view.pdf.zoom a percentage, starting from the current zoom in percent; for another setting its description and current value. */
export function settingInput(schema: SettingsSchema, key: string, current: unknown): { prompt: string; value: string } {
  if (key === ZOOM) return { prompt: ZOOM_PROMPT, value: typeof current === 'string' && ZOOM_NUMBER.test(current) ? String(Number((Number(current) * 100).toFixed(4))) : '' };
  return { prompt: plainDescription(schemaOf(schema, key)), value: typeof current === 'string' ? current : '' };
}

/** Why a text typed for "Other value…" is not accepted, or undefined when it is: the zoom takes a percentage from 10 to 1000; another setting a value that matches its pattern. */
export function settingInputProblem(schema: SettingsSchema, key: string, text: string): string | undefined {
  if (key === ZOOM) {
    const percent = percentOf(text);
    if (percent === undefined) return 'Enter the zoom in percent, for example 125.';
    return percent < ZOOM_PERCENT_MIN || percent > ZOOM_PERCENT_MAX ? `The zoom must be from ${ZOOM_PERCENT_MIN} % to ${ZOOM_PERCENT_MAX} %.` : undefined;
  }
  const s = schemaOf(schema, key);
  const value = text.trim();
  if (value === '') return 'Enter a value.';
  if (s?.pattern && !new RegExp(s.pattern).test(value)) return `Not a valid value. ${plainDescription(s)}`;
  return undefined;
}

/** The value written for an accepted text: for the zoom the factor (`125` → `1.25`), a string the manifest pattern allows; for another setting the text trimmed. */
export function settingInputValue(key: string, text: string): string {
  const percent = key === ZOOM ? percentOf(text) : undefined;
  return percent === undefined ? text.trim() : String(Number((percent / 100).toFixed(6)));
}

/** Why a value cannot be written to the setting, or undefined when it can. */
export function settingValueProblem(schema: SettingsSchema, key: string, value: unknown): string | undefined {
  const s = schemaOf(schema, key);
  if (!s) return `${SECTION_PREFIX}${key} is not a setting of Typst Workshop`;
  const allowed = s.enum ? s.enum.includes(value) : isBoolean(s) ? typeof value === 'boolean' : typeof value === 'string' && (!s.pattern || new RegExp(s.pattern).test(value));
  return allowed ? undefined : `${String(value)} is not a value of ${SECTION_PREFIX}${key}`;
}

// Command arguments.

/** The entry file a Project view command is about: an absolute `.typ` path (an item's click), or the item itself (an inline button). */
export function entryArg(arg: unknown): string | undefined {
  const value = typeof arg === 'object' && arg !== null ? (arg as { entry?: unknown }).entry : arg;
  return typeof value === 'string' && path.isAbsolute(value) && value.toLowerCase().endsWith('.typ') ? value : undefined;
}

/** The setting key a Settings view command is about: the key (an item's click), or the item itself. */
export function settingArg(arg: unknown): string | undefined {
  const value = typeof arg === 'object' && arg !== null ? (arg as { setting?: unknown }).setting : arg;
  return typeof value === 'string' ? value : undefined;
}
