import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Kernel-invariant guard: `src/domain/**` is pure logic and must never touch
// engine globals. `src/game/**` is the only layer allowed to import them.
//
// This rule is the load-bearing safety net of the whole project: with no local
// engine harness, domain code that reads Game/Room/Creep directly can only be
// validated by burning deploy quota against the live world.
const ENGINE_GLOBALS = [
  'Game',
  'Memory',
  'RawMemory',
  'PathFinder',
  'InterShardMemory',
];

const engineGlobalRestrictions = ENGINE_GLOBALS.map((name) => ({
  name,
  message: `'${name}' is an engine global. src/domain/** is pure logic — read state through a port interface and let src/colony wire it.`,
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
    // The domain layer is pure: no engine globals, no adapter imports, no I/O.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/game/**',
                '**/kernel/**',
                '**/colony/**',
                '@/game/*',
                '@/kernel/*',
                '@/colony/*',
              ],
              message:
                'src/domain/** must import nothing engine-aware (directly or transitively). Define a port interface; src/colony wires it.',
            },
            {
              group: ['node:*', 'fs', 'path', 'screeps-api'],
              message: 'src/domain/** must stay pure — no I/O, no host APIs.',
            },
          ],
        },
      ],
    },
  },

  {
    // Engine-aware layers. Only `src/domain/**` is held to the pure-logic bar;
    // the kernel is infrastructure that legitimately reads Game.cpu, and game/
    // is the adapter to the engine by definition.
    files: [
      'src/kernel/**/*.ts',
      'src/game/**/*.ts',
      'src/main.ts',
      'src/colony/**/*.ts',
      'test/**/*.ts',
    ],
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  prettier,
);
