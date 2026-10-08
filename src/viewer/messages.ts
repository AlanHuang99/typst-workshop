/**
 * Contract between the extension and the PDF tab. Imported by both sides.
 */
import type { PdfRect } from '../helper/protocol';

export type ScrollModeName = 'vertical' | 'horizontal' | 'wrapped' | 'page';
export type SpreadModeName = 'none' | 'odd' | 'even';
export type InvertMode = 'never' | 'auto' | 'always';
export type SyncKeybinding = 'ctrl-click' | 'double-click';
export type IndicatorStyle = 'circle' | 'rectangle' | 'none';

export interface ViewerConfig {
  /** 'auto' | 'page-width' | 'page-fit' | 'page-actual' | a number such as '1.25' */
  zoom: string;
  scrollMode: ScrollModeName;
  spreadMode: SpreadModeName;
  invertMode: InvertMode;
  /** Strength of the inversion, 0–1. */
  invert: number;
  syncKeybinding: SyncKeybinding;
  indicator: IndicatorStyle;
}

export type ToViewer =
  | { type: 'config'; config: ViewerConfig }
  | { type: 'load'; data: Uint8Array; reload: boolean; pdfPath: string }
  | { type: 'forward'; positions: PdfRect[]; indicator: IndicatorStyle };

export type FromViewer =
  | { type: 'ready' }
  | { type: 'inverse'; page: number; x: number; y: number }
  | { type: 'openExternal'; url: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Persisted with vscode.setState and handed back when VS Code restores the tab. */
export interface ViewerState {
  pdfPath: string;
  scale?: string;
  scrollTop?: number;
  scrollLeft?: number;
  invertOverride?: boolean | null;
}

export const VIEW_TYPE = 'typst-workshop.pdf';
