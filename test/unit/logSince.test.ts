import { expect, test } from 'vitest';
import { LogTap } from '../../src/log';
import { linesSince } from '../extension/logSince';

test('the lines written since a snapshot of the log tap, also after the tap dropped its oldest lines', () => {
  const tap = new LogTap(5);
  for (const m of ['a', 'b', 'c']) tap.record('info', m);
  const before = tap.lines();
  expect(linesSince(before, tap.lines())).toEqual([]);
  tap.record('warn', 'd');
  expect(linesSince(before, tap.lines())).toEqual(['warn: d']);
  for (const m of ['e', 'f', 'g']) tap.record('info', m);
  expect(tap.lines()).toEqual(['info: c', 'warn: d', 'info: e', 'info: f', 'info: g']);
  expect(linesSince(before, tap.lines())).toEqual(['warn: d', 'info: e', 'info: f', 'info: g']);
  // More new lines than the tap holds: every line it keeps is new.
  for (const m of ['h', 'i', 'j', 'k', 'l']) tap.record('info', m);
  expect(linesSince(before, tap.lines())).toEqual(tap.lines());
});

test('repeated lines do not hide the new ones', () => {
  const tap = new LogTap(3);
  tap.record('info', 'x');
  tap.record('info', 'y');
  const before = tap.lines();
  tap.record('info', 'x');
  expect(linesSince(before, tap.lines())).toEqual(['info: x']);
  tap.record('info', 'y');
  expect(tap.lines()).toEqual(['info: y', 'info: x', 'info: y']);
  expect(linesSince(before, tap.lines())).toEqual(['info: x', 'info: y']);
  expect(linesSince([], tap.lines())).toEqual(tap.lines());
});
