import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnnotations, ANNOTATION_BATCH } from '../src/annotations.js'
import type { ParsedFile, TestCase, CaseResult } from '../src/types.js'

/** Build a TestCase with sane defaults, overriding only what a test cares about. */
function makeCase (overrides: Partial<TestCase> = {}): TestCase {
  return {
    className: '',
    testName: 'test',
    time: null,
    result: 'failure',
    ...overrides
  }
}

/** Wrap cases in a single-suite ParsedFile. */
function makeFile (file: string, cases: TestCase[]): ParsedFile {
  return { file, suites: [{ name: 'suite', cases }] }
}

void test('one annotation per failing or errored case', () => {
  const results: CaseResult[] = ['success', 'skipped', 'failure', 'error']
  const cases = results.map((result, i) =>
    makeCase({ testName: `t${i}`, result })
  )
  const annotations = buildAnnotations([makeFile('f.xml', cases)])
  assert.equal(annotations.length, 2)
  assert.equal(annotations[0]?.message, 't2 failure')
  assert.equal(annotations[1]?.message, 't3 error')
})

void test('success and skipped cases produce no annotations', () => {
  const cases = [
    makeCase({ testName: 'ok', result: 'success' }),
    makeCase({ testName: 'skip', result: 'skipped' })
  ]
  assert.deepEqual(buildAnnotations([makeFile('f.xml', cases)]), [])
})

void test('empty input produces no annotations', () => {
  assert.deepEqual(buildAnnotations([]), [])
})

void test('path uses case.resultFile when non-empty', () => {
  const cases = [makeCase({ result: 'failure', resultFile: 'result.tap' })]
  const annotations = buildAnnotations([makeFile('file.xml', cases)])
  assert.equal(annotations[0]?.path, 'result.tap')
})

void test('path falls back to ParsedFile.file when resultFile is empty', () => {
  const empty = [makeCase({ result: 'failure', resultFile: '' })]
  const undef = [makeCase({ result: 'failure' })]
  assert.equal(buildAnnotations([makeFile('file.xml', empty)])[0]?.path, 'file.xml')
  assert.equal(buildAnnotations([makeFile('file.xml', undef)])[0]?.path, 'file.xml')
})

void test("path is 'unknown' when both resultFile and file are empty", () => {
  const cases = [makeCase({ result: 'failure', resultFile: '' })]
  const annotations = buildAnnotations([makeFile('', cases)])
  assert.equal(annotations[0]?.path, 'unknown')
})

void test('annotation_level is always failure, lines are 1', () => {
  const cases = [makeCase({ result: 'error' })]
  const a = buildAnnotations([makeFile('f.xml', cases)])[0]
  assert.ok(a !== undefined)
  assert.equal(a.annotation_level, 'failure')
  assert.equal(a.start_line, 1)
  assert.equal(a.end_line, 1)
})

void test('title joins non-empty className and testName with ▸', () => {
  const cases = [makeCase({ className: 'Math', testName: 'adds', result: 'failure' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.title, 'Math ▸ adds')
})

void test('title is just testName when className is empty', () => {
  const cases = [makeCase({ className: '', testName: 'adds', result: 'failure' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.title, 'adds')
})

void test('title is just className when testName is empty', () => {
  const cases = [makeCase({ className: 'Math', testName: '', result: 'failure' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.title, 'Math')
})

void test('message prefers message over content and synthetic fallback', () => {
  const cases = [makeCase({
    result: 'failure',
    message: 'the message',
    content: 'the content'
  })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.message, 'the message')
})

void test('message falls back to content when message is absent', () => {
  const cases = [makeCase({ result: 'failure', content: 'the content' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.message, 'the content')
})

void test('message falls back to "<name> <result>" when both absent', () => {
  const cases = [makeCase({ testName: 'boom', result: 'error' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.message, 'boom error')
})

void test('raw_details set from content when present', () => {
  const cases = [makeCase({ result: 'failure', content: 'stack trace here' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.raw_details, 'stack trace here')
})

void test('raw_details is undefined when content is absent', () => {
  const cases = [makeCase({ result: 'failure', message: 'm' })]
  assert.equal(buildAnnotations([makeFile('f.xml', cases)])[0]?.raw_details, undefined)
})

void test('collects across multiple files and suites', () => {
  const fileA: ParsedFile = {
    file: 'a.xml',
    suites: [
      { name: 's1', cases: [makeCase({ testName: 'a1', result: 'failure' })] },
      { name: 's2', cases: [makeCase({ testName: 'a2', result: 'success' })] }
    ]
  }
  const fileB = makeFile('b.xml', [makeCase({ testName: 'b1', result: 'error' })])
  const annotations = buildAnnotations([fileA, fileB])
  assert.equal(annotations.length, 2)
  assert.deepEqual(annotations.map((a) => a.title), ['a1', 'b1'])
})

void test('a very long message is truncated with an ellipsis', () => {
  const long = 'x'.repeat(100 * 1024)
  const cases = [makeCase({ result: 'failure', message: long })]
  const a = buildAnnotations([makeFile('f.xml', cases)])[0]
  assert.ok(a !== undefined)
  assert.ok(a.message.length < long.length)
  assert.ok(a.message.endsWith('…'))
})

void test('a very long title is truncated with an ellipsis', () => {
  const long = 'y'.repeat(500)
  const cases = [makeCase({ className: long, testName: '', result: 'failure' })]
  const a = buildAnnotations([makeFile('f.xml', cases)])[0]
  assert.ok(a?.title !== undefined)
  assert.ok(a.title.length < long.length)
  assert.ok(a.title.endsWith('…'))
})

void test('ANNOTATION_BATCH is exported and equals 50', () => {
  assert.equal(ANNOTATION_BATCH, 50)
})
