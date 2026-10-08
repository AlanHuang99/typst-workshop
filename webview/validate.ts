// Checks of the messages the PDF tab receives: malformed messages are refused, and config values outside the allowed ones fall back to the defaults.
import type { PdfRect } from '../src/helper/protocol';
import type { IndicatorStyle, InvertMode, ScrollModeName, SpreadModeName, SyncKeybinding, ToViewer, ViewerConfig } from '../src/viewer/messages';
import { isZoomValue, SCROLL_MODES, SPREAD_MODES } from './view';

/** The defaults of the `typst-workshop.view.pdf.*` and `typst-workshop.sync.*` settings (package.json). */
export const DEFAULT_CONFIG: ViewerConfig = { zoom: 'page-width', scrollMode: 'vertical', spreadMode: 'none', invertMode: 'never', invert: 0.9, syncKeybinding: 'ctrl-click', indicator: 'circle' };

const SCROLL_MODE_NAMES = Object.keys(SCROLL_MODES) as ScrollModeName[];
const SPREAD_MODE_NAMES = Object.keys(SPREAD_MODES) as SpreadModeName[];
const INVERT_MODES: readonly InvertMode[] = ['never', 'auto', 'always'];
const SYNC_KEYBINDINGS: readonly SyncKeybinding[] = ['ctrl-click', 'double-click'];
const INDICATORS: readonly IndicatorStyle[] = ['circle', 'rectangle', 'none'];

/**
 * The message for the tab, or a description of what is wrong with it. Data without a string `type` is not a message for the tab and gives undefined.
 */
export function checkMessage(data: unknown): ToViewer | string | undefined {
  if (!isObject(data) || typeof data.type !== 'string') return undefined;
  switch (data.type) {
    case 'config':
      return isObject(data.config) ? (data as ToViewer) : 'Ignored a config message without a config object.';
    case 'load':
      if (!isBinary(data.data)) return 'Ignored a load message without PDF data.';
      if (typeof data.reload !== 'boolean' || typeof data.pdfPath !== 'string') return 'Ignored a load message without a boolean reload or a string pdfPath.';
      return data as ToViewer;
    case 'forward':
      if (!Array.isArray(data.positions) || !data.positions.every(isRect)) return 'Ignored a forward message without a list of PDF rectangles.';
      if (!INDICATORS.includes(data.indicator as IndicatorStyle)) return `Ignored a forward message with the indicator ${JSON.stringify(data.indicator)}.`;
      return data as ToViewer;
    default:
      return `Ignored a message of unknown type ${JSON.stringify(data.type)}.`;
  }
}

/** `config` with every missing or invalid value replaced by its default; `invalid` names the values that were replaced although present. */
export function checkConfig(config: object): { config: ViewerConfig; invalid: string[] } {
  const raw = config as Record<string, unknown>;
  const invalid: string[] = [];
  function pick<K extends keyof ViewerConfig>(key: K, valid: (value: unknown) => boolean): ViewerConfig[K] {
    const value = raw[key];
    if (valid(value)) return value as ViewerConfig[K];
    if (value !== undefined) invalid.push(key);
    return DEFAULT_CONFIG[key];
  }
  const oneOf = (values: readonly string[]) => (value: unknown) => typeof value === 'string' && values.includes(value);
  return {
    config: {
      zoom: pick('zoom', (v) => typeof v === 'string' && isZoomValue(v)),
      scrollMode: pick('scrollMode', oneOf(SCROLL_MODE_NAMES)),
      spreadMode: pick('spreadMode', oneOf(SPREAD_MODE_NAMES)),
      invertMode: pick('invertMode', oneOf(INVERT_MODES)),
      invert: pick('invert', (v) => typeof v === 'number' && v >= 0 && v <= 1),
      syncKeybinding: pick('syncKeybinding', oneOf(SYNC_KEYBINDINGS)),
      indicator: pick('indicator', oneOf(INDICATORS)),
    },
    invalid,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBinary(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function isRect(value: unknown): value is PdfRect {
  if (!isObject(value) || !Number.isInteger(value.page)) return false;
  return (['left', 'bottom', 'right', 'top', 'x', 'y'] as const).every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
