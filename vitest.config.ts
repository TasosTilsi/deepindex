import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // smoke.test.ts is a plain tsx script (run via `pnpm run smoke`), not a
    // vitest suite — keep it out of the test runner.
    exclude: ['tests/smoke.test.ts'],
    environment: 'node',
    // Each run gets its own project registry (see the file): the suite must not write user state.
    setupFiles: ['tests/setup-registry.ts'],
    // 20 s, not the 5 s default. Every CLI test spawns `tsx` in a child process (~0.5 s each, up to
    // 7 s for a test that spawns several), and the default budget turned a loaded machine into
    // intermittent red: measured 4.1 s against 5 s on the suite that blocked the release, and three
    // such timeouts while another agent ran the same suite concurrently. The budget is a ceiling for
    // a hung test, not a performance assertion.
    testTimeout: 20_000,
    // Coverage blind spot (issue #21): the CLI tests spawn `tsx src/cli.ts` in a child process,
    // which v8 cannot instrument, so src/cli.ts and src/scaffold.ts report 0% no matter how much
    // behaviour those tests drive. The aggregate (~73%) therefore says nothing about the largest
    // surface of the CLI, and a green gate here is not evidence for it. The real fix is to extract
    // each verb's logic into a module that can be tested in-process; until then, read this number
    // as "the library surface is covered", not "the tool is".
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Only types.ts is excluded. `src/**/*.test.ts` used to be listed too; no such file exists,
      // so it only implied a protection that was never needed.
      exclude: ['src/types.ts'],
      enabled: process.env.CI === '1',
      reporter: ['text'],
      thresholds: { lines: 70 },
    },
  },
});
