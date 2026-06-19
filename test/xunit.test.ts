import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseXUnitXml, isXUnit } from '../src/parse/xunit.js'
import type { ParsedFile, ParsedSuite } from '../src/types.js'

const xml = readFileSync(
  join(import.meta.dirname, 'fixtures/xunit/fixie.xml'),
  'utf8'
)

function suiteNamed (parsed: ParsedFile, name: string): ParsedSuite {
  const suite = parsed.suites.find((s) => s.name === name)
  assert.ok(suite !== undefined, `expected a suite named ${name}`)
  return suite
}

void test('detects xUnit by root <assemblies> element', () => {
  assert.equal(isXUnit(xml), true)
})

void test('maps assembly/collection -> leaf suites with correct cases', () => {
  const parsed = parseXUnitXml(xml, 'mstest/fixie.xml')
  assert.equal(parsed.suites.length, 2)
  assert.equal(suiteNamed(parsed, '[genericTestClass]').cases.length, 3)
  assert.equal(suiteNamed(parsed, '[testClass]').cases.length, 4)
})

void test('maps test @method->name, @type->classname', () => {
  const parsed = parseXUnitXml(xml)
  const c = suiteNamed(parsed, '[genericTestClass]').cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.testName, 'ShouldBeString')
  assert.equal(c.className, '[genericTestClass]')
})

void test('failure: message attr is message text, content is message+stack-trace', () => {
  const parsed = parseXUnitXml(xml)
  const failing = suiteNamed(parsed, '[genericTestClass]').cases.find(
    (c) => c.result === 'failure'
  )
  assert.ok(failing !== undefined)
  assert.equal(failing.message, 'Expected: System.String\nActual:   System.Int32')
  assert.equal(
    failing.content,
    'Expected: System.String\nActual:   System.Int32' +
      '   at [genericTestClassForStackTrace].ShouldBeString[T](T genericArgument) in [fileLocation]:line #'
  )
})

void test('reason child maps to skipped with message', () => {
  const parsed = parseXUnitXml(xml)
  const skipped = suiteNamed(parsed, '[testClass]').cases.find(
    (c) => c.result === 'skipped'
  )
  assert.ok(skipped !== undefined)
  assert.equal(skipped.testName, 'Skip')
  assert.equal(skipped.message, '⚠ Skipped with attribute.')
})

void test('parses a bare <assembly> root (no <assemblies> wrapper)', () => {
  const synthetic = `<?xml version="1.0"?>
<assembly>
  <collection name="C">
    <test type="T" method="m" time="0.5" />
  </collection>
</assembly>`
  const parsed = parseXUnitXml(synthetic, 'bare.xml')
  assert.equal(parsed.suites.length, 1)
  const suite = suiteNamed(parsed, 'C')
  assert.equal(suite.cases.length, 1)
  const c = suite.cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.testName, 'm')
  assert.equal(c.className, 'T')
  assert.equal(c.time, 0.5)
  assert.equal(c.result, 'success')
})

void test('failure with plain-text <message>/<stack-trace> elements', () => {
  // No CDATA and no attributes, so fast-xml-parser yields plain string values
  // for <message>/<stack-trace>; exercises elemText's scalar fallback path.
  const synthetic = `<?xml version="1.0"?>
<assembly>
  <class name="K">
    <test type="T" method="boom">
      <failure>
        <message>plain message</message>
        <stack-trace> at line 1</stack-trace>
      </failure>
    </test>
  </class>
</assembly>`
  const parsed = parseXUnitXml(synthetic)
  const c = suiteNamed(parsed, 'K').cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'failure')
  assert.equal(c.message, 'plain message')
  // trimValues strips the leading whitespace of the stack-trace text
  assert.equal(c.content, 'plain messageat line 1')
})

void test('multiple CDATA sections in <message> coerce array value to empty', () => {
  // Two CDATA sections make fast-xml-parser emit #cdata as an array; scalar()
  // treats that object/array as '' (exercises the object arm of scalar).
  const synthetic = `<?xml version="1.0"?>
<assembly>
  <class name="K">
    <test type="T" method="m">
      <failure>
        <message><![CDATA[a]]><![CDATA[b]]></message>
      </failure>
    </test>
  </class>
</assembly>`
  const parsed = parseXUnitXml(synthetic)
  const c = suiteNamed(parsed, 'K').cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'failure')
  assert.equal(c.message, '')
})

void test('group without @name yields empty suite name', () => {
  const synthetic = `<?xml version="1.0"?>
<assembly>
  <collection>
    <test type="T" method="m" />
  </collection>
</assembly>`
  const parsed = parseXUnitXml(synthetic)
  assert.equal(parsed.suites.length, 1)
  const suite = parsed.suites[0]
  assert.ok(suite !== undefined)
  assert.equal(suite.name, '')
})

void test('missing @type/@method/@time default to empty/null', () => {
  const synthetic = `<?xml version="1.0"?>
<assembly>
  <collection name="N">
    <test />
  </collection>
</assembly>`
  const parsed = parseXUnitXml(synthetic)
  const c = suiteNamed(parsed, 'N').cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.className, '')
  assert.equal(c.testName, '')
  assert.equal(c.time, null)
  assert.equal(c.result, 'success')
})

void test('non-numeric @time yields null', () => {
  const synthetic = `<?xml version="1.0"?>
<assembly>
  <collection name="N">
    <test type="T" method="m" time="not-a-number" />
  </collection>
</assembly>`
  const parsed = parseXUnitXml(synthetic)
  const c = suiteNamed(parsed, 'N').cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.time, null)
})

void test('isXUnit returns false for non-xUnit content', () => {
  assert.equal(isXUnit('<testsuite name="x"></testsuite>'), false)
  assert.equal(isXUnit(''), false)
})
