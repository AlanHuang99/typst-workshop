/** The log lines written after `before` (a copy of the tap's lines taken earlier), from the tap's current lines `now`. The tap keeps its latest 500 lines, so the earlier lines it still holds are a prefix of `now`; the longest such prefix marks where the new lines start. */
export function linesSince(before: readonly string[], now: readonly string[]): string[] {
  for (let dropped = 0; dropped < before.length; dropped++) {
    const kept = before.length - dropped;
    if (kept <= now.length && before.slice(dropped).every((line, k) => now[k] === line)) return now.slice(kept);
  }
  return [...now];
}
