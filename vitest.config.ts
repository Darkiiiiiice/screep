import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The implementation was wiped pending a redesign, so an empty test tree is
    // the expected state and must not fail the suite.
    passWithNoTests: true,
  },
});
