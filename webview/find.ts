// Find bar of the PDF tab: pdf.js PDFFindController, case-insensitive, all matches highlighted, match count shown.
import { el, icon } from './dom';
import type { View } from './view';

/** pdf.js FindState */
const FIND_NOT_FOUND = 1;

export class FindBar {
  private readonly view: View;
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private readonly onClose: () => void;
  private state: number | undefined;

  /** `onClose` gives the keyboard back to the document. */
  constructor(view: View, bar: HTMLElement, onClose: () => void) {
    this.view = view;
    this.bar = bar;
    this.onClose = onClose;
    this.input = el('input', { id: 'findInput', attrs: { type: 'text', placeholder: 'Find in PDF', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Find in PDF' } });
    this.count = el('span', { id: 'findCount', attrs: { 'aria-live': 'polite' } });
    const previous = el('button', { id: 'findPrevious', className: 'tw-button', title: 'Previous Match (Shift+Enter)', attrs: { type: 'button', 'aria-label': 'Previous Match' } }, [icon(['M4 10l4-4l4 4'])]);
    const next = el('button', { id: 'findNext', className: 'tw-button', title: 'Next Match (Enter)', attrs: { type: 'button', 'aria-label': 'Next Match' } }, [icon(['M4 6l4 4l4-4'])]);
    const close = el('button', { id: 'findClose', className: 'tw-button', title: 'Close (Escape)', attrs: { type: 'button', 'aria-label': 'Close' } }, [icon(['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'])]);
    bar.replaceChildren(this.input, this.count, previous, next, close);

    this.input.addEventListener('input', () => this.find(''));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.next(e.shiftKey);
      else if (e.key === 'Escape') this.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    previous.addEventListener('click', () => this.next(true));
    next.addEventListener('click', () => this.next(false));
    close.addEventListener('click', () => this.close());

    view.eventBus.on('updatefindmatchescount', (e: { matchesCount: MatchesCount }) => this.showCount(e.matchesCount));
    view.eventBus.on('updatefindcontrolstate', (e: { state: number; matchesCount: MatchesCount }) => {
      this.state = e.state;
      this.showCount(e.matchesCount);
    });
    // A new document (after a rebuild) starts without matches.
    view.eventBus.on('pagesinit', () => {
      this.state = undefined;
      this.count.textContent = '';
    });
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  open(): void {
    const wasOpen = this.isOpen;
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
    if (!wasOpen && this.input.value) this.find('highlightallchange');
  }

  close(): void {
    if (!this.isOpen) return;
    this.bar.hidden = true;
    this.view.eventBus.dispatch('findbarclose', { source: this });
    this.onClose();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Selects the next match, or the previous one. */
  next(previous: boolean): void {
    if (this.input.value) this.find('again', previous);
  }

  private find(type: '' | 'again' | 'highlightallchange', findPrevious = false): void {
    this.view.eventBus.dispatch('find', { source: this, type, query: this.input.value, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false });
  }

  private showCount({ current, total }: MatchesCount): void {
    if (!this.input.value) this.count.textContent = '';
    else if (total > 0) this.count.textContent = current > 0 ? `${current} of ${total}` : `${total} found`;
    else if (this.state === FIND_NOT_FOUND) this.count.textContent = 'No matches';
  }
}

interface MatchesCount {
  current: number;
  total: number;
}
