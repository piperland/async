// PIPER ASYNC — Workers vitest config (uses @cloudflare/vitest-pool-workers).
// Runs test/workers/workers-semantic.test.ts inside a real workerd runtime.
// This is the official Cloudflare Vitest integration, not raw Miniflare.

import { defineConfig } from 'vitest/config';
import { cloudflarePool } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    include: ['test/workers/workers-semantic.test.ts'],
    pool: cloudflarePool({
      miniflare: {
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  },
});
