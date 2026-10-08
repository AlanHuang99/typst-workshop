import { lineStarts, offsetToPosition, scanTypst, type CodeToken } from '../typst/scan';

export interface PathLiteral {
  value: string;
  line: number;
  /** UTF-16 columns of the string contents (quotes excluded). */
  start: number;
  end: number;
}

/** Functions whose first argument is a path. */
const PATH_FUNCTIONS = new Set(['image', 'read', 'csv', 'json', 'yaml', 'toml', 'xml', 'cbor', 'bibliography', 'plugin']);

type StringToken = Extract<CodeToken, { kind: 'string' }>;
type PunctToken = Extract<CodeToken, { kind: 'punct' }>;

function isString(t: CodeToken | undefined): t is StringToken {
  return t?.kind === 'string';
}

function isPunct(t: CodeToken | undefined, text: string): t is PunctToken {
  return t?.kind === 'punct' && t.text === text;
}

/** Path literals in code: after `include`/`import` (packages excluded), the first argument of `image`, `read`, `csv`, `json`, `yaml`, `toml`, `xml`, `cbor`, `bibliography` and `plugin`, and `style:` values ending in `.csl`. Field accesses and methods (`json.decode(…)`) do not count. */
export function extractPathLiterals(text: string): PathLiteral[] {
  const { tokens } = scanTypst(text);
  const starts = lineStarts(text);
  const out: PathLiteral[] = [];
  const add = (t: StringToken) => {
    if (t.value === '') return;
    const a = offsetToPosition(starts, t.start);
    const b = offsetToPosition(starts, t.end);
    if (a.line === b.line) out.push({ value: t.value, line: a.line, start: a.character, end: b.character });
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'ident') continue;
    const prev = tokens[k - 1];
    if (isPunct(prev, '.') && prev.end === t.start) continue;
    const next = tokens[k + 1];
    const after = tokens[k + 2];
    if (t.text === 'include' || t.text === 'import') {
      if (isString(next) && !next.value.startsWith('@')) add(next);
    } else if (PATH_FUNCTIONS.has(t.text)) {
      if (isPunct(next, '(') && next.start === t.end && isString(after)) add(after);
    } else if (t.text === 'style') {
      if (isPunct(next, ':') && isString(after) && after.value.toLowerCase().endsWith('.csl')) add(after);
    }
  }
  return out;
}
