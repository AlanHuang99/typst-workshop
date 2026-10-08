/**
 * Contract between the extension and `typst-workshop-helper`.
 * One JSON object per line on the helper's stdin (requests) and stdout (responses).
 * Positions use 0-based lines and UTF-16 characters; PDF points are in pt, PDF user space
 * of the page (origin bottom-left, y up).
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** A rectangle on a PDF page (1-based `page`) in PDF user space; (x, y) is the point for a circle marker. */
export interface PdfRect {
  page: number;
  left: number;
  bottom: number;
  right: number;
  top: number;
  x: number;
  y: number;
}

export interface InitializeParams {
  root: string;
  main: string;
  output: string;
  fontPaths: string[];
  inputs: Record<string, string>;
}

export interface InitializeResult {
  helperVersion: string;
  typstVersion: string;
}

export interface TraceEntry {
  message: string;
  path: string | null;
  range: LspRange | null;
}

export interface HelperDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  hints: string[];
  path: string | null;
  range: LspRange | null;
  trace: TraceEntry[];
}

export interface CompileResult {
  success: boolean;
  durationMs: number;
  pageCount: number | null;
  pdfWritten: boolean;
  diagnostics: HelperDiagnostic[];
  dependencies: string[];
}

export interface InverseParams {
  page: number;
  x: number;
  y: number;
}

export interface SourceLocation {
  path: string;
  line: number;
  character: number;
}

export interface ForwardParams {
  path: string;
  line: number;
  character: number;
}

export interface ForwardResult {
  positions: PdfRect[];
}

export interface WordCountResult {
  total: number;
  files: { path: string; words: number }[];
}

export interface HelperMethods {
  initialize: { params: InitializeParams; result: InitializeResult };
  compile: { params: Record<string, never>; result: CompileResult };
  inverse: { params: InverseParams; result: SourceLocation | null };
  forward: { params: ForwardParams; result: ForwardResult };
  wordCount: { params: Record<string, never>; result: WordCountResult };
  shutdown: { params: Record<string, never>; result: null };
}

export type HelperMethod = keyof HelperMethods;

export interface HelperRequest {
  id: number;
  method: string;
  params: unknown;
}

export type HelperResponse = { id: number; result: unknown } | { id: number; error: { message: string } };
