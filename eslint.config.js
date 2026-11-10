// ESLint 9 flat config. Three environments, one file:
//   - backend (api/worker/db/scripts): CommonJS Node, jest globals in tests
//   - shared package: pure Node modules
//   - client: ESM + browser + React/JSX (vite)
// Prettier owns formatting; eslint-config-prettier turns off style rules so
// the two never fight.
const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.min.js'] },

  js.configs.recommended,

  // This config file itself is CommonJS Node.
  {
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },

  // Node-side code (CommonJS)
  {
    files: ['api/**/*.js', 'worker/**/*.js', 'db/**/*.js', 'scripts/**/*.js', 'packages/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2023,
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // scripts + migration runner talk to the terminal on purpose
    },
  },

  // Jest tests (both sides)
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js'],
    languageOptions: { globals: { ...globals.jest } },
  },

  // React client (ESM, browser, JSX). react/jsx-uses-vars is what tells
  // no-unused-vars that a component referenced in JSX is actually used.
  {
    files: ['client/**/*.js', 'client/**/*.jsx'],
    plugins: { react },
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // vite uses the automatic JSX runtime
      'react/prop-types': 'off', // no TypeScript, no prop-types in this project
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  prettier,
];
