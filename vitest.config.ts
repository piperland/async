import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Workers semantic tests need the built dist/ output and run under the
    // workerd pool in a dedicated job (test/workers/vitest.workers.config.mts),
    // not in this Node-environment suite.
    exclude: ['test/workers/**'],
    environment: 'node',
  },
});
