import { describe, expect, test } from 'vitest';
import { memoryLogger } from '../../src/log';
import { guardStartup, startupFailureMessage } from '../../src/startup';

describe('startupFailureMessage', () => {
  test('names the error and tells to reload the window', () => {
    expect(startupFailureMessage(new Error("Serializer for 'typst-workshop.pdf' already registered"))).toBe(
      "Typst Workshop could not start: Serializer for 'typst-workshop.pdf' already registered. If another copy of Typst Workshop is installed or was just updated, reload the window (Developer: Reload Window).",
    );
  });

  test('a value that is not an Error is shown as text', () => {
    const tail = '. If another copy of Typst Workshop is installed or was just updated, reload the window (Developer: Reload Window).';
    expect(startupFailureMessage('plain text')).toBe(`Typst Workshop could not start: plain text${tail}`);
    expect(startupFailureMessage(42)).toBe(`Typst Workshop could not start: 42${tail}`);
    expect(startupFailureMessage(undefined)).toBe(`Typst Workshop could not start: undefined${tail}`);
  });
});

describe('guardStartup', () => {
  function deps() {
    const shown: string[] = [];
    return { logger: memoryLogger(), showError: (m: string) => shown.push(m), shown };
  }

  test('a start that succeeds returns its result and reports nothing', async () => {
    const d = deps();
    await expect(guardStartup(async () => 'api', d)).resolves.toBe('api');
    expect(d.shown).toEqual([]);
    expect(d.logger.lines).toEqual([]);
  });

  test('a start that fails shows the message, logs the error and throws the same error', async () => {
    const d = deps();
    const failure = new Error("Serializer for 'typst-workshop.pdf' already registered");
    await expect(guardStartup(async () => Promise.reject(failure), d)).rejects.toBe(failure);
    expect(d.shown).toEqual([startupFailureMessage(failure)]);
    expect(d.logger.lines).toHaveLength(1);
    expect(d.logger.lines[0]).toMatch(/^error Activation failed: Error: Serializer for 'typst-workshop\.pdf' already registered\n {4}at /);
  });

  test('a start that throws before returning a promise, or throws a value that is not an Error, is reported the same way', async () => {
    const d = deps();
    await expect(
      guardStartup(() => {
        throw new Error('sync failure');
      }, d),
    ).rejects.toThrow('sync failure');
    await expect(guardStartup(async () => Promise.reject('plain text'), d)).rejects.toBe('plain text');
    expect(d.shown).toEqual([startupFailureMessage(new Error('sync failure')), startupFailureMessage('plain text')]);
    expect(d.logger.lines[1]).toBe('error Activation failed: plain text');
  });
});
