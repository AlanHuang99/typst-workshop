import * as fs from 'node:fs';

/** Whether the path is an existing file (not a folder). */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Whether `file` is one of the folders or lies below one of them. */
export function isInside(file: string, folders: string | readonly string[]): boolean {
  const list = typeof folders === 'string' ? [folders] : folders;
  return list.some((f) => {
    const folder = f.length > 1 && f.endsWith('/') ? f.slice(0, -1) : f;
    return file === folder || file.startsWith(`${folder}/`);
  });
}

/** `6,543`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** `1 page`, `2 errors`, `1,234 words`. */
export function plural(n: number, word: string): string {
  return `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
