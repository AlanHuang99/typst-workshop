import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BuildScheduler } from '../../src/build/scheduler';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A run function whose builds stay open until released, tracking how many run at once. */
function blockingRun() {
  const state = { active: 0, max: 0, releases: [] as (() => void)[] };
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        state.active++;
        state.max = Math.max(state.max, state.active);
        state.releases.push(() => {
          state.active--;
          resolve();
        });
      }),
  );
  const release = () => state.releases.shift()!();
  return { run, state, release };
}

test('burst of auto requests → one build after the quiet period', async () => {
  const run = vi.fn(async () => {});
  const s = new BuildScheduler(run, () => 250);
  s.requestAuto();
  await vi.advanceTimersByTimeAsync(100);
  s.requestAuto();
  s.requestAuto();
  await vi.advanceTimersByTimeAsync(249);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
});

test('requests during a build cause exactly one follow-up, never overlap', async () => {
  let active = 0,
    max = 0,
    release!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((r) => {
        active++;
        max = Math.max(max, active);
        release = () => {
          active--;
          r();
        };
      }),
  );
  const s = new BuildScheduler(run, () => 0);
  const first = s.requestNow();
  s.requestAuto();
  s.requestAuto();
  s.requestNow();
  await vi.advanceTimersByTimeAsync(10);
  release();
  await vi.advanceTimersByTimeAsync(10);
  release();
  await first;
  expect(run).toHaveBeenCalledTimes(2);
  expect(max).toBe(1);
});

test('requestNow cancels a pending timer; cancel drops timer and follow-up', async () => {
  const quick = vi.fn(async () => {});
  const s = new BuildScheduler(quick, () => 250);
  s.requestAuto();
  await vi.advanceTimersByTimeAsync(100);
  await s.requestNow();
  expect(quick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(quick).toHaveBeenCalledTimes(1);

  s.requestAuto();
  s.cancel();
  await vi.advanceTimersByTimeAsync(1000);
  expect(quick).toHaveBeenCalledTimes(1);

  const { run, release } = blockingRun();
  const t = new BuildScheduler(run, () => 50);
  const done = t.requestNow();
  t.requestAuto();
  await vi.advanceTimersByTimeAsync(60);
  t.requestNow();
  t.cancel();
  release();
  await done;
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(t.building).toBe(false);
});

test('a timer that fires during a build marks one follow-up after it', async () => {
  const { run, state, release } = blockingRun();
  const s = new BuildScheduler(run, () => 100);
  s.requestAuto();
  await vi.advanceTimersByTimeAsync(100);
  expect(run).toHaveBeenCalledTimes(1);
  expect(s.building).toBe(true);
  for (let k = 0; k < 15; k++) {
    s.requestAuto();
    await vi.advanceTimersByTimeAsync(20);
  }
  await vi.advanceTimersByTimeAsync(200);
  expect(run).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(state.max).toBe(1);
  expect(s.building).toBe(false);
});

test('requestNow during a build resolves after the follow-up build', async () => {
  const { run, release } = blockingRun();
  const s = new BuildScheduler(run, () => 0);
  void s.requestNow();
  let settled = false;
  const second = s.requestNow().then(() => (settled = true));
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  expect(settled).toBe(false);
  release();
  await second;
  expect(settled).toBe(true);
});

test('the delay is read when a request arrives', async () => {
  let delay = 300;
  const run = vi.fn(async () => {});
  const s = new BuildScheduler(run, () => delay);
  s.requestAuto();
  delay = 50;
  await vi.advanceTimersByTimeAsync(299);
  expect(run).not.toHaveBeenCalled();
  s.requestAuto();
  await vi.advanceTimersByTimeAsync(50);
  expect(run).toHaveBeenCalledTimes(1);
});

test('a failing run is reported and does not stop later builds', async () => {
  const run = vi.fn(async () => {
    throw new Error('boom');
  });
  const errors: unknown[] = [];
  const s = new BuildScheduler(run, () => 0, (err) => errors.push(err));
  await expect(s.requestNow()).resolves.toBeUndefined();
  await s.requestNow();
  expect(run).toHaveBeenCalledTimes(2);
  expect(errors.map((e) => (e as Error).message)).toEqual(['boom', 'boom']);
});

test('after dispose nothing runs', async () => {
  const run = vi.fn(async () => {});
  const s = new BuildScheduler(run, () => 10);
  s.requestAuto();
  s.dispose();
  await vi.advanceTimersByTimeAsync(100);
  await s.requestNow();
  s.requestAuto();
  await vi.advanceTimersByTimeAsync(100);
  expect(run).not.toHaveBeenCalled();
});
