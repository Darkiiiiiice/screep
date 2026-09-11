import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Architecture guard, kept from the previous design and re-armed for the
// redesign: the pure-logic layer must never touch engine globals, and exactly
// one adapter layer is allowed to import them.
//
// The `src/domain/**` override below is inert until that directory exists again;
// it is left in place because it is the load-bearing safety net — pure-logic
// code that reads Game/Room/Creep directly is not verifiable by unit tests at
// all.
const ENGINE_GLOBALS = [
  'Game',
  'Memory',
  'RawMemory',
  'PathFinder',
  'InterShardMemory',
];

const engineGlobalRestrictions = ENGINE_GLOBALS.map((name) => ({
  name,
  message: `'${name}' is an engine global. The pure-logic layer — read state through a port interface and let the adapter wire it.`,
}));

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...engineGlobalRestrictions],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'screeps-api'],
              message: 'The pure-logic layer must stay pure — no I/O, no host APIs.',
            },
          ],
        },
      ],
    },
  },

  {
    // The engine-facing entrypoint and the node-side tooling legitimately touch
    // engine globals and the filesystem.
    files: ['src/main.ts', 'scripts/**/*.mjs', 'test/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  prettier,
);

