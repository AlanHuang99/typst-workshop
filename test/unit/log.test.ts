import { expect, test } from 'vitest';
import { LogTap, createLogger, type LogChannel } from '../../src/log';

/** A log channel that records its calls as `<method> <message>`. */
function recordingChannel(): LogChannel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    info: (m) => calls.push(`info ${m}`),
    warn: (m) => calls.push(`warn ${m}`),
    error: (m) => calls.push(`error ${m}`),
    show: (preserveFocus) => calls.push(`show ${String(preserveFocus)}`),
  };
}

test('the tap keeps the lines in call order as "<level>: <message>"', () => {
  const channel = recordingChannel();
  const tap = new LogTap();
  const log = createLogger(channel, tap);
  log.info('[viewer] Showing main.pdf: 1 page');
  log.warn('slow helper');
  log.error('helper stopped');
  log.info('second info');
  expect(tap.lines()).toEqual(['info: [viewer] Showing main.pdf: 1 page', 'warn: slow helper', 'error: helper stopped', 'info: second info']);
  expect(channel.calls).toEqual(['info [viewer] Showing main.pdf: 1 page', 'warn slow helper', 'error helper stopped', 'info second info']);
});

test('the tap keeps the last 500 lines', () => {
  const tap = new LogTap();
  const log = createLogger(recordingChannel(), tap);
  for (let i = 0; i < 499; i++) log.info(`line ${i}`);
  expect(tap.lines()).toHaveLength(499);
  log.warn('line 499');
  expect(tap.lines()).toHaveLength(500);
  expect(tap.lines()[0]).toBe('info: line 0');
  for (let i = 500; i < 1200; i++) log.error(`line ${i}`);
  const lines = tap.lines();
  expect(lines).toHaveLength(500);
  expect(lines[0]).toBe('error: line 700');
  expect(lines[499]).toBe('error: line 1199');
});

test('lines() returns a copy', () => {
  const tap = new LogTap();
  createLogger(recordingChannel(), tap).info('kept');
  tap.lines().push('not kept');
  expect(tap.lines()).toEqual(['info: kept']);
});

test('show() reaches the channel and is not a line; without a tap the logger only writes to the channel', () => {
  const channel = recordingChannel();
  const tap = new LogTap();
  createLogger(channel, tap).show();
  expect(channel.calls).toEqual(['show true']);
  expect(tap.lines()).toEqual([]);
  const plain = recordingChannel();
  const log = createLogger(plain);
  log.warn('w');
  log.show();
  expect(plain.calls).toEqual(['warn w', 'show true']);
});
