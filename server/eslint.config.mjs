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

  // Route guards (server.md "Route guards"): a route's handler gets the
  // signed-in user / company member from src/routes/guards.ts and its input
  // from body() / query() / serviceBody, never by hand.
  {
    files: ['src/routes/**/*.ts'],
    ignores: [
      'src/routes/guards.ts',
      // app-wide middleware (not a route): notes the app build of whoever is signed in, refuses nothing
      'src/routes/client-activity-middleware.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: '../lib/auth',
          importNames: ['getUserFromRequest'],
          message: 'Use a guard from ./guards (companyMember, signedIn, publicRoute) as the first handler.',
        }],
      }],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='json'][callee.object.property.name='req']",
          message: 'Read the body with body(schema) or serviceBody from ./guards (c.var.body).',
        },
        {
          selector: "CallExpression[callee.property.name='param'][callee.object.property.name='req'][arguments.0.value='companyId']",
          message: 'Use companyMember from ./guards and c.var.member.companyId (checked membership), not the URL.',
        },
      ],
    },
  },
);
