// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'docs/.vitepress/cache/**', 'docs/api/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig
);
