/**
 * Loaded before every test file.
 *
 * Two jobs, both about making a failing test mean what it says:
 *
 *  - The hub reads `DB_PATH` at boot. Pinning it to an in-memory database here means a suite
 *    that forgets to open its own can never reach the real `data/house.sqlite` and quietly
 *    mutate the running dev hub's house.
 *  - Timezone and locale are fixed, because half of this codebase reasons about quiet hours,
 *    sunrise and hourly buckets. A test that passes in Paris and fails in CI is worse than no
 *    test at all.
 */

process.env.DB_PATH = ':memory:'
process.env.TZ = 'Europe/Paris'
process.env.NODE_ENV = 'test'
