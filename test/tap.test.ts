import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTap, isTap } from '../src/parse/tap.js'
import { aggregate } from '../src/results.js'
import type { ParsedFile, TestCase } from '../src/types.js'

const content = readFileSync(
  join(import.meta.dirname, 'fixtures/tap/sample.tap'),
  'utf8'
)

/** The cases of the single flat suite a TAP document parses into. */
function firstCases (parsed: ParsedFile): TestCase[] {
  const suite = parsed.suites[0]
  assert.ok(suite !== undefined, 'expected one suite')
  return suite.cases
}

function caseNamed (cases: TestCase[], name: string): TestCase {
  const c = cases.find((tc) => tc.testName === name)
  assert.ok(c !== undefined, `expected a case named ${name}`)
  return c
}

void test('detects TAP by version header + plan/points', () => {
  assert.equal(isTap(content, 'out.tap'), true)
})

void test('detect is conservative: false on unrelated content', () => {
  assert.equal(isTap('<testsuites><testsuite/></testsuites>', 'x.xml'), false)
  assert.equal(isTap('just some prose with the word ok in it', 'notes.txt'), false)
  assert.equal(isTap('{"json": true}', 'data.json'), false)
})

void test('detect: plan + point without version header still matches', () => {
  assert.equal(isTap('1..1\nok 1 - works\n'), true)
})

void test('parses into a single flat suite with one case per top-level point', () => {
  const parsed = parseTap(content, 'bun/sample.tap')
  assert.equal(parsed.file, 'bun/sample.tap')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.name, '')
  // 9 top-level points; the indented subtest points are flattened away
  assert.equal(firstCases(parsed).length, 9)
})

void test('status mapping: ok->success, not ok->failure', () => {
  const cases = firstCases(parseTap(content))
  assert.equal(caseNamed(cases, 'adds two numbers').result, 'success')
  assert.equal(caseNamed(cases, 'divides by zero').result, 'failure')
  assert.equal(caseNamed(cases, 'parses malformed input').result, 'failure')
})

void test('className empty, testName strips "- ", time null', () => {
  const c = caseNamed(firstCases(parseTap(content)), 'adds two numbers')
  assert.equal(c.className, '')
  assert.equal(c.testName, 'adds two numbers')
  assert.equal(c.time, null)
})

void test('SKIP directive -> skipped with reason as message', () => {
  const c = caseNamed(firstCases(parseTap(content)), 'trims whitespace')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, 'not implemented on this platform')
})

void test('TODO directive -> skipped (not a failure) with reason as message', () => {
  const c = caseNamed(firstCases(parseTap(content)), 'flaky network call')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, 'investigate intermittent failure')
})

void test('YAML diagnostic block captured as content; message: surfaced', () => {
  const c = caseNamed(firstCases(parseTap(content)), 'divides by zero')
  assert.equal(c.message, 'expected 0 to be finite')
  assert.ok(c.content !== undefined)
  assert.ok(c.content.includes('severity: fail'))
  assert.ok(c.content.includes('line: 42'))
})

void test('failure with double-quoted message: unquoted', () => {
  const c = caseNamed(firstCases(parseTap(content)), 'parses malformed input')
  assert.equal(c.message, 'unexpected token at position 3')
})

// Directive parsing edge cases (regression for the unanchored-directive bug):
// the description ends at the first UNESCAPED '#'.
void test('escaped \\# in a description is a literal, not a directive', () => {
  const cases = firstCases(parseTap('1..1\nnot ok 1 - rejects \\# TODO markers\n'))
  const c = caseNamed(cases, 'rejects # TODO markers')
  // stays a failure; the escaped '#' is unescaped to a literal in the name
  assert.equal(c.result, 'failure')
})

void test('a plain (non SKIP/TODO) trailing comment does not change status', () => {
  const cases = firstCases(parseTap('1..1\nnot ok 1 - boom # see issue 42\n'))
  const c = caseNamed(cases, 'boom')
  assert.equal(c.result, 'failure')
})

void test('failure with a YAML block that has no message: leaves message undefined', () => {
  const input = [
    '1..1',
    'not ok 1 - no message key',
    '  ---',
    '  severity: fail',
    '  line: 7',
    '  ...'
  ].join('\n')
  const c = caseNamed(firstCases(parseTap(input)), 'no message key')
  assert.equal(c.result, 'failure')
  assert.equal(c.message, undefined)
  assert.ok(c.content !== undefined)
  assert.ok(c.content.includes('severity: fail'))
})

void test('SKIP directive with no reason -> skipped with undefined message', () => {
  const c = caseNamed(firstCases(parseTap('1..1\nok 1 - bare skip # SKIP\n')), 'bare skip')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, undefined)
})

void test('a top-level point on the final line (no trailing newline) parses', () => {
  // The point is the very last array element after splitting, so the YAML
  // look-ahead reads past the end of the lines array.
  const cases = firstCases(parseTap('1..1\nok 1 - last line'))
  const c = caseNamed(cases, 'last line')
  assert.equal(c.result, 'success')
  assert.equal(c.content, undefined)
})

void test('detect: version header + point without a plan still matches', () => {
  assert.equal(isTap('TAP version 14\nok 1 - works\n'), true)
})

void test('detect: a .tap path with a point but no version/plan matches', () => {
  assert.equal(isTap('ok 1 - works\n', 'results.tap'), true)
})

void test('detect: a non-.tap path with only a lone point does not match', () => {
  assert.equal(isTap('ok 1 - works\n', 'results.txt'), false)
})

void test('aggregate() produces expected stats', () => {
  const parsed = parseTap(content, 'bun/sample.tap')
  const stats = aggregate([parsed], { commit: 'abc123' })

  assert.equal(stats.files, 1)
  assert.equal(stats.suites, 1)
  assert.equal(stats.duration, 0)

  // 9 distinct (className,testName) pairs
  assert.equal(stats.tests, 9)
  assert.equal(stats.tests_succ, 5)
  assert.equal(stats.tests_skip, 2)
  assert.equal(stats.tests_fail, 2)
  assert.equal(stats.tests_error, 0)

  assert.equal(stats.runs, 9)
  assert.equal(stats.runs_succ, 5)
  assert.equal(stats.runs_skip, 2)
  assert.equal(stats.runs_fail, 2)
  assert.equal(stats.runs_error, 0)

  assert.equal(stats.commit, 'abc123')
})
