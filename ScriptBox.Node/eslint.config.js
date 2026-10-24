// Lint rules that hold the trust boundary: no `any`, no type assertions other
// than `as const`, no non-null assertions and no comments that switch the
// type checker off.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // test/consumer resolves the package only where it is installed: the package
  // test type-checks it there under its own strict configuration.
  { ignores: ['dist/**', 'node_modules/**', 'bench/results/**', 'test/consumer/**', '**/*.js', '**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: true }],
      'no-control-regex': 'off',
      // node:test registers tests through promises it tracks itself.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'test', 'it', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }],
      }],
    },
  },
);
