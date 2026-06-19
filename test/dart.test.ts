import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDartJson, isDartJson, dart } from '../src/parse/dart.js'
import { aggregate } from '../src/results.js'
import type { ParsedFile, TestCase } from '../src/types.js'

const content = readFileSync(
  join(import.meta.dirname, 'fixtures/dart/tests.json'),
  'utf8'
)

function allCases (parsed: ParsedFile): TestCase[] {
  return parsed.suites.flatMap((s) => s.cases)
}

function caseNamed (parsed: ParsedFile, name: string): TestCase {
  const c = allCases(parsed).find((c) => c.testName === name)
  assert.ok(c !== undefined, `expected a case named ${name}`)
  return c
}

void test('detects Dart JSON by first start event with protocolVersion', () => {
  assert.equal(isDartJson(content, 'json/tests.json'), true)
})

void test('detect is conservative: rejects non-.json paths', () => {
  assert.equal(isDartJson(content, 'json/tests.txt'), false)
})

void test('detect rejects unrelated JSON and never throws', () => {
  assert.equal(isDartJson('{"hello":"world"}', 'x.json'), false)
  assert.equal(isDartJson('not json at all', 'x.json'), false)
  assert.equal(isDartJson('', 'x.json'), false)
  // JUnit XML wrongly named .json must not match
  assert.equal(isDartJson('<testsuites/>', 'x.json'), false)
})

void test('builds one leaf suite per Dart suite (excludes hidden tests)', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  assert.equal(parsed.suites.length, 4)
  // Each suite's synthetic "loading ..." hidden test is dropped.
  for (const s of parsed.suites) {
    assert.ok(
      !s.cases.some((c) => c.testName.startsWith('loading ')),
      'hidden loading test should be excluded'
    )
  }
})

void test('suite names come from suite.path', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  const names = parsed.suites.map((s) => s.name)
  assert.deepEqual(names, [
    'test/src/cli/cli_runner_test.dart',
    'test/src/cli/commands/check_unnecessary_nullable_command_test.dart',
    'test/src/cli/utils/detect_sdk_path_test.dart',
    'test/src/config_builder/models/analysis_options_test.dart'
  ])
})

void test('status mapping: failure (isFailure) -> failure with message+stack', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  const c = caseNamed(parsed, 'Cli runner should have correct invocation')
  assert.equal(c.result, 'failure')
  assert.ok(c.message?.startsWith("Expected: 'metrics <command>"))
  assert.ok(c.content?.includes('main.<fn>.<fn>'))
  assert.ok(c.content?.startsWith("Expected: 'metrics <command>"))
})

void test('status mapping: error (isFailure false) -> error', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  const c = caseNamed(
    parsed,
    'detectSdkPath should return `null` if running inside VM'
  )
  assert.equal(c.result, 'error')
  assert.equal(c.message, 'Exception: exception')
  assert.ok(c.content?.includes('Exception: exception'))
})

void test('status mapping: result success + skipped:true -> skipped', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  const c = caseNamed(parsed, 'Cli runner should have correct description')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, 'Skip: just skipping')
})

void test('time is (end - start) / 1000 seconds', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  // test id 7: start 9503, end 9525 -> 22ms -> 0.022s
  const c = caseNamed(parsed, 'Cli runner run with version argument')
  assert.ok(c.time !== null)
  assert.ok(Math.abs(c.time - 0.022) < 1e-9)
})

void test('resultFile is propagated to each case', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  for (const c of allCases(parsed)) {
    assert.equal(c.resultFile, 'json/tests.json')
  }
})

void test('aggregate stats match EnricoMi tests.results.json', () => {
  const parsed = parseDartJson(content, 'json/tests.json')
  const stats = aggregate([parsed], { commit: 'commit sha' })
  // Expected "stats" object from EnricoMi python/test/files/dart/json/tests.results.json
  assert.equal(stats.files, 1)
  assert.equal(stats.suites, 4)
  assert.equal(stats.duration, 0)
  assert.equal(stats.tests, 20)
  assert.equal(stats.tests_succ, 16)
  assert.equal(stats.tests_skip, 1)
  assert.equal(stats.tests_fail, 1)
  assert.equal(stats.tests_error, 2)
  assert.equal(stats.runs, 20)
  assert.equal(stats.runs_succ, 16)
  assert.equal(stats.runs_skip, 1)
  assert.equal(stats.runs_fail, 1)
  assert.equal(stats.runs_error, 2)
})

void test('FormatParser wiring: detect + parse via the exported parser', () => {
  assert.equal(dart.name, 'Dart JSON')
  assert.equal(dart.detect(content, 'json/tests.json'), true)
  const parsed = dart.parse(content, 'json/tests.json')
  assert.equal(parsed.file, 'json/tests.json')
  assert.equal(parsed.suites.length, 4)
})

/** Build a minimal Dart JSON event stream for one test with an error event. */
function stream (result: string, isFailure: boolean | undefined): string {
  const error =
    isFailure === undefined
      ? ''
      : `{"type":"error","testID":1,"error":"boom","stackTrace":"st","isFailure":${String(isFailure)}}\n`
  return (
    '{"type":"start","protocolVersion":"0.1.1","time":0}\n' +
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    error +
    `{"type":"testDone","testID":1,"result":"${result}","time":5}\n`
  )
}

void test('isFailure=false maps to error even when result is "failure"', () => {
  const c = caseNamed(parseDartJson(stream('failure', false), 'a.json'), 't1')
  assert.equal(c.result, 'error')
})

void test('isFailure=true maps to failure even when result is "error"', () => {
  const c = caseNamed(parseDartJson(stream('error', true), 'a.json'), 't1')
  assert.equal(c.result, 'failure')
})

void test('absent isFailure falls back to testDone.result', () => {
  const c = caseNamed(parseDartJson(stream('failure', undefined), 'a.json'), 't1')
  assert.equal(c.result, 'failure')
})

void test('malformed JSON lines are skipped (parse continues)', () => {
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    'this is not json at all\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    '{"type":"testDone","testID":1,"result":"success","time":5}\n'
  const parsed = parseDartJson(input, 'a.json')
  const c = caseNamed(parsed, 't1')
  assert.equal(c.result, 'success')
})

void test('missing start/end times yield null case time', () => {
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0}}\n' +
    '{"type":"testDone","testID":1,"result":"success"}\n'
  const parsed = parseDartJson(input, 'a.json')
  const c = caseNamed(parsed, 't1')
  assert.equal(c.time, null)
})

void test('non-object JSON lines (array/null) are skipped', () => {
  // valid JSON whose top-level value is not an object -> asObject undefined
  const input =
    '[1,2,3]\n' +
    'null\n' +
    '42\n' +
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    '{"type":"testDone","testID":1,"result":"success","time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(caseNamed(parsed, 't1').result, 'success')
})

void test('malformed events (missing suite/test/ids) are skipped', () => {
  const input =
    // suite event with no suite object
    '{"type":"suite","time":0}\n' +
    // suite event with non-object suite -> asObject undefined
    '{"type":"suite","suite":42,"time":0}\n' +
    // suite event with suite missing id
    '{"type":"suite","suite":{"path":"x_test.dart"},"time":0}\n' +
    // testStart with no test object
    '{"type":"testStart","time":0}\n' +
    // testStart with test missing id
    '{"type":"testStart","test":{"name":"nope","suiteID":0},"time":0}\n' +
    // testDone with no testID
    '{"type":"testDone","result":"success","time":1}\n' +
    // error with no testID
    '{"type":"error","error":"boom","time":1}\n' +
    // a valid suite + test so we have something to assert
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    '{"type":"testDone","testID":1,"result":"success","time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.name, 'a_test.dart')
  assert.equal(caseNamed(parsed, 't1').result, 'success')
})

void test('testDone for unknown test id creates a fresh entry', () => {
  // No testStart for id 9; testDone references it directly -> tests.get(9) ?? {}
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testDone","testID":9,"result":"failure","time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  // id 9 has no suiteID, so it is not attached to any suite
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.cases.length, 0)
})

void test('error for unknown test id creates a fresh entry', () => {
  // No testStart/testDone for id 7 before the error -> tests.get(7) ?? {}
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"error","testID":7,"error":"boom","stackTrace":"st","isFailure":true,"time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.cases.length, 0)
})

void test('skip print before any testStart is ignored', () => {
  // print/skip arrives but lastTestId is undefined -> no-op branch
  const input =
    '{"type":"print","messageType":"skip","message":"early skip","time":0}\n' +
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    '{"type":"testDone","testID":1,"result":"success","skipped":true,"time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  const c = caseNamed(parsed, 't1')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, undefined)
})

void test('skip print for a test with no prior tracked entry seeds reason', () => {
  // testStart sets lastTestId, but the entry map can lack it only when the id
  // was started; here we drive the `?? {}` by a print after a testStart whose
  // entry exists, then assert reason is recorded.
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    '{"type":"print","messageType":"skip","message":"because reasons","time":0}\n' +
    '{"type":"testDone","testID":1,"result":"success","skipped":true,"time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  const c = caseNamed(parsed, 't1')
  assert.equal(c.result, 'skipped')
  assert.equal(c.message, 'because reasons')
})

void test('suite with no tests and no path yields empty-named empty suite', () => {
  // suite present but never referenced by a testStart (suiteTests.get -> []),
  // and suite.path missing (suite?.path ?? '').
  const input = '{"type":"suite","suite":{"id":5},"time":0}\n'
  const parsed = parseDartJson(input, 'a.json')
  assert.equal(parsed.suites.length, 1)
  assert.equal(parsed.suites[0]?.name, '')
  assert.equal(parsed.suites[0]?.cases.length, 0)
})

void test('testDone with no result and no isFailure maps to error; missing name -> empty', () => {
  // result ?? 'error' fallback (no result) and test.name ?? '' (no name).
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"suiteID":0},"time":0}\n' +
    '{"type":"testDone","testID":1,"time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  assert.equal(parsed.suites[0]?.cases.length, 1)
  const c = parsed.suites[0]?.cases[0]
  assert.ok(c !== undefined)
  assert.equal(c.testName, '')
  assert.equal(c.result, 'error')
})

void test('non-success non-failure result with absent isFailure maps to error', () => {
  // caseResult: result is neither success nor failure, isFailure absent ->
  // the `: error` arm of `result === failure ? failure : error`.
  const input =
    '{"type":"suite","suite":{"id":0,"path":"a_test.dart"},"time":0}\n' +
    '{"type":"testStart","test":{"id":1,"name":"t1","suiteID":0},"time":0}\n' +
    '{"type":"testDone","testID":1,"result":"timeout","time":1}\n'
  const parsed = parseDartJson(input, 'a.json')
  assert.equal(caseNamed(parsed, 't1').result, 'error')
})

void test('isDartJson rejects a start event without protocolVersion', () => {
  // type === 'start' is true but 'protocolVersion' in event is false ->
  // the && short-circuits to false.
  assert.equal(isDartJson('{"type":"start","time":0}', 'x.json'), false)
})

void test('isDartJson rejects a non-object first line (array/scalar)', () => {
  // valid JSON whose top-level value is not an object -> asObject undefined ->
  // the `event === undefined` early return.
  assert.equal(isDartJson('[1,2,3]', 'x.json'), false)
  assert.equal(isDartJson('123', 'x.json'), false)
})
