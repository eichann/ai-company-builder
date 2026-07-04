import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', '**/*.tsbuildinfo'],
  },

  // Base JS + TypeScript (type-information-free `recommended`; no
  // parserOptions.project needed, so it stays fast and robust).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Node-only backend (Hono); no React / browser globals.
      globals: {
        ...globals.node,
      },
    },
  },
);
