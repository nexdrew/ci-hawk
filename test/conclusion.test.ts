import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getConclusion, actionFailRequired } from '../src/conclusion.js'
import type { RunResults } from '../src/types.js'

/** Build a RunResults with sane zero defaults, overridden per case. */
function makeStats (overrides: Partial<RunResults> = {}): RunResults {
  return {
    files: 1,
    suites: 1,
    duration: 0,
    tests: 0,
    tests_succ: 0,
    tests_skip: 0,
    tests_fail: 0,
    tests_error: 0,
    runs: 0,
    runs_succ: 0,
    runs_skip: 0,
    runs_fail: 0,
    runs_error: 0,
    commit: 'abc123',
    ...overrides
  }
}

// fail_on presets mirroring the action's three modes.
const failOnNothing = { failOnFailures: false, failOnErrors: false }
const failOnTestFailures = { failOnFailures: true, failOnErrors: true }
const failOnErrorsOnly = { failOnFailures: false, failOnErrors: true }

void test('files === 0 -> neutral regardless of fail flags', () => {
  const stats = makeStats({ files: 0, runs_fail: 5, runs_error: 5 })
  assert.equal(getConclusion(stats, failOnNothing), 'neutral')
  assert.equal(getConclusion(stats, failOnTestFailures), 'neutral')
  assert.equal(getConclusion(stats, failOnErrorsOnly), 'neutral')
})

void test('fail_on "nothing" -> success even with runs_fail/runs_error > 0 (advisory guarantee)', () => {
  assert.equal(getConclusion(makeStats({ runs_fail: 3 }), failOnNothing), 'success')
  assert.equal(getConclusion(makeStats({ runs_error: 3 }), failOnNothing), 'success')
  assert.equal(
    getConclusion(makeStats({ runs_fail: 3, runs_error: 3 }), failOnNothing),
    'success'
  )
})

void test('fail_on "test failures" -> failure on runs_fail > 0', () => {
  assert.equal(getConclusion(makeStats({ runs_fail: 1 }), failOnTestFailures), 'failure')
})

void test('fail_on "test failures" -> failure on runs_error > 0', () => {
  assert.equal(getConclusion(makeStats({ runs_error: 1 }), failOnTestFailures), 'failure')
})

void test('fail_on "test failures" -> success when no failures or errors', () => {
  assert.equal(getConclusion(makeStats({ runs_succ: 5 }), failOnTestFailures), 'success')
})

void test('fail_on "errors" -> success on runs_fail > 0 only', () => {
  assert.equal(getConclusion(makeStats({ runs_fail: 4 }), failOnErrorsOnly), 'success')
})

void test('fail_on "errors" -> failure on runs_error > 0', () => {
  assert.equal(getConclusion(makeStats({ runs_error: 1 }), failOnErrorsOnly), 'failure')
})

void test('parseErrors with failOnErrors -> failure even when run counts are clean', () => {
  assert.equal(
    getConclusion(makeStats({ runs_succ: 5 }), { ...failOnErrorsOnly, parseErrors: 1 }),
    'failure'
  )
})

void test('parseErrors ignored when failOnErrors is false', () => {
  assert.equal(
    getConclusion(makeStats({ runs_succ: 5 }), { ...failOnNothing, parseErrors: 1 }),
    'success'
  )
})

void test('actionFailRequired: failure + actionFail true -> true (regardless of inconclusive flag)', () => {
  assert.equal(actionFailRequired('failure', true, false), true)
  assert.equal(actionFailRequired('failure', true, true), true)
})

void test('actionFailRequired: failure + actionFail false -> false (regardless of inconclusive flag)', () => {
  assert.equal(actionFailRequired('failure', false, false), false)
  assert.equal(actionFailRequired('failure', false, true), false)
})

void test('actionFailRequired: neutral + actionFailOnInconclusive true -> true (regardless of actionFail)', () => {
  assert.equal(actionFailRequired('neutral', false, true), true)
  assert.equal(actionFailRequired('neutral', true, true), true)
})

void test('actionFailRequired: neutral + actionFailOnInconclusive false -> false', () => {
  assert.equal(actionFailRequired('neutral', false, false), false)
  assert.equal(actionFailRequired('neutral', true, false), false)
})

void test('actionFailRequired: success -> false regardless of flags', () => {
  assert.equal(actionFailRequired('success', true, true), false)
  assert.equal(actionFailRequired('success', false, false), false)
  assert.equal(actionFailRequired('success', true, false), false)
  assert.equal(actionFailRequired('success', false, true), false)
})
