import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTrxXml, isTrx, trx } from '../src/parse/trx.js'
import { aggregate } from '../src/results.js'
import type { ParsedFile, TestCase } from '../src/types.js'

const dir = join(import.meta.dirname, 'fixtures/trx')

function read (name: string): string {
  return readFileSync(join(dir, name), 'utf8')
}

function statsFor (parsed: ParsedFile): ReturnType<typeof aggregate> {
  return aggregate([parsed], { commit: 'commit sha' })
}

function allCases (parsed: ParsedFile): TestCase[] {
  return parsed.suites.flatMap((s) => s.cases)
}

// Expected "stats" objects copied from the EnricoMi .results.json fixtures.
// duration/suites/files/tests*/runs* must match the Python pipeline exactly.

void test('detects TRX by root <TestRun> element', () => {
  assert.equal(isTrx(read('pickles.trx')), true)
})

void test('detect() is conservative: false on unrelated XML/text', () => {
  assert.equal(trx.detect('<testsuites/>', 'a.xml'), false)
  assert.equal(trx.detect('{"json":true}', 'a.json'), false)
  assert.equal(trx.detect('not xml at all', 'a.txt'), false)
})

void test('builds exactly one leaf suite named MSTestSuite', () => {
  const parsed = parseTrxXml(read('pickles.trx'), 'pickles.trx')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.name, 'MSTestSuite')
})

void test('pickles: stats match EnricoMi results.json', () => {
  const s = statsFor(parseTrxXml(read('pickles.trx'), 'pickles.trx'))
  assert.equal(s.files, 1)
  assert.equal(s.suites, 1)
  assert.equal(s.duration, 0)
  assert.equal(s.tests, 4)
  assert.equal(s.tests_succ, 3)
  assert.equal(s.tests_skip, 0)
  assert.equal(s.tests_fail, 1)
  assert.equal(s.tests_error, 0)
  assert.equal(s.runs, 4)
  assert.equal(s.runs_succ, 3)
  assert.equal(s.runs_fail, 1)
})

void test('pickles: failure carries message + className/name from definition', () => {
  const parsed = parseTrxXml(read('pickles.trx'), 'pickles.trx')
  const fail = allCases(parsed).find((c) => c.result === 'failure')
  assert.ok(fail !== undefined)
  assert.equal(fail.className, 'Pickles.TestHarness.MSTest.AdditionFeature')
  assert.equal(fail.testName, 'FailToAddTwoNumbers')
  assert.ok(fail.message?.includes('threw exception') === true)
  // content is message + stacktrace, so it is at least as long as the message
  const msgLen = fail.message?.length ?? 0
  assert.ok((fail.content?.length ?? 0) >= msgLen)
})

void test('dotnet-trx: stats match EnricoMi results.json', () => {
  const s = statsFor(parseTrxXml(read('dotnet-trx.trx'), 'dotnet-trx.trx'))
  assert.equal(s.files, 1)
  assert.equal(s.suites, 1)
  assert.equal(s.duration, 0)
  assert.equal(s.tests, 11)
  assert.equal(s.tests_succ, 5)
  assert.equal(s.tests_skip, 1)
  assert.equal(s.tests_fail, 5)
  assert.equal(s.tests_error, 0)
  assert.equal(s.runs, 11)
  assert.equal(s.runs_succ, 5)
  assert.equal(s.runs_skip, 1)
  assert.equal(s.runs_fail, 5)
  assert.equal(s.runs_error, 0)
})

void test('dotnet-trx: NotExecuted -> skipped, prefixed testName stripped', () => {
  const parsed = parseTrxXml(read('dotnet-trx.trx'), 'dotnet-trx.trx')
  const cases = allCases(parsed)
  const skip = cases.find((c) => c.result === 'skipped')
  assert.ok(skip !== undefined)
  assert.equal(skip.testName, 'Skipped_Test')
  assert.equal(skip.className, 'DotnetTests.XUnitTests.CalculatorTests')
  // Timeout_Test arrives as "<class>.Timeout_Test" and must be de-prefixed.
  assert.ok(cases.some((c) => c.testName === 'Timeout_Test'))
})

void test('yami: stats match EnricoMi results.json (Aborted/NotRunnable/NotExecuted -> skipped)', () => {
  const s = statsFor(parseTrxXml(read('yami.trx'), 'yami.trx'))
  assert.equal(s.files, 1)
  assert.equal(s.suites, 1)
  assert.equal(s.duration, 26)
  assert.equal(s.tests, 25)
  assert.equal(s.tests_succ, 2)
  assert.equal(s.tests_skip, 21)
  assert.equal(s.tests_fail, 2)
  assert.equal(s.tests_error, 0)
  assert.equal(s.runs, 25)
  assert.equal(s.runs_succ, 2)
  assert.equal(s.runs_skip, 21)
  assert.equal(s.runs_fail, 2)
  assert.equal(s.runs_error, 0)
})

void test('SilentNotes: stats match EnricoMi results.json', () => {
  const s = statsFor(parseTrxXml(read('SilentNotes.trx'), 'SilentNotes.trx'))
  assert.equal(s.suites, 1)
  assert.equal(s.duration, 0)
  assert.equal(s.tests, 79)
  assert.equal(s.tests_succ, 67)
  assert.equal(s.tests_skip, 12)
  assert.equal(s.tests_fail, 0)
  assert.equal(s.runs, 79)
})

void test('FluentValidation: large file, duration floors to 3s', () => {
  const s = statsFor(
    parseTrxXml(read('FluentValidation.Tests.trx'), 'FluentValidation.Tests.trx')
  )
  assert.equal(s.suites, 1)
  assert.equal(s.duration, 3)
  assert.equal(s.tests, 804)
  assert.equal(s.tests_succ, 803)
  assert.equal(s.tests_skip, 1)
  assert.equal(s.runs, 804)
})

void test('skipped case content is message only (no stacktrace)', () => {
  // Synthetic TRX: one Aborted result with ErrorInfo to prove skipped status
  // takes message but not stacktrace into content (matches the XSLT).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="e1" testId="t1" testName="C.skipMe" outcome="Aborted">
      <Output><ErrorInfo><Message>aborted msg</Message><StackTrace>STACK</StackTrace></ErrorInfo></Output>
    </UnitTestResult>
  </Results>
  <TestDefinitions>
    <UnitTest id="t1"><Execution id="e1"/><TestMethod className="C, Asm" name="skipMe"/></UnitTest>
  </TestDefinitions>
</TestRun>`
  const parsed = parseTrxXml(xml, 'syn.trx')
  const c = allCases(parsed)[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'skipped')
  assert.equal(c.className, 'C')
  assert.equal(c.testName, 'skipMe')
  assert.equal(c.message, 'aborted msg')
  assert.equal(c.content, 'aborted msg')
})

void test('missing @outcome maps to error; error content is message+stacktrace', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="e1" testId="t1" testName="boom">
      <Output><ErrorInfo><Message>M</Message><StackTrace>S</StackTrace></ErrorInfo></Output>
    </UnitTestResult>
  </Results>
  <TestDefinitions>
    <UnitTest id="t1"><Execution id="e1"/><TestMethod className="C" name="boom"/></UnitTest>
  </TestDefinitions>
</TestRun>`
  const parsed = parseTrxXml(xml, 'syn.trx')
  const c = allCases(parsed)[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'error')
  assert.equal(c.message, 'M')
  assert.equal(c.content, 'MS')
})

void test('2006-schema correlation by executionId resolves className', () => {
  // No testId match; only Execution/@id matches -> uses byExecutionId map.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2006">
  <Results>
    <UnitTestResult executionId="exec-1" testName="t" duration="00:00:01.5" outcome="Passed"/>
  </Results>
  <TestDefinitions>
    <UnitTest id="def-1"><Execution id="exec-1"/><TestMethod className="Ns.Cls, Asm" name="t"/></UnitTest>
  </TestDefinitions>
</TestRun>`
  const parsed = parseTrxXml(xml, 'syn.trx')
  const c = allCases(parsed)[0]
  assert.ok(c !== undefined)
  assert.equal(c.className, 'Ns.Cls')
  assert.equal(c.result, 'success')
  assert.equal(c.time, 1.5)
})

void test('numeric character references in failure detail are decoded', () => {
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="Ns.Cls" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="Ns.Cls.m" outcome="Failed" duration="00:00:01.0">
        <Output><ErrorInfo>
          <Message>line1&#xD;&#xA;line2</Message>
          <StackTrace>at X</StackTrace>
        </ErrorInfo></Output>
      </UnitTestResult>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'syn.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.message, 'line1\r\nline2')
  assert.ok(c.content?.includes('line1\r\nline2'))
  assert.ok(c.content?.includes('&#x') !== true)
})

void test('decimal numeric references in message are decoded; out-of-range drops', () => {
  // &#10; (LF) and &#9; (tab) exercise the decimal branch of the decoder; the
  // huge &#99999999; is out of the Unicode range and decodes to empty.
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="Ns.Cls" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="Ns.Cls.m" outcome="Failed" duration="00:00:01.0">
        <Output><ErrorInfo>
          <Message>a&#10;b&#9;c&#99999999;d</Message>
          <StackTrace>at X</StackTrace>
        </ErrorInfo></Output>
      </UnitTestResult>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'syn.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.message, 'a\nb\tcd')
})

void test('CDATA message/stacktrace bodies are read from the node element', () => {
  // CDATA makes fast-xml-parser emit an object node (with #cdata), exercising
  // the object branch of elemText rather than the bare-string branch.
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="C" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="C.m" outcome="Failed" duration="00:00:01.0">
        <Output><ErrorInfo>
          <Message><![CDATA[cdata msg]]></Message>
          <StackTrace><![CDATA[st]]></StackTrace>
        </ErrorInfo></Output>
      </UnitTestResult>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'syn.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.message, 'cdata msg')
  assert.equal(c.content, 'cdata msgst')
})

void test('non-TestRun XML yields an empty parsed file', () => {
  const parsed = parseTrxXml('<NotARun/>', 'x.trx')
  assert.equal(parsed.file, 'x.trx')
  assert.deepEqual(parsed.suites, [])
})

void test('result with no matching UnitTest produces no case (empty suites)', () => {
  // No TestDefinitions at all: indexUnitTests gets undefined, every result is
  // unmatched, so the loop `continue`s and no MSTestSuite is emitted.
  const xml = `<TestRun>
    <Results>
      <UnitTestResult testId="t1" testName="orphan" outcome="Passed" duration="00:00:01.0"/>
    </Results>
  </TestRun>`
  const parsed = parseTrxXml(xml, 'x.trx')
  assert.deepEqual(parsed.suites, [])
})

void test('malformed @duration parses to null time', () => {
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="C" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="C.m" outcome="Passed" duration="garbage"/>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'x.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.time, null)
})

void test('startTime/endTime drives duration; invalid timestamps floor to 0', () => {
  // First result uses parseable start/end (1.5s). Second has unparseable
  // timestamps, so isoSeconds returns null and caseTime falls back to 0.
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="C" name="a"/></UnitTest>
      <UnitTest id="t2"><TestMethod className="C" name="b"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="C.a" outcome="Passed"
        startTime="2020-01-01T00:00:00.000Z" endTime="2020-01-01T00:00:01.500Z"/>
      <UnitTestResult testId="t2" testName="C.b" outcome="Passed"
        startTime="not-a-date" endTime="also-bad"/>
    </Results>
  </TestRun>`
  const cases = allCases(parseTrxXml(xml, 'x.trx'))
  const a = cases.find((c) => c.testName === 'a')
  const b = cases.find((c) => c.testName === 'b')
  assert.ok(a !== undefined)
  assert.ok(b !== undefined)
  assert.equal(a.time, 1.5)
  assert.equal(b.time, 0)
})

void test('missing testName and missing TestMethod/className default to empty', () => {
  // UnitTest without a TestMethod element exercises classNameOf's undefined
  // branches; the result without @testName exercises the `?? ''` fallback.
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"/>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" outcome="Passed" duration="00:00:01.0"/>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'x.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.className, '')
  assert.equal(c.testName, '')
  assert.equal(c.result, 'success')
})

void test('TestMethod without className attribute yields empty className', () => {
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="m" outcome="Passed" duration="00:00:01.0"/>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'x.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.className, '')
})

void test('failure without ErrorInfo yields empty message/content', () => {
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="C" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="C.m" outcome="Failed" duration="00:00:01.0"/>
    </Results>
  </TestRun>`
  const c = allCases(parseTrxXml(xml, 'x.trx'))[0]
  assert.ok(c !== undefined)
  assert.equal(c.result, 'failure')
  assert.equal(c.message, '')
  assert.equal(c.content, '')
})

void test('trx.parse delegates with the given path', () => {
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="C" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="C.m" outcome="Passed" duration="00:00:01.0"/>
    </Results>
  </TestRun>`
  const parsed = trx.parse(xml, 'given/path.trx')
  assert.equal(parsed.file, 'given/path.trx')
  assert.equal(parsed.suites[0]?.cases[0]?.testName, 'm')
})

void test('parseTrxXml defaults the file path to empty string', () => {
  const parsed = parseTrxXml('<NotARun/>')
  assert.equal(parsed.file, '')
})

void test('data-driven InnerResults are expanded into cases', () => {
  const xml = `<TestRun>
    <TestDefinitions>
      <UnitTest id="t1"><TestMethod className="Ns.DataDriven" name="m"/></UnitTest>
    </TestDefinitions>
    <Results>
      <UnitTestResult testId="t1" testName="Ns.DataDriven.m" outcome="Failed" duration="00:00:03.0">
        <InnerResults>
          <UnitTestResult testId="t1" testName="Ns.DataDriven.m (a)" outcome="Passed" duration="00:00:01.0"/>
          <UnitTestResult testId="t1" testName="Ns.DataDriven.m (b)" outcome="Failed" duration="00:00:02.0"/>
        </InnerResults>
      </UnitTestResult>
    </Results>
  </TestRun>`
  const parsed = parseTrxXml(xml, 'syn.trx')
  const cases = allCases(parsed)
  // outer aggregate result + 2 inner iterations
  assert.equal(cases.length, 3)
  assert.deepEqual(
    cases.map((c) => c.testName).sort(),
    ['m', 'm (a)', 'm (b)']
  )
  assert.equal(statsFor(parsed).runs, 3)
})
