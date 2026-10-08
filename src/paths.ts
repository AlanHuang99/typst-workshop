import * as path from 'node:path';

export interface PlaceholderVars {
  /** The entry file's folder. */
  dir: string;
  workspaceFolder?: string;
  /** The OS temporary directory plus `typst-workshop`. */
  tmpDir: string;
}

/** Replaces `%DIR%`, `%WORKSPACE_FOLDER%` (the entry folder outside a workspace) and `%TMPDIR%`. */
export function expandPlaceholders(value: string, vars: PlaceholderVars): string {
  return value.replace(/%(DIR|WORKSPACE_FOLDER|TMPDIR)%/g, (_match, name: string) => {
    if (name === 'DIR') return vars.dir;
    if (name === 'TMPDIR') return vars.tmpDir;
    return vars.workspaceFolder ?? vars.dir;
  });
}

export interface ProjectPathSettings {
  rootDir: string;
  outDir: string;
  fontPaths: string[];
}

export interface ResolvedProjectPaths {
  root: string;
  pdf: string;
  fontPaths: string[];
}

/** Root, PDF path and font folders of an entry file. Empty `rootDir`/`outDir` mean the entry's folder; relative values resolve against the workspace folder, or the entry's folder when there is none. */
export function resolveProjectPaths(entry: string, cfg: ProjectPathSettings, workspaceFolder: string | undefined, osTmp: string): ResolvedProjectPaths {
  const dir = path.dirname(entry);
  const vars: PlaceholderVars = { dir, workspaceFolder, tmpDir: path.join(osTmp, 'typst-workshop') };
  const base = workspaceFolder ?? dir;
  const resolveSetting = (value: string): string => path.resolve(base, expandPlaceholders(value.trim(), vars));
  const root = cfg.rootDir.trim() === '' ? dir : resolveSetting(cfg.rootDir);
  const outDir = cfg.outDir.trim() === '' ? dir : resolveSetting(cfg.outDir);
  const name = path.basename(entry).replace(/\.typ$/i, '');
  return {
    root,
    pdf: path.join(outDir, `${name}.pdf`),
    fontPaths: cfg.fontPaths.filter((f) => f.trim() !== '').map(resolveSetting),
  };
}
