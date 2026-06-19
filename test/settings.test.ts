import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSettings } from '../src/settings.js'

// Inputs @actions/core reads as INPUT_<UPPER_SNAKE>. We clear all of them so a
// test sees only what it sets, then restore the previous environment.
const INPUT_NAMES = [
  'github_token', 'github_retries', 'files', 'check_name', 'comment_title',
  'comment_mode', 'fail_on', 'action_fail', 'action_fail_on_inconclusive',
  'compare_to_earlier_commit', 'report_format', 'time_unit', 'commit',
  'check_run', 'job_summary', 'json_file'
]

function envKey (name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
}

function withInputs<T> (inputs: Record<string, string>, fn: () => T): T {
  const keys = INPUT_NAMES.map(envKey).concat('GITHUB_SHA')
  const saved = new Map<string, string | undefined>()
  for (const k of keys) {
    saved.set(k, process.env[k])
    Reflect.deleteProperty(process.env, k)
  }
  try {
    for (const [name, value] of Object.entries(inputs)) {
      process.env[name === 'GITHUB_SHA' ? name : envKey(name)] = value
    }
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = v
    }
  }
}

void test('defaults when no inputs are set', () => {
  const s = withInputs({ GITHUB_SHA: 'sha123' }, getSettings)
  assert.equal(s.timeFactor, 1.0)
  assert.equal(s.format, 'text')
  assert.equal(s.checkName, 'Test Results')
  assert.equal(s.commentTitle, 'Test Results') // defaults to checkName
  assert.equal(s.commentMode, 'always')
  assert.equal(s.jobSummary, true)
  assert.equal(s.checkRun, true)
  assert.equal(s.failOnFailures, true) // fail_on defaults to "test failures"
  assert.equal(s.failOnErrors, true)
  assert.equal(s.actionFail, false)
  assert.equal(s.actionFailOnInconclusive, false)
  assert.equal(s.compareEarlier, true)
  assert.equal(s.retries, 10)
  assert.equal(s.jsonFile, undefined)
  assert.equal(s.commit, 'sha123')
  assert.deepEqual(s.filesGlobs, [])
})

void test('fail_on "errors" sets only failOnErrors', () => {
  const s = withInputs({ fail_on: 'errors' }, getSettings)
  assert.equal(s.failOnFailures, false)
  assert.equal(s.failOnErrors, true)
})

void test('fail_on "nothing" clears both fail flags', () => {
  const s = withInputs({ fail_on: 'nothing' }, getSettings)
  assert.equal(s.failOnFailures, false)
  assert.equal(s.failOnErrors, false)
})

void test('report_format table and time_unit milliseconds', () => {
  const s = withInputs(
    { report_format: 'table', time_unit: 'milliseconds' },
    getSettings
  )
  assert.equal(s.format, 'table')
  assert.equal(s.timeFactor, 0.001)
})

void test('boolean inputs: true / false / invalid falls back to default', () => {
  const s = withInputs(
    { job_summary: 'false', check_run: 'false', action_fail: 'true' },
    getSettings
  )
  assert.equal(s.jobSummary, false)
  assert.equal(s.checkRun, false)
  assert.equal(s.actionFail, true)

  const invalid = withInputs({ job_summary: 'maybe' }, getSettings)
  assert.equal(invalid.jobSummary, true) // invalid -> default true
})

void test('github_retries: valid, invalid, and negative fall back to 10', () => {
  assert.equal(withInputs({ github_retries: '3' }, getSettings).retries, 3)
  assert.equal(withInputs({ github_retries: 'abc' }, getSettings).retries, 10)
  assert.equal(withInputs({ github_retries: '-1' }, getSettings).retries, 10)
})

void test('comment_mode off, json_file, multiline files, commit override', () => {
  const s = withInputs(
    {
      comment_mode: 'off',
      json_file: 'out.json',
      files: 'a.xml\n  b.xml  \n\nc.xml',
      commit: 'override-sha',
      GITHUB_SHA: 'env-sha',
      comment_title: 'Custom'
    },
    getSettings
  )
  assert.equal(s.commentMode, 'off')
  assert.equal(s.jsonFile, 'out.json')
  assert.deepEqual(s.filesGlobs, ['a.xml', 'b.xml', 'c.xml']) // trimmed, blanks dropped
  assert.equal(s.commit, 'override-sha') // input wins over GITHUB_SHA
  assert.equal(s.commentTitle, 'Custom')
})
