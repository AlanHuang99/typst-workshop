// Runs cargo with the given arguments; cargo is looked up on PATH, then in $CARGO_HOME/bin and ~/.cargo/bin.
// Usage: node scripts/cargo.mjs <cargo arguments> (npm run test:helper)
import { spawnSync } from 'node:child_process';
import { localCargo } from './platform.mjs';

try {
  const result = spawnSync(localCargo(), process.argv.slice(2), { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
