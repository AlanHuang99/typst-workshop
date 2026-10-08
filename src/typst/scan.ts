/** A small Typst lexer for the extension's own needs: the include scan, the heading outline, folding and clickable paths. It follows the modes of typst-syntax 0.15.1 (markup, code, math, embedded `#` expressions) closely enough to tell comments, raw text, strings and brackets apart; it does not build a syntax tree. */

export interface Span {
  start: number;
  end: number;
}

export interface CommentSpan extends Span {
  block: boolean;
}

export type BracketKind = '[' | '{' | '(';

/** A matched bracket pair; `start` is the offset of the opening bracket and `end` the offset of the closing one. */
export interface BracketPair {
  open: BracketKind;
  start: number;
  end: number;
}

/** A markup heading marker at the start of a line; `offset` is its first `=`, `contentStart` the first character after the following space. */
export interface HeadingMark {
  offset: number;
  level: number;
  contentStart: number;
  /** Where the heading's text ends: the end of its line, or the closing bracket of the content block it is in. */
  contentEnd: number;
  /** The offset of the closing bracket of the content block the heading is in, if any. */
  blockEnd?: number;
}

/** Code-mode tokens. For strings, `start` and `end` delimit the contents (quotes excluded) and `value` has escapes resolved. */
export type CodeToken =
  | { kind: 'ident'; text: string; start: number; end: number }
  | { kind: 'string'; value: string; start: number; end: number }
  | { kind: 'punct'; text: string; start: number; end: number };

export interface TypstScan {
  /** The text with comments and raw text replaced by spaces (line breaks kept, offsets unchanged). */
  masked: string;
  comments: CommentSpan[];
  raws: Span[];
  brackets: BracketPair[];
  headings: HeadingMark[];
  tokens: CodeToken[];
}

const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const SPACE = 0x20;
const QUOTE = 0x22;
const HASH = 0x23;
const DOLLAR = 0x24;
const LPAREN = 0x28;
const RPAREN = 0x29;
const STAR = 0x2a;
const DOT = 0x2e;
const SLASH = 0x2f;
const SEMI = 0x3b;
const EQ = 0x3d;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const BACKTICK = 0x60;
const LOWER_H = 0x68;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

/** Keywords that start an embedded statement, which runs to the end of the line or a semicolon. */
const STATEMENTS = new Set(['let', 'set', 'show', 'import', 'include', 'break', 'continue', 'return']);
/** Keywords whose embedded form ends after its body block (and an `else` branch on the same line). */
const CONTROL = new Set(['if', 'while', 'for']);

const ID_START = /[\p{XID_Start}_]/u;
const ID_CONTINUE = /[\p{XID_Continue}_-]/u;

function isIdStart(c: number): boolean {
  if (c < 0x80) return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f;
  return !Number.isNaN(c) && ID_START.test(String.fromCharCode(c));
}

function isIdContinue(c: number): boolean {
  if (c < 0x80) return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d;
  return !Number.isNaN(c) && ID_CONTINUE.test(String.fromCharCode(c));
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** Line breaks as Typst sees them (LF, VT, FF, CR, NEL, LS, PS). */
function isNewline(c: number): boolean {
  return c === LF || c === 0x0b || c === 0x0c || c === CR || c === 0x85 || c === 0x2028 || c === 0x2029;
}

function isInlineSpace(c: number): boolean {
  return c === SPACE || c === TAB;
}

function isAsciiAlphanumeric(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Characters allowed in an automatic link, after typst-syntax's `link_prefix`. */
function isLinkChar(c: number): boolean {
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) return true;
  return "!#$%&*+,-./:;=?@_~'".includes(String.fromCharCode(c));
}

class Lexer {
  i = 0;
  readonly n: number;
  readonly comments: CommentSpan[] = [];
  readonly raws: Span[] = [];
  readonly brackets: BracketPair[] = [];
  readonly headings: HeadingMark[] = [];
  readonly tokens: CodeToken[] = [];

  constructor(readonly s: string) {
    this.n = s.length;
  }

  private at(k = 0): number {
    return this.s.charCodeAt(this.i + k);
  }

  /** Markup until the `]` closing the current content block (not consumed) or the end of the text. */
  markup(inBlock: boolean): void {
    let lineStart = true;
    /** Headings found by this call; the one on the current line is still open. */
    const mine: HeadingMark[] = [];
    let open: HeadingMark | undefined;
    while (this.i < this.n) {
      const c = this.at();
      if (isNewline(c)) {
        if (open) open.contentEnd = this.i;
        open = undefined;
        this.i++;
        lineStart = true;
        continue;
      }
      if (isInlineSpace(c)) {
        this.i++;
        continue;
      }
      if (c === SLASH && this.comment()) continue;
      if (lineStart && c === EQ) {
        open = this.headingMarker();
        if (open) mine.push(open);
        lineStart = false;
        continue;
      }
      lineStart = false;
      switch (c) {
        case BACKTICK:
          this.raw();
          break;
        case BACKSLASH:
          this.escape();
          break;
        case DOLLAR:
          this.i++;
          this.math();
          break;
        case HASH:
          this.i++;
          this.embedded();
          break;
        case LBRACKET:
          this.contentBlock();
          break;
        case RBRACKET:
          if (inBlock) {
            if (open) open.contentEnd = this.i;
            for (const h of mine) h.blockEnd = this.i;
            return;
          }
          this.i++;
          break;
        case LOWER_H:
          if (!this.link()) this.i++;
          break;
        default:
          this.i++;
      }
    }
  }

  /** At `=` at the start of a line: records a heading when one to six `=` are followed by a space or tab. */
  private headingMarker(): HeadingMark | undefined {
    const start = this.i;
    while (this.at() === EQ) this.i++;
    const level = this.i - start;
    if (level > 6 || !isInlineSpace(this.at())) return undefined;
    const heading: HeadingMark = { offset: start, level, contentStart: this.i + 1, contentEnd: this.n };
    this.headings.push(heading);
    return heading;
  }

  /** At `/`: consumes a line or (nestable) block comment and returns true, or returns false. */
  private comment(): boolean {
    const next = this.at(1);
    const start = this.i;
    if (next === SLASH) {
      let j = this.i + 2;
      while (j < this.n && !isNewline(this.s.charCodeAt(j))) j++;
      this.comments.push({ start, end: j, block: false });
      this.i = j;
      return true;
    }
    if (next === STAR) {
      // Port of typst-syntax's block_comment state machine: the first `*/` that does not close a nested `/*`.
      let j = this.i + 2;
      let state = -1;
      let depth = 1;
      while (j < this.n) {
        const c = this.s.charCodeAt(j++);
        if (state === STAR && c === SLASH) {
          depth--;
          if (depth === 0) break;
          state = -1;
        } else if (state === SLASH && c === STAR) {
          depth++;
          state = -1;
        } else {
          state = c;
        }
      }
      this.comments.push({ start, end: j, block: true });
      this.i = j;
      return true;
    }
    return false;
  }

  /** At a backtick: raw text ends at the first run of as many backticks as opened it; two backticks are an empty raw. */
  private raw(): void {
    const start = this.i;
    let k = 0;
    while (this.at() === BACKTICK) {
      this.i++;
      k++;
    }
    if (k !== 2) {
      let found = 0;
      while (found < k && this.i < this.n) {
        found = this.s.charCodeAt(this.i++) === BACKTICK ? found + 1 : 0;
      }
    }
    this.raws.push({ start, end: this.i });
  }

  /** At a backslash in markup or math: an escape, a Unicode escape or a line break. */
  private escape(): void {
    this.i++;
    if (this.i >= this.n || isNewline(this.at()) || isInlineSpace(this.at())) return;
    if (this.at() === 0x75 && this.at(1) === LBRACE) {
      // As typst-syntax: `\u{`, then ASCII letters and digits, then an optional `}`.
      this.i += 2;
      while (this.i < this.n && isAsciiAlphanumeric(this.at())) this.i++;
      if (this.at() === RBRACE) this.i++;
      return;
    }
    const c = this.at();
    this.i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }

  /** At `h` in markup: consumes an automatic `http://` or `https://` link and returns true, or returns false. */
  private link(): boolean {
    const s = this.s;
    let j: number;
    if (s.startsWith('http://', this.i)) j = this.i + 7;
    else if (s.startsWith('https://', this.i)) j = this.i + 8;
    else return false;
    const stack: number[] = [];
    while (j < this.n) {
      const c = s.charCodeAt(j);
      if (isLinkChar(c)) j++;
      else if (c === LBRACKET || c === LPAREN) {
        stack.push(c);
        j++;
      } else if (c === RBRACKET || c === RPAREN) {
        const open = stack.pop();
        if (open !== (c === RBRACKET ? LBRACKET : LPAREN)) break;
        j++;
      } else break;
    }
    while (j > this.i && "!,.:;?'".includes(s[j - 1])) j--;
    this.i = j;
    return true;
  }

  /** After `$`: math until the closing `$` (consumed). Math delimiters are not brackets. */
  math(): void {
    while (this.i < this.n) {
      const c = this.at();
      if (c === SLASH && this.comment()) continue;
      switch (c) {
        case DOLLAR:
          this.i++;
          return;
        case BACKSLASH:
          this.escape();
          break;
        case QUOTE:
          this.string(false);
          break;
        case HASH:
          this.i++;
          this.embedded();
          break;
        default:
          this.i++;
      }
    }
  }

  /** After `#` in markup or math: one embedded code expression. */
  private embedded(): void {
    if (this.i >= this.n) return;
    const c = this.at();
    if (isIdStart(c)) {
      const ident = this.ident();
      if (STATEMENTS.has(ident)) {
        this.code('line');
      } else if (CONTROL.has(ident)) {
        this.control();
      } else if (ident === 'context') {
        while (isInlineSpace(this.at())) this.i++;
        this.embedded();
      } else {
        this.postfix();
      }
      return;
    }
    switch (c) {
      case LPAREN:
        this.group(LPAREN);
        this.postfix();
        return;
      case LBRACE:
        this.group(LBRACE);
        this.postfix();
        return;
      case LBRACKET:
        this.contentBlock();
        this.postfix();
        return;
      case QUOTE:
        this.string(true);
        this.postfix();
        return;
      case DOLLAR:
        this.i++;
        this.math();
        return;
      default:
        if (isDigit(c)) this.number();
    }
  }

  /** Calls, trailing content blocks and field accesses directly after an embedded expression. */
  private postfix(): void {
    for (;;) {
      const c = this.at();
      if (c === DOT && isIdStart(this.at(1))) {
        this.punct();
        this.ident();
      } else if (c === LPAREN) {
        this.group(LPAREN);
      } else if (c === LBRACKET) {
        this.contentBlock();
      } else {
        return;
      }
    }
  }

  /** An embedded `if`, `while` or `for`: code up to its body block, then an optional `else` on the same line. */
  private control(): void {
    while (this.i < this.n) {
      const c = this.at();
      if (isNewline(c)) return;
      if (isInlineSpace(c)) {
        this.i++;
        continue;
      }
      if (c === LBRACE || c === LBRACKET) {
        if (c === LBRACE) this.group(LBRACE);
        else this.contentBlock();
        const after = this.i;
        while (isInlineSpace(this.at())) this.i++;
        if (this.keywordAt('else')) {
          this.ident();
          while (isInlineSpace(this.at())) this.i++;
          if (this.keywordAt('if')) this.ident();
          continue;
        }
        this.i = after;
        return;
      }
      if (c === RBRACKET || c === RBRACE || c === RPAREN) return;
      this.codeElement(c);
    }
  }

  private keywordAt(word: string): boolean {
    return this.s.startsWith(word, this.i) && !isIdContinue(this.s.charCodeAt(this.i + word.length));
  }

  /** Code until `closer` (not consumed). With `'line'`, an embedded statement: stops at a line break, a semicolon (consumed) or any closing bracket of the enclosing context. */
  private code(closer: number | 'line'): void {
    const line = closer === 'line';
    while (this.i < this.n) {
      const c = this.at();
      if (isNewline(c)) {
        if (line) return;
        this.i++;
        continue;
      }
      if (c === SPACE || c === TAB || c === 0xa0) {
        this.i++;
        continue;
      }
      if (c === RPAREN || c === RBRACE || c === RBRACKET) {
        if (c === closer || line) return;
        this.i++;
        continue;
      }
      if (c === SEMI && line) {
        this.i++;
        return;
      }
      this.codeElement(c);
    }
  }

  /** One element in code mode. */
  private codeElement(c: number): void {
    if (c === SLASH && this.comment()) return;
    switch (c) {
      case BACKTICK:
        this.raw();
        return;
      case QUOTE:
        this.string(true);
        return;
      case DOLLAR:
        this.i++;
        this.math();
        return;
      case LPAREN:
        this.group(LPAREN);
        return;
      case LBRACE:
        this.group(LBRACE);
        return;
      case LBRACKET:
        this.contentBlock();
        return;
      case HASH:
        this.i++;
        return;
    }
    if (isIdStart(c)) this.ident();
    else if (isDigit(c) || (c === DOT && isDigit(this.at(1)))) this.number();
    else if (c >= 0xd800 && c <= 0xdbff) this.i += 2;
    else this.punct();
  }

  /** A parenthesized group or code block, recorded as a bracket pair when closed. */
  private group(open: typeof LPAREN | typeof LBRACE): void {
    const start = this.i;
    const close = open === LPAREN ? RPAREN : RBRACE;
    const text = open === LPAREN ? '(' : '{';
    this.tokens.push({ kind: 'punct', text, start, end: start + 1 });
    this.i++;
    this.code(close);
    if (this.at() === close) {
      this.brackets.push({ open: text, start, end: this.i });
      this.tokens.push({ kind: 'punct', text: open === LPAREN ? ')' : '}', start: this.i, end: this.i + 1 });
      this.i++;
    }
  }

  /** A content block, or a balanced bracket pair in markup (Typst keeps those balanced). */
  private contentBlock(): void {
    const start = this.i;
    this.i++;
    this.markup(true);
    if (this.at() === RBRACKET) {
      this.brackets.push({ open: '[', start, end: this.i });
      this.i++;
    }
  }

  private ident(): string {
    const start = this.i;
    this.i++;
    while (this.i < this.n && isIdContinue(this.at())) this.i++;
    const text = this.s.slice(start, this.i);
    this.tokens.push({ kind: 'ident', text, start, end: this.i });
    return text;
  }

  private number(): void {
    this.i++;
    for (;;) {
      const c = this.at();
      if (isIdContinue(c) && c !== 0x2d) this.i++;
      else if (c === DOT && isDigit(this.at(1))) this.i += 2;
      else if (c === 0x25) this.i++;
      else return;
    }
  }

  private punct(): void {
    this.tokens.push({ kind: 'punct', text: this.s[this.i], start: this.i, end: this.i + 1 });
    this.i++;
  }

  /** At `"`: a string literal (strings may span lines). Recorded as a token when `record` is set. */
  private string(record: boolean): void {
    const open = this.i;
    this.i++;
    let value = '';
    let chunk = this.i;
    while (this.i < this.n) {
      const c = this.at();
      if (c === QUOTE) break;
      if (c === BACKSLASH) {
        value += this.s.slice(chunk, this.i);
        const e = this.s[this.i + 1];
        if (e === 'u' && this.s[this.i + 2] === '{') {
          // `\u{`, ASCII letters and digits, an optional `}`; the string still ends at its quote.
          let j = this.i + 3;
          while (j < this.n && isAsciiAlphanumeric(this.s.charCodeAt(j))) j++;
          const hex = this.s.slice(this.i + 3, j);
          if (this.s.charCodeAt(j) === RBRACE) {
            j++;
            const code = /^[0-9A-Fa-f]{1,6}$/.test(hex) ? parseInt(hex, 16) : NaN;
            if (code <= 0x10ffff) value += String.fromCodePoint(code);
          }
          this.i = j;
        } else {
          value += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : (e ?? '');
          this.i += 2;
        }
        chunk = this.i;
        continue;
      }
      this.i++;
    }
    const end = Math.min(this.i, this.n);
    value += this.s.slice(chunk, end);
    if (record) this.tokens.push({ kind: 'string', value, start: open + 1, end });
    if (this.i < this.n) this.i++;
  }
}

/** Replaces the given spans by spaces, keeping line breaks so that offsets and lines do not move. */
function blankSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const sp of sorted) {
    if (sp.start < pos) continue;
    out += text.slice(pos, sp.start) + text.slice(sp.start, sp.end).replace(/[^\r\n]/g, ' ');
    pos = sp.end;
  }
  return out + text.slice(pos);
}

/** Lexes a Typst source file. */
export function scanTypst(text: string): TypstScan {
  const lexer = new Lexer(text);
  lexer.markup(false);
  const masked = blankSpans(text, [...lexer.comments, ...lexer.raws]);
  return {
    masked,
    comments: lexer.comments,
    raws: lexer.raws,
    brackets: lexer.brackets.sort((a, b) => a.start - b.start),
    headings: lexer.headings,
    tokens: lexer.tokens,
  };
}

/** Line comments, nestable block comments and raw text replaced by spaces; line breaks and offsets unchanged. */
export function maskComments(text: string): string {
  return scanTypst(text).masked;
}

/** Offsets at which lines start (line breaks: LF, CRLF, CR, as in VS Code). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === LF) starts.push(i + 1);
    else if (c === CR) {
      if (text.charCodeAt(i + 1) === LF) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 0-based line and UTF-16 character of an offset. */
export function offsetToPosition(starts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

/** Matched bracket pairs of a masked text (see `maskComments`), sorted by their opening offset: code groups `(…)` and `{…}`, content blocks `[…]` and balanced brackets in markup. Brackets inside strings, math, and parentheses or braces in markup text are not brackets. */
export function matchBrackets(masked: string): BracketPair[] {
  return scanTypst(masked).brackets;
}
