import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseNUnitXml, isNUnit } from '../src/parse/nunit.js'
import { aggregate } from '../src/results.js'
import type { ParsedFile, TestCase } from '../src/types.js'

const dir = join(import.meta.dirname, 'fixtures/nunit')

function read (name: string): string {
  return readFileSync(join(dir, name), 'utf8')
}

function allCases (parsed: ParsedFile): TestCase[] {
  return parsed.suites.flatMap((s) => s.cases)
}

function caseNamed (parsed: ParsedFile, testName: string): TestCase {
  const c = allCases(parsed).find((c) => c.testName === testName)
  assert.ok(c !== undefined, `expected a case named ${testName}`)
  return c
}

const opts = { commit: 'commit sha' }

void test('detects NUnit by root element', () => {
  assert.equal(isNUnit(read('pickles.xml')), true) // <test-results>
  assert.equal(isNUnit(read('NUnit-issue44527.xml')), true) // <test-run>
  assert.equal(isNUnit('<test-suite name="x"></test-suite>'), true)
  // conservative: unrelated content must not match
  assert.equal(isNUnit('<testsuites><testsuite/></testsuites>'), false)
  assert.equal(isNUnit('<assemblies/>'), false)
  assert.equal(isNUnit('not xml at all'), false)
  assert.equal(isNUnit('{"json":true}'), false)
})

void test('parses a bare <test-suite> root (no test-run/test-results wrapper)', () => {
  const xml = `<?xml version="1.0"?>
<test-suite type="TestFixture" name="Leaf">
  <results>
    <test-case name="A.B.Passes" classname="A.B" time="0.5" />
    <test-case name="A.B.Skips" classname="A.B" result="Skipped">
      <reason><message>not today</message></reason>
    </test-case>
  </results>
</test-suite>`
  const parsed = parseNUnitXml(xml, 'bare.xml')
  assert.equal(parsed.suites.length, 1)
  const stats = aggregate([parsed], opts)
  assert.equal(stats.tests, 2)
  assert.equal(stats.tests_succ, 1)
  assert.equal(stats.tests_skip, 1)
  const skip = caseNamed(parsed, 'A.B.Skips')
  assert.equal(skip.result, 'skipped')
  assert.equal(skip.message, 'not today')
})

void test('non-numeric duration coerces to null time', () => {
  const xml = `<test-suite name="S"><results>
    <test-case name="bad" duration="not-a-number" />
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  const c = caseNamed(parsed, 'bad')
  assert.equal(c.time, null)
})

void test('multiple CDATA segments in a message coerce to empty (object arm)', () => {
  const xml = `<test-suite name="S"><results>
    <test-case name="multi" result="Skipped">
      <reason><message><![CDATA[one]]><![CDATA[two]]></message></reason>
    </test-case>
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  const c = caseNamed(parsed, 'multi')
  assert.equal(c.result, 'skipped')
  // #cdata is an array (object) -> scalar() returns '' for it
  assert.equal(c.message, '')
})

void test('runstate=Skipped marks a case skipped', () => {
  const xml = `<test-suite name="S"><results>
    <test-case name="rs" runstate="Skipped" />
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  const c = caseNamed(parsed, 'rs')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, '')
})

void test('test-case with no @name yields empty testName', () => {
  const xml = `<test-suite name="S"><results>
    <test-case classname="C" />
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  const c = caseNamed(parsed, '')
  assert.equal(c.testName, '')
  assert.equal(c.result, 'success')
})

void test('failure with result="Error" is promoted to an error', () => {
  const xml = `<test-suite name="S"><results>
    <test-case name="err" result="Error">
      <failure><message>boom</message><stack-trace>at X</stack-trace></failure>
    </test-case>
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  const c = caseNamed(parsed, 'err')
  assert.equal(c.result, 'error')
  assert.equal(c.message, 'boom')
  assert.equal(c.content, 'boomat X')
})

void test('skipped case with no <reason> has empty message', () => {
  const xml = `<test-suite name="S"><results>
    <test-case name="noreason" result="Ignored" />
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  const c = caseNamed(parsed, 'noreason')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, '')
})

void test('suite name prefers @classname when @fullname is absent', () => {
  const xml = `<test-suite name="ignored" classname="My.Class"><results>
    <test-case name="t" />
  </results></test-suite>`
  const parsed = parseNUnitXml(xml)
  assert.equal(parsed.suites.length, 1)
  const suite = parsed.suites[0]
  assert.ok(suite !== undefined)
  assert.equal(suite.name, 'My.Class')
})

void test('suite name falls back to dotted ancestor path with missing names', () => {
  // outer TestSuite has no @name (-> '' ancestor); leaf has no fullname/
  // classname/name either, so suiteName builds the dotted path with empties.
  const xml = `<test-suite type="TestSuite">
    <results>
      <test-suite type="TestFixture">
        <results><test-case name="t" /></results>
      </test-suite>
    </results>
  </test-suite>`
  const parsed = parseNUnitXml(xml)
  // outer suite has child suites only -> not a leaf; inner is the leaf
  const leaf = parsed.suites.find((s) => s.cases.length === 1)
  assert.ok(leaf !== undefined)
  // ancestor '' joined with own '' -> '.'
  assert.equal(leaf.name, '.')
})

// EnricoMi mstest/pickles.results.json -> stats
void test('pickles (NUnit v2 <test-results>) stats match EnricoMi fixture', () => {
  const parsed = parseNUnitXml(read('pickles.xml'), 'mstest/pickles.xml')
  const stats = aggregate([parsed], opts)
  assert.equal(stats.files, 1)
  assert.equal(stats.suites, 2)
  assert.equal(stats.duration, 0)
  assert.equal(stats.tests, 4)
  assert.equal(stats.tests_succ, 3)
  assert.equal(stats.tests_skip, 0)
  assert.equal(stats.tests_fail, 1)
  assert.equal(stats.tests_error, 0)
  assert.equal(stats.runs, 4)
  assert.equal(stats.runs_succ, 3)
  assert.equal(stats.runs_skip, 0)
  assert.equal(stats.runs_fail, 1)
  assert.equal(stats.runs_error, 0)
})

void test('pickles: failure case keeps stack trace, empty CDATA message', () => {
  const parsed = parseNUnitXml(read('pickles.xml'), 'mstest/pickles.xml')
  const c = caseNamed(parsed, 'Pickles.TestHarness.AdditionFeature.FailToAddTwoNumbers')
  assert.equal(c.result, 'failure')
  // v2 message is empty CDATA; content carries the stack-trace
  assert.equal(c.message, '')
  assert.ok(c.content?.includes('ThenTheResultShouldBePass'))
  // v2 has no @classname on test-cases
  assert.equal(c.className, '')
  assert.equal(c.resultFile, 'mstest/pickles.xml')
})

// EnricoMi nunit3/jenkins/NUnit-failure.results.json -> stats
void test('NUnit-failure (v2) stats match EnricoMi fixture', () => {
  const parsed = parseNUnitXml(read('NUnit-failure.xml'))
  const stats = aggregate([parsed], opts)
  assert.equal(stats.suites, 1)
  assert.equal(stats.duration, 0)
  assert.equal(stats.tests, 3)
  assert.equal(stats.tests_succ, 2)
  assert.equal(stats.tests_fail, 1)
  assert.equal(stats.runs, 3)
  assert.equal(stats.runs_succ, 2)
  assert.equal(stats.runs_fail, 1)
  assert.equal(stats.runs_error, 0)
})

void test('NUnit-failure: message is failure/message, content is message+stack', () => {
  const parsed = parseNUnitXml(read('NUnit-failure.xml'))
  const c = caseNamed(parsed, 'UnitTests.MainClassTest.TestFailure')
  assert.equal(c.result, 'failure')
  assert.ok(c.message !== undefined)
  assert.ok(c.message.includes('Expected failure'))
  assert.ok(c.message.includes('But was:  20'))
  assert.ok(c.content !== undefined)
  // content = message text followed by stack-trace text
  assert.ok(c.content.startsWith(c.message ?? ''))
  assert.ok(c.content.includes('MonoMethod'))
})

// EnricoMi nunit3/jenkins/NUnit-ignored.results.json -> stats
void test('NUnit-ignored (v2 executed=False) maps to skipped', () => {
  const parsed = parseNUnitXml(read('NUnit-ignored.xml'))
  const stats = aggregate([parsed], opts)
  assert.equal(stats.suites, 1)
  assert.equal(stats.tests, 3)
  assert.equal(stats.tests_succ, 1)
  assert.equal(stats.tests_skip, 2)
  assert.equal(stats.tests_fail, 0)
  assert.equal(stats.runs, 3)
  assert.equal(stats.runs_succ, 1)
  assert.equal(stats.runs_skip, 2)
})

void test('NUnit-ignored: reason/message becomes skip message (incl. empty)', () => {
  const parsed = parseNUnitXml(read('NUnit-ignored.xml'))
  const withText = caseNamed(parsed, 'UnitTests.OtherMainClassTest.TestIgnoredWithText')
  assert.equal(withText.result, 'skipped')
  assert.equal(withText.message, 'Dont do this')
  const noText = caseNamed(parsed, 'UnitTests.OtherMainClassTest.TestIgnored')
  assert.equal(noText.result, 'skipped')
  assert.equal(noText.message, '')
})

// EnricoMi nunit3/jenkins/NUnit-issue44527.results.json -> stats
void test('NUnit-issue44527 (v3 <test-run>) stats match EnricoMi fixture', () => {
  const parsed = parseNUnitXml(read('NUnit-issue44527.xml'))
  const stats = aggregate([parsed], opts)
  assert.equal(stats.files, 1)
  assert.equal(stats.suites, 155)
  assert.equal(stats.duration, 851)
  assert.equal(stats.tests, 150)
  assert.equal(stats.tests_succ, 6)
  assert.equal(stats.tests_skip, 0)
  assert.equal(stats.tests_fail, 144)
  assert.equal(stats.tests_error, 0)
  assert.equal(stats.runs, 150)
  assert.equal(stats.runs_succ, 6)
  assert.equal(stats.runs_fail, 144)
})

void test('NUnit v3: result="Failed" label="Error" is a failure, not an error', () => {
  // The stylesheet only promotes to <error> when @result='Error'; label is
  // ignored. issue44527 cases have result="Failed" label="Error".
  const parsed = parseNUnitXml(read('NUnit-issue44527.xml'))
  const failing = allCases(parsed).filter((c) => c.result === 'failure')
  assert.equal(failing.length, 144)
  assert.equal(allCases(parsed).filter((c) => c.result === 'error').length, 0)
  // v3 carries @classname on test-cases
  const c = failing[0]
  assert.ok(c !== undefined)
  assert.notEqual(c.className, '')
})
