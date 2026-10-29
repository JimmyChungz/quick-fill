import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    maxWorkers: 4, // Bound CPU contention from real PBKDF2 and jsdom environments.
    setupFiles: ['test/setup-layout.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {provider:'v8',include:['src/**/*.ts'],exclude:['src/types/**'],reporter:['text','json-summary','html'],reportsDirectory:'release-evidence/coverage-0.6.2',thresholds:{statements:85,branches:80,functions:80,lines:85}},
  },
});
