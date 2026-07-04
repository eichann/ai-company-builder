import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // Build output / vendored artifacts are never linted.
  {
    ignores: [
      'dist',
      'dist-electron',
      'release',
      'out',
      'node_modules',
      '**/*.tsbuildinfo',
    ],
  },

  // Base JS + TypeScript (type-information-free `recommended`; no
  // parserOptions.project needed, so it stays fast and robust).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React Hooks: rules-of-hooks stays at error (this is what catches the
  // early-return-then-useState / stale-closure ordering violations we want
  // surfaced). exhaustive-deps is downgraded to warn because the existing
  // codebase has many pre-existing violations we are not fixing in this WP.
  reactHooks.configs['recommended-latest'],
  reactRefresh.configs.vite,

  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // src/ runs in the browser (renderer); electron/ runs in Node.
      // Enable both global sets so neither side produces no-undef noise.
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
