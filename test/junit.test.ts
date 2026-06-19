import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJUnitXml, isJUnit, junit } from '../src/parse/junit.js'
import { aggregate } from '../src/results.js'
import type { ParsedFile, TestCase } from '../src/types.js'

function allCases (parsed: ParsedFile): TestCase[] {
  return parsed.suites.flatMap((s) => s.cases)
}

void test('detects JUnit by <testsuites>/<testsuite> root', () => {
  assert.equal(isJUnit('<testsuites><testsuite/></testsuites>'), true)
  assert.equal(isJUnit('<testsuite name="s"/>'), true)
  assert.equal(isJUnit('<assemblies/>'), false)
})

void test('parses nested <testsuites> with leaf suites + status mapping', () => {
  const xml = `<testsuites>
    <testsuite name="outer">
      <testsuite name="leaf">
        <testcase name="ok" classname="C" time="1.5"/>
        <testcase name="boom" classname="C" time="2"><failure message="nope">detail</failure></testcase>
        <testcase name="kaput" classname="C"><error message="threw">trace</error></testcase>
        <testcase name="skip" classname="C"><skipped message="later"/></testcase>
      </testsuite>
    </testsuite>
  </testsuites>`
  const parsed = parseJUnitXml(xml, 'r.xml')
  // only the leaf testsuite holds cases
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.name, 'leaf')
  const cases = allCases(parsed)
  assert.equal(cases.length, 4)

  const stats = aggregate([parsed], { commit: 'c' })
  assert.equal(stats.tests, 4)
  assert.equal(stats.tests_succ, 1)
  assert.equal(stats.tests_fail, 1)
  assert.equal(stats.tests_error, 1)
  assert.equal(stats.tests_skip, 1)
  // duration = floor(1.5 + 2 + 0 + 0)
  assert.equal(stats.duration, 3)
})

void test('parses a bare <testsuite> root (no <testsuites> wrapper)', () => {
  const xml =
    '<testsuite name="s"><testcase name="t" classname="c" time="bogus"/></testsuite>'
  const parsed = parseJUnitXml(xml, 'r.xml')
  assert.equal(parsed.suites.length, 1)
  const c = allCases(parsed)[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'success')
  // non-numeric time -> null (not NaN)
  assert.equal(c.time, null)
})

void test('error takes precedence over failure/skipped on one case', () => {
  const xml =
    '<testsuite><testcase name="t" classname="c">' +
    '<error message="e"/><failure message="f"/></testcase></testsuite>'
  const c = allCases(parseJUnitXml(xml))[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'error')
  assert.equal(c.message, 'e')
})

void test('testcase missing classname/name attributes -> empty strings', () => {
  const xml = '<testsuite><testcase/></testsuite>'
  const c = allCases(parseJUnitXml(xml))[0]
  assert.ok(c !== undefined)
  assert.equal(c.className, '')
  assert.equal(c.testName, '')
  assert.equal(c.time, null)
  assert.equal(c.result, 'success')
})

void test('FormatParser wiring: detect + parse via the exported parser', () => {
  assert.equal(junit.name, 'JUnit')
  assert.equal(junit.detect('<testsuites/>', 'x.xml'), true)
  const parsed = junit.parse('<testsuite><testcase name="t" classname="c"/></testsuite>', 'x.xml')
  assert.equal(parsed.suites.length, 1)
})
