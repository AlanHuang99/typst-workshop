export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

/** A minimal event emitter with the shape of `vscode.EventEmitter`, usable without the VS Code API. A listener that throws does not stop the others; its error goes to `onError` (default `console.error`). */
export class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  private disposed = false;

  constructor(private readonly onError: (err: unknown) => void = (err) => console.error(err)) {}

  readonly event: Event<T> = (listener) => {
    if (this.disposed) return { dispose() {} };
    this.listeners.push(listener);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        const k = this.listeners.indexOf(listener);
        if (k >= 0) this.listeners.splice(k, 1);
      },
    };
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(e);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners = [];
  }
}
