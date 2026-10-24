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
      'test-results',
      'playwright-report',
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

  // A `const` read before its declaration line runs throws a TDZ
  // ReferenceError. In a React component that means a crash on the render
  // that reaches it — production once died with "Cannot access 'ge' before
  // initialization" from a ref read in a callback run during render, ~90
  // lines above `useRef`. `variables: true` reports references from nested
  // functions too, because a closure called synchronously (render, module
  // evaluation, a Promise executor) hits the TDZ just the same. Function
  // declarations are hoisted (no TDZ) and types are erased, so those stay
  // allowed. Mutually referencing locals (a `finish` that clears a timer
  // whose callback calls `finish`) declare `let timer` first and assign it
  // later; prefer-const's ignoreReadBeforeAssign accepts that shape.
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    rules: {
      '@typescript-eslint/no-use-before-define': ['error', {
        functions: false,
        classes: true,
        variables: true,
        typedefs: false,
        ignoreTypeReferences: true,
      }],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },

  // Main-process feature modules and services depend on interfaces
  // (electron/features/ports.ts, electron/ipc/registrar.ts), never on
  // Electron: only the shell (main.ts, preload.ts, electron-adapter.ts,
  // voice-input.ts) imports it, so another desktop shell replaces that layer
  // only. CLAUDE.md "Main process layout".
  {
    files: ['electron/features/**/*.ts', 'electron/services/**/*.ts', 'electron/ipc/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'electron', message: 'Feature modules take what they need from the shell through deps (electron/features/ports.ts).' }],
      }],
    },
  },
);
