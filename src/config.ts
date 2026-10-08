import * as vscode from 'vscode';
import type { AutoBuildRun } from './build/autoBuild';
import type { ViewerConfig } from './viewer/messages';

export const SECTION = 'typst-workshop';

export type EditingMode = 'auto' | 'on' | 'off';

/** The `typst-workshop.*` settings. */
export interface WorkshopConfig {
  mainFile: string;
  rootDir: string;
  outDir: string;
  fontPaths: string[];
  inputs: Record<string, string>;
  autoBuildRun: AutoBuildRun;
  autoBuildDelay: number;
  helperPath: string;
  diagnosticsEnabled: boolean;
  errorPopup: boolean;
  editorGroup: 'right' | 'current';
  viewer: ViewerConfig;
  syncAfterBuild: boolean;
  wordCountStatusBar: boolean;
  editingEnabled: EditingMode;
}

/** Settings whose change restarts the helpers. */
export const PROJECT_SETTINGS = ['rootDir', 'outDir', 'fontPaths', 'inputs', 'helperPath'].map((k) => `${SECTION}.${k}`);
/** Settings the open PDF tabs apply at once. */
export const VIEWER_SETTINGS = ['view.pdf.zoom', 'view.pdf.scrollMode', 'view.pdf.spreadMode', 'view.pdf.invertMode', 'view.pdf.invert', 'sync.keybinding', 'sync.indicator'].map((k) => `${SECTION}.${k}`);

const ZOOM = /^(auto|page-width|page-fit|page-actual|[0-9]*\.?[0-9]+)$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** Reads the settings for a resource (or the window); invalid values fall back to the defaults. */
export function readConfig(scope?: vscode.Uri): WorkshopConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const zoom = text(c.get('view.pdf.zoom'), 'page-width').trim();
  return {
    mainFile: text(c.get('mainFile'), ''),
    rootDir: text(c.get('rootDir'), ''),
    outDir: text(c.get('outDir'), '%DIR%'),
    fontPaths: strings(c.get('fontPaths')),
    inputs: stringRecord(c.get('inputs')),
    autoBuildRun: oneOf(c.get('autoBuild.run'), ['never', 'onSave', 'onFileChange'] as const, 'onFileChange'),
    autoBuildDelay: Math.max(0, number(c.get('autoBuild.delay'), 250)),
    helperPath: text(c.get('helperPath'), ''),
    diagnosticsEnabled: flag(c.get('diagnostics.enabled'), true),
    errorPopup: flag(c.get('message.error.show'), false),
    editorGroup: oneOf(c.get('view.pdf.tab.editorGroup'), ['right', 'current'] as const, 'right'),
    viewer: {
      zoom: ZOOM.test(zoom) ? zoom : 'page-width',
      scrollMode: oneOf(c.get('view.pdf.scrollMode'), ['vertical', 'horizontal', 'wrapped', 'page'] as const, 'vertical'),
      spreadMode: oneOf(c.get('view.pdf.spreadMode'), ['none', 'odd', 'even'] as const, 'none'),
      invertMode: oneOf(c.get('view.pdf.invertMode'), ['never', 'auto', 'always'] as const, 'never'),
      invert: Math.min(1, Math.max(0, number(c.get('view.pdf.invert'), 0.9))),
      syncKeybinding: oneOf(c.get('sync.keybinding'), ['ctrl-click', 'double-click'] as const, 'ctrl-click'),
      indicator: oneOf(c.get('sync.indicator'), ['circle', 'rectangle', 'none'] as const, 'circle'),
    },
    syncAfterBuild: flag(c.get('sync.afterBuild'), false),
    wordCountStatusBar: flag(c.get('wordCount.statusBar'), true),
    editingEnabled: oneOf(c.get('editing.enabled'), ['auto', 'on', 'off'] as const, 'auto'),
  };
}
