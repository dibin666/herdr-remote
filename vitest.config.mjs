import { defineConfig } from 'vitest/config';

// `npm test` at the root runs every package's suite; each package keeps its
// own config for environment, setup files and timeouts.
export default defineConfig({
  test: {
    projects: ['packages/relay', 'packages/cli', 'packages/relay/web'],
  },
});
