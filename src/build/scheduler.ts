/** Per-project build scheduling: automatic requests wait for a quiet period, at most one build runs at a time, and requests that arrive during a build cause exactly one follow-up build. */
export class BuildScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loop: Promise<void> | undefined;
  private followUp = false;
  private disposed = false;

  /** `onError` receives anything `run` throws (the scheduler itself keeps going). */
  constructor(
    private readonly run: () => Promise<void>,
    private readonly delayMs: () => number,
    private readonly onError: (err: unknown) => void = (err) => console.error(err),
  ) {}

  /** (Re)starts the quiet-period timer; when it fires, a build starts or a follow-up is marked. */
  requestAuto(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.trigger();
    }, Math.max(0, this.delayMs()));
  }

  /** Cancels the timer and builds now; resolves when a build that started after this request has finished. */
  requestNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.clearTimer();
    return this.trigger();
  }

  /** Drops the pending timer and the follow-up build; a running build is not interrupted. */
  cancel(): void {
    this.clearTimer();
    this.followUp = false;
  }

  get building(): boolean {
    return this.loop !== undefined;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private trigger(): Promise<void> {
    if (this.loop) {
      this.followUp = true;
      return this.loop;
    }
    let finish!: () => void;
    const loop = new Promise<void>((resolve) => (finish = resolve));
    this.loop = loop;
    void (async () => {
      try {
        do {
          this.followUp = false;
          try {
            await this.run();
          } catch (err) {
            this.onError(err);
          }
        } while (this.followUp && !this.disposed);
      } finally {
        this.loop = undefined;
        finish();
      }
    })();
    return loop;
  }
}
