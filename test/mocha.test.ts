import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMochaJson, isMochaJson } from '../src/parse/mocha.js'
import { aggregate } from '../src/results.js'
import type { TestCase } from '../src/types.js'

/**
 * True if the string contains any stripped control character (code point < 32)
 * other than the newlines we intentionally join error parts with. The Mocha
 * port strips C0 controls (incl. the ESC, 27, that opens ANSI colour codes)
 * and rejoins the surviving parts with '\n'.
 */
function hasControlChar (s: string): boolean {
  for (const ch of s) {
    const n = ch.charCodeAt(0)
    if (n < 32 && n !== 10) return true
  }
  return false
}

const content = readFileSync(
  join(import.meta.dirname, 'fixtures/mocha/tests.json'),
  'utf8'
)
const emptyContent = readFileSync(
  join(import.meta.dirname, 'fixtures/mocha/empty.json'),
  'utf8'
)

function caseNamed (cases: TestCase[], fullTitle: string): TestCase {
  const c = cases.find((c) => c.testName === fullTitle)
  assert.ok(c !== undefined, `expected a case named ${fullTitle}`)
  return c
}

void test('detects Mocha JSON by stats.suites + tests[].fullTitle', () => {
  assert.equal(isMochaJson(content, 'tests.json'), true)
  assert.equal(isMochaJson(emptyContent, 'empty.json'), true)
})

void test('detect is conservative: rejects unrelated/invalid content', () => {
  assert.equal(isMochaJson('not json at all', 'x.json'), false)
  assert.equal(isMochaJson('<testsuite/>', 'x.xml'), false)
  // valid JSON, but not a Mocha document
  assert.equal(isMochaJson('{"foo":1}', 'x.json'), false)
  // stats present but no suites key
  assert.equal(
    isMochaJson('{"stats":{},"tests":[]}', 'x.json'),
    false
  )
  // a test entry missing fullTitle
  assert.equal(
    isMochaJson('{"stats":{"suites":1},"tests":[{"title":"a"}]}', 'x.json'),
    false
  )
  // non-.json path is rejected outright
  assert.equal(isMochaJson(content, 'tests.txt'), false)
  // valid JSON that is not an object (root === undefined branch)
  assert.equal(isMochaJson('[1,2,3]', 'x.json'), false)
  assert.equal(isMochaJson('"a string"', 'x.json'), false)
  // suites present but tests is not an array
  assert.equal(
    isMochaJson('{"stats":{"suites":1},"tests":{}}', 'x.json'),
    false
  )
  // a tests entry that is not an object (asObj -> undefined)
  assert.equal(
    isMochaJson('{"stats":{"suites":1},"tests":[1]}', 'x.json'),
    false
  )
  // empty .json with no path still allowed through the path guard
  assert.equal(isMochaJson('{"foo":1}', ''), false)
})

void test('builds a single leaf suite holding every test as a case', () => {
  const parsed = parseMochaJson(content, 'tests.json')
  assert.equal(parsed.file, 'tests.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.cases.length, 5)
})

void test('status mapping: success / skipped / failure / error', () => {
  const cases = parseMochaJson(content, 'tests.json').suites[0]?.cases ?? []

  assert.equal(
    caseNamed(cases, 'Context nested should work').result,
    'success'
  )
  // pending entry -> skipped
  assert.equal(
    caseNamed(
      cases,
      'Mocha instance method run() should initialize the stats collector'
    ).result,
    'skipped'
  )
  // err without errorMode -> failure
  assert.equal(
    caseNamed(
      cases,
      'Runner instance method grep() should update the runner.total with number of matched tests'
    ).result,
    'failure'
  )
  // err with errorMode -> error
  assert.equal(
    caseNamed(cases, 'Test .clone() should copy the title').result,
    'error'
  )
})

void test('failure message is err.message and content is name+message+stack', () => {
  const cases = parseMochaJson(content, 'tests.json').suites[0]?.cases ?? []
  const failing = caseNamed(
    cases,
    'Runner instance method grep() should update the runner.total with number of matched tests'
  )
  assert.equal(failing.message, 'Required')
  // err has no name; content = message + stack, control chars stripped
  assert.ok(failing.content !== undefined)
  assert.ok(failing.content.startsWith('Required\n'))
  assert.ok(failing.content.includes('Error: Required'))
  // no raw control characters survive
  assert.equal(hasControlChar(failing.content), false)
})

void test('error message/content have ANSI control chars stripped', () => {
  const cases = parseMochaJson(content, 'tests.json').suites[0]?.cases ?? []
  const erroring = caseNamed(cases, 'Test .clone() should copy the title')
  assert.ok(erroring.message !== undefined)
  assert.equal(hasControlChar(erroring.message), false)
  assert.ok(erroring.content !== undefined)
  // content begins with err.name (UnexpectedError)
  assert.ok(erroring.content.startsWith('UnexpectedError'))
  assert.equal(hasControlChar(erroring.content), false)
})

void test('per-case time mapped from test.duration; missing -> null', () => {
  const cases = parseMochaJson(content, 'tests.json').suites[0]?.cases ?? []
  assert.equal(caseNamed(cases, 'Context nested should work').time, 3)
  // skipped test has no duration field in the fixture
  assert.equal(
    caseNamed(
      cases,
      'Mocha instance method run() should initialize the stats collector'
    ).time,
    null
  )
})

void test('resultFile comes from test.file when present', () => {
  const cases = parseMochaJson(content, 'tests.json').suites[0]?.cases ?? []
  assert.equal(
    caseNamed(cases, 'Context nested should work').resultFile,
    '/home/runner/work/mocha/mocha/test/unit/context.spec.js'
  )
})

void test('aggregate() stats match EnricoMi tests.results.json counts', () => {
  const parsed = parseMochaJson(content, 'tests.json')
  const stats = aggregate([parsed], { commit: 'commit sha' })

  // counts (files/suites/tests*/runs*) match the EnricoMi expected stats
  assert.equal(stats.files, 1)
  assert.equal(stats.suites, 1)
  assert.equal(stats.tests, 5)
  assert.equal(stats.tests_succ, 2)
  assert.equal(stats.tests_skip, 1)
  assert.equal(stats.tests_fail, 1)
  assert.equal(stats.tests_error, 1)
  assert.equal(stats.runs, 5)
  assert.equal(stats.runs_succ, 2)
  assert.equal(stats.runs_skip, 1)
  assert.equal(stats.runs_fail, 1)
  assert.equal(stats.runs_error, 1)

  // duration matches the Python action: the Mocha parser carries the suite
  // time as stats.duration (12), which aggregate() uses instead of summing the
  // per-case durations (which would give 3+1+0+4 = 8). Keeps the digest compatible.
  assert.equal(stats.duration, 12)
})

void test('scalar coercion: numeric/boolean fields stringify, objects drop', () => {
  // err.message is a number, err.name a boolean, err.stack an object.
  // str() must stringify the number/boolean arms and drop the object arm.
  const doc = JSON.stringify({
    stats: { suites: 1, duration: 5 },
    tests: [
      {
        fullTitle: 'numbered case',
        // test.file as a number exercises the number arm of str()
        file: 42,
        // test.duration is a number -> mapped through num()
        duration: 7,
        err: {
          message: 123,
          name: true,
          stack: { not: 'a string' }
        }
      }
    ]
  })
  const cases = parseMochaJson(doc, 'd.json').suites[0]?.cases ?? []
  const c = caseNamed(cases, 'numbered case')
  assert.equal(c.result, 'failure')
  // number message stringified
  assert.equal(c.message, '123')
  // content = name(true) + message(123); stack object dropped to ''
  assert.equal(c.content, 'true\n123')
  // numeric test.file stringified into resultFile
  assert.equal(c.resultFile, '42')
})

void test('non-string pending fullTitle is ignored (object arm of str)', () => {
  // pending entry whose fullTitle is an object -> str() returns '' -> not added
  // to the skipped set, so the matching test stays success.
  const doc = JSON.stringify({
    stats: { suites: 1, duration: 0 },
    tests: [{ fullTitle: 'plain test' }],
    pending: [{ fullTitle: { nested: 'x' } }, { fullTitle: 'plain test' }]
  })
  const cases = parseMochaJson(doc, 'p.json').suites[0]?.cases ?? []
  // 'plain test' is genuinely pending (second entry), so skipped
  assert.equal(caseNamed(cases, 'plain test').result, 'skipped')
})

void test('parse tolerates a non-object root (falls back to empty doc)', () => {
  // JSON array root -> asObj(doc) undefined -> the ?? {} fallback branch.
  const parsed = parseMochaJson('[1,2,3]', 'arr.json')
  assert.equal(parsed.file, 'arr.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.cases.length, 0)
  // no stats object -> suite time is null (the : null branch of suiteTime)
  assert.equal(parsed.suites[0]?.time, null)
})

void test('parse with no stats yields null suite time', () => {
  // object root but no stats key -> stats === undefined -> suiteTime null branch
  const parsed = parseMochaJson('{"tests":[{"fullTitle":"a"}]}', 'ns.json')
  assert.equal(parsed.suites[0]?.time, null)
  assert.equal(parsed.suites[0]?.cases.length, 1)
})

void test('empty Mocha document yields one empty suite, zero counts', () => {
  const parsed = parseMochaJson(emptyContent, 'empty.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.cases.length, 0)

  const stats = aggregate([parsed], { commit: 'c' })
  assert.equal(stats.tests, 0)
  assert.equal(stats.runs, 0)
  assert.equal(stats.suites, 1)
  assert.equal(stats.duration, 0)
})
