import { describe, expect, test } from 'vitest';
import { parseHeadings } from '../../src/editing/outline';
import { extractRefs } from '../../src/project/includeScan';
import { Emitter } from '../../src/util/emitter';
import { lineStarts, maskComments, matchBrackets, offsetToPosition, scanTypst } from '../../src/typst/scan';

/** Replaces each listed fragment of `text` by spaces (newlines kept), as maskComments should. */
function blank(text: string, ...fragments: string[]): string {
  let out = text;
  for (const f of fragments) {
    const at = out.indexOf(f);
    if (at < 0) throw new Error(`fragment not found: ${f}`);
    out = out.slice(0, at) + f.replace(/[^\r\n]/g, ' ') + out.slice(at + f.length);
  }
  return out;
}

describe('maskComments', () => {
  test('line comments and nested block comments, newlines and offsets kept', () => {
    const text = 'a // b\n/* c /* d */ e */f\n/* x\ny */g';
    const m = maskComments(text);
    expect(m.length).toBe(text.length);
    expect(m).toBe(blank(text, '// b', '/* c /* d */ e */', '/* x\ny */'));
  });

  test('inline raw, raw blocks and the empty raw', () => {
    const text = 'x `y // z` w\n```typ\n= a\n```\n= b ``';
    expect(maskComments(text)).toBe(blank(text, '`y // z`', '```typ\n= a\n```', '``'));
  });

  test('a raw block ends at a run of as many backticks as it opened with', () => {
    const text = '````\n``` inside\n````after';
    expect(maskComments(text)).toBe(blank(text, '````\n``` inside\n````'));
  });

  test('links in markup are not comments', () => {
    const text = 'see https://typst.app/docs here // c';
    expect(maskComments(text)).toBe(blank(text, '// c'));
  });

  test('strings in code hide comment markers; markup quotes do not', () => {
    const a = '#link("https://x.org/a//b")[x] // c';
    expect(maskComments(a)).toBe(blank(a, '// c'));
    const b = 'He said "a // b" and left.';
    expect(maskComments(b)).toBe(blank(b, '// b" and left.'));
    const c = '#let s = "/* not a comment */"';
    expect(maskComments(c)).toBe(c);
  });

  test('strings in math hide comment markers', () => {
    const text = '$ "a // b" $ // c';
    expect(maskComments(text)).toBe(blank(text, '// c'));
  });

  test('escapes in markup', () => {
    expect(maskComments('a \\// b')).toBe('a \\// b');
    expect(maskComments('\\`not raw\\` // c')).toBe(blank('\\`not raw\\` // c', '// c'));
    // An unescaped backtick opens raw text, which runs to the end when unclosed (as in Typst).
    expect(maskComments('\\`a` // c')).toBe(blank('\\`a` // c', '` // c'));
  });

  test('an unclosed block comment runs to the end', () => {
    const text = 'a /* b\nc';
    expect(maskComments(text)).toBe(blank(text, '/* b\nc'));
  });

  test('UTF-16 offsets are unchanged around astral characters', () => {
    const text = '😀 // é😀\nx';
    const m = maskComments(text);
    expect(m.length).toBe(text.length);
    expect(m).toBe('😀       \nx');
  });
});

describe('lines and positions', () => {
  test('line starts for LF, CRLF and CR', () => {
    expect(lineStarts('ab\ncd\r\nef\rg')).toEqual([0, 3, 7, 10]);
    expect(lineStarts('')).toEqual([0]);
    expect(lineStarts('a\n')).toEqual([0, 2]);
  });

  test('offsets map to 0-based lines and UTF-16 characters', () => {
    const starts = lineStarts('ab\ncd\r\nef\rg');
    expect(offsetToPosition(starts, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(starts, 4)).toEqual({ line: 1, character: 1 });
    expect(offsetToPosition(starts, 10)).toEqual({ line: 3, character: 0 });
    const s2 = lineStarts('😀x\ny');
    expect(offsetToPosition(s2, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetToPosition(s2, 4)).toEqual({ line: 1, character: 0 });
  });
});

describe('matchBrackets', () => {
  const pairs = (text: string) => matchBrackets(maskComments(text)).map((p) => [p.open, text.slice(p.start, p.end + 1)]);

  test('code groups and content blocks, sorted by start', () => {
    expect(pairs('#f(a, [b\nc], {d})')).toEqual([
      ['(', '(a, [b\nc], {d})'],
      ['[', '[b\nc]'],
      ['{', '{d}'],
    ]);
  });

  test('brackets inside code strings are skipped', () => {
    expect(pairs('#f(")", "]", "(")')).toEqual([['(', '(")", "]", "(")']]);
  });

  test('parentheses and braces in markup are text; brackets in markup are balanced', () => {
    expect(pairs('(a\n#f[b (c\n]\n) {')).toEqual([['[', '[b (c\n]']]);
    expect(pairs('a [b [c] d] e')).toEqual([
      ['[', '[b [c] d]'],
      ['[', '[c]'],
    ]);
  });

  test('math delimiters are not brackets', () => {
    expect(pairs('$[0, 1)$ #g(\n)')).toEqual([['(', '(\n)']]);
  });

  test('a quote in markup does not start a string', () => {
    expect(pairs('#f[He said "hi]')).toEqual([['[', '[He said "hi]']]);
  });

  test('statements, code blocks and trailing content blocks', () => {
    expect(pairs('#let f(x) = { (x, [y]) }\n#show heading: it => [#it.body]')).toEqual([
      ['(', '(x)'],
      ['{', '{ (x, [y]) }'],
      ['(', '(x, [y])'],
      ['[', '[y]'],
      ['[', '[#it.body]'],
    ]);
  });

  test('comments and raw text hide brackets', () => {
    expect(pairs('#f(\n// )\n`)` /* ) */\n)')).toEqual([['(', '(\n// )\n`)` /* ) */\n)']]);
  });
});

describe('scanTypst', () => {
  test('headings only in markup, at line starts, followed by a space', () => {
    const text = ['= One', '  == Two', '=No', '#{', '= code', '}', '#[= Three]', '======= seven', '$', '= math', '$'].join('\n');
    const levels = scanTypst(text).headings.map((h) => [h.level, text.slice(h.contentStart, text.indexOf('\n', h.contentStart) >>> 0)]);
    expect(levels).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [1, 'Three]'],
    ]);
  });

  test('code tokens: identifiers, strings with escapes, punctuation', () => {
    const text = '#image("a\\"b.svg", width: 50%) text "quoted" #x.y';
    const tokens = scanTypst(text).tokens.map((t) => (t.kind === 'string' ? ['string', t.value] : [t.kind, t.text]));
    expect(tokens).toEqual([
      ['ident', 'image'],
      ['punct', '('],
      ['string', 'a"b.svg'],
      ['punct', ','],
      ['ident', 'width'],
      ['punct', ':'],
      ['punct', ')'],
      ['ident', 'x'],
      ['punct', '.'],
      ['ident', 'y'],
    ]);
  });

  test('control flow: condition, body and else stay in code mode only up to the body', () => {
    const text = '#if x == "a" [yes] else [no] He said "b\n= Heading';
    const r = scanTypst(text);
    expect(r.tokens.filter((t) => t.kind === 'string').map((t) => (t.kind === 'string' ? t.value : ''))).toEqual(['a']);
    expect(r.headings.map((h) => h.level)).toEqual([1]);
  });

  test('an embedded statement ends at the end of the line', () => {
    const text = '#let x = 1\n= Heading "quoted"\n#set text(\n  size: 10pt,\n)\n== Next';
    expect(scanTypst(text).headings.map((h) => h.level)).toEqual([1, 2]);
  });

  test('field access and calls continue an embedded expression; a period ends it', () => {
    const text = '#emph[a].\n= H\n#a.b(c)[d] "e';
    const r = scanTypst(text);
    expect(r.headings.map((h) => h.level)).toEqual([1]);
    expect(r.tokens.filter((t) => t.kind === 'ident').map((t) => (t.kind === 'ident' ? t.text : ''))).toEqual(['emph', 'a', 'b', 'c']);
  });
});

describe('Unicode escapes', () => {
  test('a half-typed \\u{ before an #include and a heading leaves both visible to the scan and the outline', () => {
    const text = ['#let s = "\\u{"', '#include "a.typ"', 'Text \\u{ more', '= Heading', '}'].join('\n');
    expect(extractRefs(text)).toEqual({ includes: ['a.typ'], imports: [] });
    expect(parseHeadings(text).map((h) => [h.title, h.line])).toEqual([['Heading', 3]]);
  });

  test('complete escapes still decode; invalid ones decode to nothing', () => {
    const text = '#let a = ("\\u{1F600}", "\\u{zz}x", "\\u{41")';
    expect(scanTypst(text).tokens.filter((t) => t.kind === 'string').map((t) => (t.kind === 'string' ? t.value : ''))).toEqual(['😀', 'x', '']);
    expect(maskComments('\\u{1F600} // c')).toBe(blank('\\u{1F600} // c', '// c'));
  });
});

describe('Emitter', () => {
  test('fires to listeners until they are disposed', () => {
    const e = new Emitter<number>();
    const seen: number[] = [];
    const d = e.event((n) => seen.push(n));
    e.fire(1);
    d.dispose();
    e.fire(2);
    expect(seen).toEqual([1]);
  });

  test('a throwing listener does not stop the others; dispose drops everything', () => {
    const e = new Emitter<string>();
    const seen: string[] = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      e.event(() => {
        throw new Error('boom');
      });
      e.event((s) => seen.push(s));
      e.fire('a');
    } finally {
      console.error = quiet;
    }
    e.dispose();
    e.fire('b');
    e.event((s) => seen.push(`late ${s}`));
    e.fire('c');
    expect(seen).toEqual(['a']);
  });

  test('listener errors go to the onError callback', () => {
    const errors: unknown[] = [];
    const e = new Emitter<number>((err) => errors.push(err));
    const seen: number[] = [];
    e.event(() => {
      throw new Error('listener boom');
    });
    e.event((n) => seen.push(n));
    e.fire(7);
    expect(seen).toEqual([7]);
    expect(errors.map((x) => (x as Error).message)).toEqual(['listener boom']);
  });
});
