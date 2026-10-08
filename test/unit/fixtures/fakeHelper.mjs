// Stand-in for typst-workshop-helper in unit tests: one JSON request per line on stdin, one response per line on stdout.
// Unlike the real helper it answers requests concurrently and counts how many it has in flight, so tests can check that the client never sends two at once.
// Like the real helper, inverse, forward and wordCount fail with "no successful compilation yet" until a compile succeeded; inverse then answers FAKE_INVERSE (JSON) or null.
// Test-only methods: crash (exit 3), sleep (never answers), fail (error "boom"), echo (returns params), garbage (a non-JSON line first), stats (counters), configure ({ deps?, fail?, delayMs?, stubborn?, malformed?, words? }; a stubborn fake ignores shutdown and the end of stdin; malformed lists methods whose results lack required fields; words is the total wordCount answers).
import { createInterface } from 'node:readline';

process.stderr.write('fake stderr line\n');

const config = {
  deps: (process.env.FAKE_DEPS ?? '').split(':').filter((p) => p !== ''),
  fail: false,
  delayMs: 0,
  stubborn: false,
  malformed: [],
  words: 0,
};
const inverseAnswer = process.env.FAKE_INVERSE ? JSON.parse(process.env.FAKE_INVERSE) : null;
const malformedResults = {
  compile: () => ({ success: true, durationMs: 1, pageCount: 1, pdfWritten: true, dependencies: config.deps }),
  forward: () => ({ positions: 'none' }),
  wordCount: () => ({ total: 3 }),
  inverse: () => ({ path: 7, line: 0 }),
};
const stats = { initialize: 0, compile: 0, inFlight: 0, maxInFlight: 0, lastInitialize: null };
let initialized = false;
let compiled = false;
const NOT_COMPILED = { error: { message: 'no successful compilation yet' } };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function compileResult() {
  if (config.fail) {
    const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } };
    const diagnostics = [{ severity: 'error', message: 'unknown variable: nope', hints: [], path: config.deps[0] ?? null, range, trace: [] }];
    return { success: false, durationMs: 1, pageCount: null, pdfWritten: false, diagnostics, dependencies: config.deps };
  }
  return { success: true, durationMs: 1, pageCount: 1, pdfWritten: true, diagnostics: [], dependencies: config.deps };
}

function handle(id, method, params) {
  switch (method) {
    case 'initialize':
      stats.initialize++;
      stats.lastInitialize = params;
      initialized = true;
      return { result: { helperVersion: '0.0.0', typstVersion: '0.15.1' } };
    case 'compile': {
      if (!initialized) return { error: { message: 'not initialized' } };
      stats.compile++;
      if (config.malformed.includes('compile')) return { result: malformedResults.compile(), delayMs: config.delayMs };
      const result = compileResult();
      if (result.success) compiled = true;
      return { result, delayMs: config.delayMs };
    }
    case 'inverse':
    case 'forward':
    case 'wordCount':
      if (!initialized) return { error: { message: 'not initialized' } };
      if (!compiled) return NOT_COMPILED;
      if (config.malformed.includes(method)) return { result: malformedResults[method]() };
      if (method === 'inverse') return { result: inverseAnswer };
      return { result: method === 'forward' ? { positions: [] } : { total: config.words, files: [] } };
    case 'stats':
      return { result: stats };
    case 'configure':
      Object.assign(config, params);
      if (config.stubborn) setInterval(() => {}, 1000);
      return { result: null };
    case 'echo':
      return { result: params };
    case 'garbage':
      process.stdout.write('this is not json\n');
      return { result: 'after garbage' };
    case 'fail':
      return { error: { message: 'boom' } };
    case 'sleep':
      return undefined;
    case 'crash':
      process.exit(3);
      return undefined;
    case 'shutdown':
      if (config.stubborn) return undefined;
      process.stdout.write(`${JSON.stringify({ id, result: null })}\n`, () => process.exit(0));
      return undefined;
    default:
      return { error: { message: `unknown method: ${method}` } };
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: 0, error: { message: 'malformed request' } });
    return;
  }
  const { id, method, params } = request;
  const answer = handle(id, method, params);
  if (!answer) return;
  stats.inFlight++;
  stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
  const reply = () => {
    stats.inFlight--;
    send('error' in answer ? { id, error: answer.error } : { id, result: answer.result });
  };
  if (answer.delayMs) setTimeout(reply, answer.delayMs);
  else reply();
});
lines.on('close', () => {
  if (!config.stubborn) process.exit(0);
});
