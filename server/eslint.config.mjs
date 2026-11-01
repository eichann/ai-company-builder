import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Route files still checking the session by hand: the same list as
// tests/security/auth-guards.test.ts NOT_YET_GUARDED (server.md "Route guards").
// One file per line, so lanes removing different files do not conflict.
const NOT_YET_GUARDED = [
  'agent-events.ts',
  'ai-runs.ts',
  'broker-relay.ts',
  'companies.ts',
  'company-files.ts',
  'departments.ts',
  'folder-sizes.ts',
  'git-http.ts',
  'git.ts',
  'google-drive.ts',
  'google.ts',
  'identities.ts',
  'inbox.ts',
  'invitations.ts',
  'oauth.ts',
  'outbound-mail.ts',
  'permission-rules.ts',
  'permissions.ts',
  'plugins.ts',
  'private-folders.ts',
  'records-ai-identities.ts',
  'records-ai-inbox.ts',
  'records-ai.ts',
  'records.ts',
  'slack-connection.ts',
];

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
  // from body() / query() / serviceBody, never by hand. Files not yet moved
  // only warn (NOT_YET_GUARDED above); that list only shrinks.
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
  {
    files: NOT_YET_GUARDED.map(f => `src/routes/${f}`),
    rules: { 'no-restricted-imports': 'warn', 'no-restricted-syntax': 'warn' },
  },
);
