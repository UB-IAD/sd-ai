import { test } from '@jest/globals';

/**
 * `test` for the eval tests that run PySD simulations: skipped unless SDAI_SIM_TESTS=on.
 *
 * Each simulation starts a Python process and imports PySD. Together these tests take close to an hour
 * even with a warm evals/.simcache, and hours without one (as in CI), so a plain `npm test` skips them.
 * Run them with `SDAI_SIM_TESTS=on npm test` after changing a generator, a scenario, a committed key or
 * the simulator. A test that takes a second or more with SDAI_SIM_CACHE=off belongs here, so that no
 * eval test file outlasts the slowest unit test file (tests/agent/RagStore.test.js).
 */
export const simTest = process.env.SDAI_SIM_TESTS === 'on' ? test : test.skip;
