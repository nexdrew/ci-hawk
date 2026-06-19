import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import {
  decodeDigest,
  encodeDigest,
  serializeStats,
  encodeDigestLine,
  findDigestLine,
  DIGEST_HEADER
} from '../src/digest.js'
import type { RunResults } from '../src/types.js'

const vectorPath = join(import.meta.dirname, 'fixtures/digest/python-vector.txt')
const pythonVector = readFileSync(vectorPath, 'utf8').trim()

// The exact stats the Python action encoded into the vector above, and the
// exact JSON string it produced (default json.dumps formatting).
const expected: RunResults = {
  files: 1234,
  suites: 2,
  duration: 3456,
  tests: 22,
  tests_succ: 4,
  tests_skip: 5,
  tests_fail: 6,
  tests_error: 7,
  runs: 38,
  runs_succ: 8,
  runs_skip: 9,
  runs_fail: 10,
  runs_error: 11,
  commit: 'commit'
}
const expectedJson =
  '{"files": 1234, "suites": 2, "duration": 3456, "tests": 22, ' +
  '"tests_succ": 4, "tests_skip": 5, "tests_fail": 6, "tests_error": 7, ' +
  '"runs": 38, "runs_succ": 8, "runs_skip": 9, "runs_fail": 10, ' +
  '"runs_error": 11, "commit": "commit"}'

void test('decodes a real Python-produced digest (cross-compat read path)', () => {
  assert.deepEqual(decodeDigest(pythonVector), expected)
})

void test('serializes stats byte-identically to Python json.dumps', () => {
  assert.equal(serializeStats(expected), expectedJson)
})

void test("re-encoding Python's stats decodes back to Python's exact JSON", () => {
  // gzip bytes differ across zlib builds, but the meaningful guarantee holds:
  // our digest decodes to the same stats and re-serializes to identical JSON.
  const reEncoded = encodeDigest(decodeDigest(pythonVector))
  assert.deepEqual(decodeDigest(reEncoded), expected)
  assert.equal(serializeStats(decodeDigest(reEncoded)), expectedJson)
})

void test('round-trips stats through encode/decode', () => {
  const stats: RunResults = { ...expected, commit: 'abc123', tests: 999 }
  assert.deepEqual(decodeDigest(encodeDigest(stats)), stats)
})

void test('decodes a digest embedded in a summary body with header + noise', () => {
  const body = `### Test Results\n\nsome text\n${encodeDigestLine(expected)}\nmore`
  const line = findDigestLine(body)
  assert.ok(line !== undefined)
  assert.ok(line.startsWith(DIGEST_HEADER))
  assert.deepEqual(decodeDigest(line), expected)
})

void test('decodes a partial payload, defaulting missing/non-number fields to 0 and commit to ""', () => {
  // Only `files` is present (and `commit` is the wrong type), so every other
  // field exercises int()'s `: 0` fallback and commit exercises its `: ''` arm.
  const partial = gzipSync(Buffer.from('{"files":3,"commit":42}')).toString('base64')
  assert.deepEqual(decodeDigest(partial), {
    files: 3,
    suites: 0,
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
    commit: ''
  })
})

void test('findDigestLine returns undefined when no marker is present', () => {
  assert.equal(findDigestLine('no digest here\njust prose\n'), undefined)
})
