import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARSERS, parseContent } from '../src/parse/registry.js'

function read (f: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8')
}

// One representative fixture per format. dart/tests.json and mocha/tests.json
// both end in .json, so this also guards against the two JSON parsers colliding.
const cases: Array<{ file: string, expect: string }> = [
  { file: 'tap/sample.tap', expect: 'TAP' },
  { file: 'dart/tests.json', expect: 'Dart JSON' },
  { file: 'mocha/tests.json', expect: 'Mocha JSON' },
  { file: 'nunit/NUnit-failure.xml', expect: 'NUnit' },
  { file: 'trx/dotnet-trx.trx', expect: 'TRX' },
  { file: 'xunit/fixie.xml', expect: 'xUnit' }
]

for (const { file, expect } of cases) {
  void test(`registry routes ${file} to the ${expect} parser`, () => {
    const content = read(file)
    const matches = PARSERS.filter((p) => p.detect(content, file))
    assert.ok(matches.length >= 1, `no parser detected ${file}`)
    // parseContent picks the first match in registry order
    assert.equal(matches[0]?.name, expect)
    const parsed = parseContent(content, file)
    assert.ok(parsed.suites.length >= 1)
  })
}

void test('plain JUnit XML routes to the JUnit fallback', () => {
  const xml =
    '<testsuites><testsuite name="s">' +
    '<testcase name="t" classname="c"/></testsuite></testsuites>'
  const matches = PARSERS.filter((p) => p.detect(xml, 'results.xml'))
  assert.equal(matches[0]?.name, 'JUnit')
})

void test('parseContent throws on an unknown format', () => {
  assert.throws(() => parseContent('totally not a test report', 'mystery.bin'))
})
