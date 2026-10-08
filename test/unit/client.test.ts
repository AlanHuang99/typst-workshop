import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { HelperClient, HelperError } from '../../src/helper/client';
import type { InitializeParams } from '../../src/helper/protocol';
import { memoryLogger } from '../../src/log';

const fake = fileURLToPath(new URL('./fixtures/fakeHelper.mjs', import.meta.url));
const params: InitializeParams = { root: '/w', main: '/w/main.typ', output: '/w/main.pdf', fontPaths: [], inputs: {} };
const clients: HelperClient[] = [];

function client(extra: Partial<ConstructorParameters<typeof HelperClient>[0]> = {}) {
  const log = memoryLogger();
  const c = new HelperClient({ command: process.execPath, args: [fake], logger: log, ...extra });
  clients.push(c);
  return { c, log };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
});

test('request/response, remote error, stderr to log', async () => {
  const log = memoryLogger();
  const c = new HelperClient({ command: process.execPath, args: [fake], logger: log });
  clients.push(c);
  expect(await c.request('initialize', params)).toEqual({ helperVersion: '0.0.0', typstVersion: '0.15.1' });
  await expect(c.request('fail' as any, {} as any)).rejects.toMatchObject({ kind: 'remote', message: 'boom' });
  await vi.waitFor(() => expect(log.lines.some((l) => l.includes('fake stderr line'))).toBe(true));
  await c.dispose();
});

test('spawns on the first request', async () => {
  const { c } = client();
  expect(c.running).toBe(false);
  await c.request('initialize', params);
  expect(c.running).toBe(true);
});

test('crash rejects pending and the next request respawns', async () => {
  const { c, log } = client();
  const exits: { code: number | null; signal: string | null }[] = [];
  c.onDidExit((e) => exits.push(e));
  await c.request('initialize', params);
  const err = await c.request('crash' as any, {} as any).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HelperError);
  expect(err).toMatchObject({ kind: 'exit' });
  expect(exits).toEqual([{ code: 3, signal: null }]);
  expect(c.running).toBe(false);
  expect(log.lines.some((l) => l.includes('code 3'))).toBe(true);
  expect(await c.request('initialize', params)).toEqual({ helperVersion: '0.0.0', typstVersion: '0.15.1' });
  expect(c.running).toBe(true);
  expect(await c.request('stats' as any, {} as any)).toMatchObject({ initialize: 1 });
});

test('timeout', async () => {
  const { c } = client({ timeouts: { compile: 200, other: 200 } });
  await expect(c.request('sleep' as any, {} as any)).rejects.toMatchObject({ kind: 'timeout' });
});

test('a timed-out helper is replaced by a fresh process', async () => {
  const exits: unknown[] = [];
  const { c } = client({ timeouts: { compile: 200, other: 200 } });
  c.onDidExit((e) => exits.push(e));
  await c.request('initialize', params);
  await expect(c.request('sleep' as any, {} as any)).rejects.toMatchObject({ kind: 'timeout' });
  expect(exits).toHaveLength(1);
  await c.request('initialize', params);
  expect(await c.request('stats' as any, {} as any)).toMatchObject({ initialize: 1 });
});

test('compile uses the longer timeout', async () => {
  const { c } = client({ timeouts: { compile: 2000, other: 100 } });
  await c.request('initialize', params);
  await c.request('configure' as any, { delayMs: 300 } as any);
  await expect(c.request('compile', {})).resolves.toMatchObject({ success: true });
});

test('kill then respawn (stop build)', async () => {
  const { c } = client();
  const exits: { code: number | null; signal: string | null }[] = [];
  c.onDidExit((e) => exits.push(e));
  await c.request('initialize', params);
  const pending = c.request('sleep' as any, {} as any).catch((e: unknown) => e);
  c.kill();
  expect(c.running).toBe(false);
  expect(exits).toEqual([{ code: null, signal: 'SIGKILL' }]);
  expect(await pending).toMatchObject({ kind: 'exit' });
  expect(await c.request('initialize', params)).toEqual({ helperVersion: '0.0.0', typstVersion: '0.15.1' });
  expect(c.running).toBe(true);
  await new Promise((r) => setTimeout(r, 100));
  expect(exits).toHaveLength(1);
});

test('requests are sent one at a time, in order', async () => {
  const { c } = client();
  await c.request('initialize', params);
  await c.request('configure' as any, { delayMs: 30, deps: ['/w/main.typ'] } as any);
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => c.request('compile', {}).then(() => order.push(n))));
  expect(order).toEqual([1, 2, 3]);
  expect(await c.request('stats' as any, {} as any)).toMatchObject({ compile: 3, maxInFlight: 1 });
});

test('a crash rejects queued requests too', async () => {
  const { c } = client();
  await c.request('initialize', params);
  const crash = c.request('crash' as any, {} as any).catch((e: unknown) => e);
  const queued = c.request('stats' as any, {} as any).catch((e: unknown) => e);
  expect(await crash).toMatchObject({ kind: 'exit' });
  expect(await queued).toMatchObject({ kind: 'exit' });
});

test('malformed results are rejected as remote errors naming the method; the helper stays usable', async () => {
  const { c } = client();
  await c.request('initialize', params);
  await c.request('configure' as any, { deps: ['/w/main.typ'] } as any);
  await c.request('compile', {});
  await c.request('configure' as any, { malformed: ['compile', 'forward', 'wordCount', 'inverse'] } as any);
  const calls: [string, unknown][] = [
    ['compile', {}],
    ['forward', { path: '/w/main.typ', line: 0, character: 0 }],
    ['wordCount', {}],
    ['inverse', { page: 1, x: 0, y: 0 }],
  ];
  for (const [method, p] of calls) {
    const err = await c.request(method as any, p as any).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect(err).toMatchObject({ kind: 'remote' });
    expect((err as Error).message).toContain(method);
  }
  await c.request('configure' as any, { malformed: [] } as any);
  await expect(c.request('compile', {})).resolves.toMatchObject({ success: true });
  await expect(c.request('inverse', { page: 1, x: 0, y: 0 })).resolves.toBeNull();
});

test('a missing binary fails with kind spawn and names the path', async () => {
  const { c } = client({ command: '/nonexistent/typst-workshop-helper', args: [] });
  const err = await c.request('initialize', params).catch((e: unknown) => e);
  expect(err).toMatchObject({ kind: 'spawn' });
  expect((err as Error).message).toContain('/nonexistent/typst-workshop-helper');
  expect(c.running).toBe(false);
});

test('non-JSON output is logged and does not disturb responses', async () => {
  const { c, log } = client();
  expect(await c.request('garbage' as any, {} as any)).toBe('after garbage');
  expect(log.lines.some((l) => l.includes('this is not json'))).toBe(true);
});

test('long responses with non-ASCII text survive chunking', async () => {
  const { c } = client();
  const s = 'Ä b 😀 é'.repeat(20000);
  expect(await c.request('echo' as any, { s } as any)).toEqual({ s });
});

test('dispose sends shutdown, the process ends, later requests fail', async () => {
  const { c } = client();
  const exits: { code: number | null; signal: string | null }[] = [];
  c.onDidExit((e) => exits.push(e));
  await c.request('initialize', params);
  await c.dispose();
  expect(c.running).toBe(false);
  expect(exits).toEqual([{ code: 0, signal: null }]);
  await expect(c.request('initialize', params)).rejects.toMatchObject({ kind: 'exit' });
});

test('dispose kills a helper that does not shut down within a second', async () => {
  const { c } = client();
  const exits: { code: number | null; signal: string | null }[] = [];
  c.onDidExit((e) => exits.push(e));
  await c.request('initialize', params);
  await c.request('configure' as any, { delayMs: 60000, stubborn: true } as any);
  const busy = c.request('compile', {}).catch((e: unknown) => e);
  const started = Date.now();
  await c.dispose();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(c.running).toBe(false);
  expect(await busy).toMatchObject({ kind: 'exit' });
  expect(exits).toEqual([{ code: null, signal: 'SIGKILL' }]);
});
