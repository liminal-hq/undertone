import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Two projects. `reference` is the TypeScript reference suite (src/, docs tooling, conformance), which needs nothing built.
// `package` is the bridge package's own suite (packages/undertone/test), which runs against the built module: it is included
// when `bun run package:build` has produced dist/ and wasm/, and `bun run package:test` always runs it (and fails if they
// are missing). So `bun run test` stays runnable on a checkout that has not built the WebAssembly module.
const packageBuilt =
  existsSync('packages/undertone/dist/index.node.js') &&
  existsSync('packages/undertone/wasm/undertone_wasm_bg.wasm');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'reference',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'packages/**', 'crates/**', 'spikes/**']
        }
      },
      ...(packageBuilt ? ['packages/undertone'] : [])
    ]
  }
});
