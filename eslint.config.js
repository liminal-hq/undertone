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
      // The TypeScript declarations ts-rs writes (generated, checked by a Rust test).
      'crates/undertone-wasm/bindings/**',
      // Throwaway spike code (docs/rust-migration/milestones/M2-spikes.md) is not linted; Prettier still checks it.
      'spikes/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    // The worklet harness pages are plain browser scripts (no bundler, no build), so they read the browser's globals.
    files: ['packages/undertone/harness/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'navigator',
          'location',
          'performance',
          'setTimeout',
          'setInterval',
          'clearInterval',
          'URLSearchParams',
          'AudioContext',
          'OfflineAudioContext',
          'AudioWorkletNode'
        ].map((name) => [name, 'readonly'])
      )
    }
  }
);
