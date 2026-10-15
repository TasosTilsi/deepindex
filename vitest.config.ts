import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // smoke.test.ts is a plain tsx script (run via `pnpm run smoke`), not a
    // vitest suite — keep it out of the test runner.
    exclude: ['tests/smoke.test.ts'],
    environment: 'node',
    // Coverage blind spot (issue #21): the CLI tests spawn `tsx src/cli.ts` in a child process,
    // which v8 cannot instrument, so src/cli.ts and src/scaffold.ts report 0% no matter how much
    // behaviour those tests drive. The aggregate (~73%) therefore says nothing about the largest
    // surface of the CLI, and a green gate here is not evidence for it. The real fix is to extract
    // each verb's logic into a module that can be tested in-process; until then, read this number
    // as "the library surface is covered", not "the tool is".
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
