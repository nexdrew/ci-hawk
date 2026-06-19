import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseXUnitXml } from '../src/parse/xunit.js'
import { aggregate } from '../src/results.js'
import { decodeDigest, encodeDigest } from '../src/digest.js'
import type { RunResults } from '../src/types.js'

const dir = join(import.meta.dirname, 'fixtures/xunit')
const xml = readFileSync(join(dir, 'fixie.xml'), 'utf8')

interface ReferenceResults { stats: RunResults }
const reference = JSON.parse(
  readFileSync(join(dir, 'fixie.results.json'), 'utf8')
) as ReferenceResults

const NUMERIC_FIELDS = [
  'files',
  'suites',
  'duration',
  'tests',
  'tests_succ',
  'tests_skip',
  'tests_fail',
  'tests_error',
  'runs',
  'runs_succ',
  'runs_skip',
  'runs_fail',
  'runs_error'
] as const

void test("aggregated stats match the Python action's fixie.results.json", () => {
  const parsed = parseXUnitXml(xml, 'mstest/fixie.xml')
  const stats = aggregate([parsed], { commit: 'commit sha', timeFactor: 1 })

  const ref = reference.stats
  // tests-vs-runs dedup is the core of the digest: 7 runs collapse to 5 tests
  for (const field of NUMERIC_FIELDS) {
    assert.equal(stats[field], ref[field], `field ${field}`)
  }
  assert.equal(stats.commit, ref.commit)
})

void test('digest of aggregated fixie stats round-trips', () => {
  const parsed = parseXUnitXml(xml, 'mstest/fixie.xml')
  const stats = aggregate([parsed], { commit: 'commit sha', timeFactor: 1 })
  assert.deepEqual(decodeDigest(encodeDigest(stats)), stats)
})
