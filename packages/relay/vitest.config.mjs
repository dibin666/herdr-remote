import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'relay',
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Each file in its own process, as `node --test` ran them: the suites
    // bind real ports and some reset module state through require.cache.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
