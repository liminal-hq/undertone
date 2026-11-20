// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'docs/.vitepress/cache/**',
      'docs/api/**',
      'docs/public/rust/**',
      'docs/public/rust-audio/**',
      'docs/public/ts-audio/**',
      'target/**',
      'test-results/**',
      // The wasm-bindgen glue scripts/build-wasm.sh writes (generated, gitignored).
      'packages/undertone/wasm/**',
      // Throwaway spike code (docs/rust-migration/milestones/M2-spikes.md) is not linted; Prettier still checks it.
      'spikes/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig
);
