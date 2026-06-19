import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSettings } from '../src/settings.js'
import { parseContent } from '../src/parse/registry.js'
import { aggregate } from '../src/results.js'
import { getConclusion, actionFailRequired } from '../src/conclusion.js'

// Integration test: prove cinct can replace this exact EnricoMi usage as an
// ADVISORY reporter (the step reports failing tests but never fails the job):
//
//   uses: EnricoMi/publish-unit-test-result-action/windows@v2
//   with:
//     files: test-results.xml
//     fail_on: nothing
//
// All assertions are pure logic, no GitHub API.

// A minimal JUnit document with one failing test, named to match the
// `files: test-results.xml` input.
const FAILING_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="2" failures="1" errors="0" skipped="0">
    <testcase classname="pkg.Thing" name="passes"/>
    <testcase classname="pkg.Thing" name="breaks">
      <failure message="boom">expected true to be false</failure>
    </testcase>
  </testsuite>
</testsuites>
`

/**
 * Run `fn` with the given INPUT_* env vars set (and any others that could
 * influence getSettings cleared), restoring the prior environment afterwards.
 * Keeps each test hermetic and prevents env leaking between tests.
 */
function withInputs (inputs: Record<string, string>, fn: () => void): void {
  // INPUT_* names @actions/core might read for the inputs getSettings consumes.
  const managed = [
    'INPUT_FAIL_ON',
    'INPUT_FILES',
    'INPUT_TIME_UNIT',
    'INPUT_REPORT_FORMAT',
    'INPUT_CHECK_NAME',
    'INPUT_COMMENT_MODE',
    'INPUT_COMMENT_TITLE',
    'INPUT_JSON_FILE',
    'INPUT_JOB_SUMMARY',
    'INPUT_CHECK_RUN',
    'INPUT_GITHUB_TOKEN',
    'INPUT_COMMIT',
    'INPUT_GITHUB_RETRIES',
    'INPUT_ACTION_FAIL',
    'INPUT_ACTION_FAIL_ON_INCONCLUSIVE',
    'INPUT_COMPARE_TO_EARLIER_COMMIT'
  ]
  const saved = new Map<string, string | undefined>()
  for (const key of managed) {
    saved.set(key, process.env[key])
    // Start from a clean slate so unrelated inputs use their fallbacks.
    Reflect.deleteProperty(process.env, key)
  }
  try {
    for (const [name, value] of Object.entries(inputs)) {
      process.env[name] = value
    }
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

void test('fail_on: nothing yields an advisory (non-failing) configuration', () => {
  // @actions/core getInput('fail_on') reads INPUT_FAIL_ON.
  withInputs({ INPUT_FAIL_ON: 'nothing', INPUT_FILES: 'test-results.xml' }, () => {
    const settings = getSettings()
    assert.equal(settings.failOnFailures, false)
    assert.equal(settings.failOnErrors, false)
    assert.equal(settings.actionFail, false)
  })
})

void test('a failing test report still concludes success and never fails the step', () => {
  const parsed = parseContent(FAILING_JUNIT, 'test-results.xml')
  const stats = aggregate([parsed], { commit: 'abc123' })

  // Sanity: the report genuinely contains a failure.
  assert.ok(stats.runs_fail > 0, 'expected at least one failing run')
  assert.equal(stats.tests_fail, 1)

  // Advisory: failures are present, but with fail_on: nothing the conclusion is
  // success.
  const conclusion = getConclusion(stats, {
    failOnFailures: false,
    failOnErrors: false
  })
  assert.equal(conclusion, 'success')

  // And the action step itself must not be marked as failed.
  assert.equal(actionFailRequired(conclusion, false, false), false)
})
