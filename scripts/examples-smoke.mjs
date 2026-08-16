// Smoke-run every tracked example against the BUILT local package entry,
// ensuring examples do not rot. Each example exits non-zero on failure.
// Invoked by CI's `test` job (folds into the package check, no new job).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const examples = ['http-fanout', 'structured-request', 'retry-with-timeout', 'async-iterable'];
let failed = false;
for (const name of examples) {
  const file = join(root, 'examples', `${name}.mjs`);
  const r = spawnSync(process.execPath, [file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ok = r.status === 0;
  console.log(`${ok ? '✓' : '✗'} examples/${name}.mjs${ok ? '' : '\n' + (r.stdout + r.stderr).split('\n').slice(-4).join('\n')}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
