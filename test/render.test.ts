import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../src/render.js'
import { decodeDigest, findDigestLine } from '../src/digest.js'
import type { RunResults } from '../src/types.js'

function makeStats (over: Partial<RunResults> = {}): RunResults {
  return {
    files: 1,
    suites: 1,
    duration: 0,
    tests: 5,
    tests_succ: 3,
    tests_skip: 1,
    tests_fail: 1,
    tests_error: 0,
    runs: 5,
    runs_succ: 3,
    runs_skip: 1,
    runs_fail: 1,
    runs_error: 0,
    commit: 'abc1234567',
    ...over
  }
}

void test('text format: heading level 3, single line, embeds digest', () => {
  const body = renderReport(makeStats(), { title: 'Test Results', format: 'text' })
  assert.ok(body.startsWith('### Test Results'))
  assert.ok(body.includes(' · '))
  const line = findDigestLine(body)
  assert.ok(line !== undefined)
  assert.deepEqual(decodeDigest(line), makeStats())
})

void test('table format with headingLevel 2 renders a Markdown table', () => {
  const body = renderReport(makeStats(), {
    title: 'Results',
    format: 'table',
    headingLevel: 2
  })
  assert.ok(body.startsWith('## Results'))
  assert.ok(body.includes('| | Count |'))
})

void test('delta column appears when a previous run is given (table)', () => {
  const prev = makeStats({ tests: 4, tests_succ: 4, tests_fail: 0 })
  const body = renderReport(makeStats(), {
    title: 'R',
    format: 'table',
    previous: prev
  })
  assert.ok(body.includes('Δ'))
  assert.ok(body.includes('(+1)')) // tests 4 -> 5
  assert.ok(body.includes('±0')) // a metric that did not change
})

void test('delta in text format shows +/-/±0', () => {
  const prev = makeStats({ tests_fail: 3 })
  const body = renderReport(makeStats(), {
    title: 'R',
    format: 'text',
    previous: prev
  })
  assert.ok(body.includes('(-2)')) // tests_fail 3 -> 1
})

void test('commit line, details link, and marker are appended when set', () => {
  const body = renderReport(makeStats({ commit: 'deadbeefcafe' }), {
    title: 'R',
    format: 'text',
    commit: 'deadbeefcafe',
    detailsUrl: 'https://example.com/run/1',
    marker: '<!-- cinct -->'
  })
  assert.ok(body.includes('Results for commit deadbeef.'))
  assert.ok(body.includes('[View details](https://example.com/run/1)'))
  assert.ok(body.trimEnd().endsWith('<!-- cinct -->'))
})

void test('duration formats minutes for >= 60s', () => {
  const body = renderReport(makeStats({ duration: 125 }), {
    title: 'R',
    format: 'text'
  })
  assert.ok(body.includes('2m 5s'))
})

void test('duration formats seconds for < 60s', () => {
  const body = renderReport(makeStats({ duration: 42 }), {
    title: 'R',
    format: 'text'
  })
  assert.ok(body.includes('42s'))
})
