import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // smoke.test.ts is a plain tsx script (run via `pnpm run smoke`), not a
    // vitest suite — keep it out of the test runner.
    exclude: ['tests/smoke.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types.ts'],
      enabled: process.env.CI === '1',
      reporter: ['text'],
      thresholds: { lines: 70 },
    },
  },
});
