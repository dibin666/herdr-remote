// The TUI bundles CommonJS modules that use CommonJS globals at runtime:
// require.resolve() to locate the separately installed relay package, and
// __dirname to find the package root. ESM output provides neither, so both are
// reconstructed from the module URL.
//
// Shared by the real build and the render tests so the artifact under test is
// produced exactly the way the published one is.
export const cjsBanner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { dirname as __dirnameOf } from 'node:path';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __dirnameOf(__filename);',
].join('\n');
