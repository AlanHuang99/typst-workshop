function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What is wrong with a helper result in the fields the extension reads, or undefined when it is usable. */
export function resultProblem(method: string, result: unknown): string | undefined {
  switch (method) {
    case 'compile':
      if (!isObject(result)) return 'not an object';
      if (typeof result.success !== 'boolean') return 'success is not a boolean';
      if (typeof result.pdfWritten !== 'boolean') return 'pdfWritten is not a boolean';
      if (typeof result.durationMs !== 'number') return 'durationMs is not a number';
      if (result.pageCount !== null && typeof result.pageCount !== 'number') return 'pageCount is neither a number nor null';
      if (!Array.isArray(result.diagnostics)) return 'diagnostics is not an array';
      if (!Array.isArray(result.dependencies)) return 'dependencies is not an array';
      return undefined;
    case 'forward':
      if (!isObject(result)) return 'not an object';
      return Array.isArray(result.positions) ? undefined : 'positions is not an array';
    case 'wordCount':
      if (!isObject(result)) return 'not an object';
      if (typeof result.total !== 'number') return 'total is not a number';
      return Array.isArray(result.files) ? undefined : 'files is not an array';
    case 'inverse':
      if (result === null) return undefined;
      if (!isObject(result)) return 'neither an object nor null';
      if (typeof result.path !== 'string') return 'path is not a string';
      return typeof result.line === 'number' && typeof result.character === 'number' ? undefined : 'line or character is not a number';
    default:
      return undefined;
  }
}
