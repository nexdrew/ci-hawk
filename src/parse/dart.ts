import type {
  CaseResult,
  FormatParser,
  ParsedFile,
  ParsedSuite,
  TestCase
} from '../types.js'

/**
 * Dart "json" test reporter -> parsed test model.
 *
 * The Dart test runner's `--reporter json` emits newline-delimited JSON: one
 * event object per line. This is a faithful port of
 * `python/publish/dart.py` from the EnricoMi action, which folds those events
 * into a JUnit tree. We build the leaf-suite model directly instead of
 * round-tripping through XML, but the semantics (and therefore the resulting
 * stats) are identical.
 *
 * Event types we consume (see
 * https://github.com/dart-lang/test/blob/master/pkgs/test/doc/json_reporter.md):
 *   suite     -> a test file (suite.id, suite.path)
 *   testStart -> a test begins (test.id, test.name, test.suiteID, time=start)
 *   testDone  -> a test ends (testID, result, skipped, hidden, time=end)
 *   error     -> failure/error detail (testID, error, stackTrace, isFailure)
 *   print(skip) -> skip reason message for a test
 *
 * Status mapping mirrors dart.py's `create_test`, which sets the testcase
 * element to 'failure' when result === 'failure' and 'error' otherwise:
 *   result === 'success' && skipped  -> 'skipped'
 *   result === 'success'             -> 'success'
 *   result === 'failure'             -> 'failure'
 *   anything else (incl. missing)    -> 'error'
 *
 * FAILURE vs ERROR: EnricoMi derives run-level fail/error from the error
 * event's `isFailure` flag. cinct's single per-case status honors `isFailure`
 * when present (failure when true, error when false) and falls back to
 * testDone.result otherwise — so it matches EnricoMi's counts for all valid
 * Dart output, where isFailure and result are consistent.
 *
 * DURATION: dart.py never assigns a leaf-suite end time, so its leaf-suite time
 * (via junitparser) is the sum of case times — which is exactly what cinct's
 * aggregate() computes when no suite time is set. So we do NOT set suite.time
 * here; the case-time sum already matches the Python action.
 *
 * Hidden tests (the synthetic "loading <file>" entries) are excluded from the
 * suites, exactly as dart.py drops `hidden is True` tests from each suite.
 */

interface DartTest {
  name?: string
  suiteID?: number
  url?: string
  start?: number
  end?: number
  result?: string
  hidden?: boolean
  skipped?: boolean
  error?: string
  stackTrace?: string
  isFailure?: boolean
  reason?: string
}

interface DartSuite {
  path?: string
}

type JsonObject = Record<string, unknown>

function asObject (value: unknown): JsonObject | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject
  }
  return undefined
}

function str (value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numOf (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boolOf (value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Join a non-empty error message and stack trace, mirroring dart.py. */
function joinContent (error?: string, stack?: string): string | undefined {
  const parts = [error, stack].filter(
    (p): p is string => p !== undefined && p !== ''
  )
  return parts.length > 0 ? parts.join('\n') : undefined
}

function caseResult (test: DartTest): CaseResult {
  const result = test.result ?? 'error'
  if (result !== 'success') {
    // EnricoMi distinguishes failure vs error by the error event's isFailure
    // flag; honor it when present so our single status matches both its
    // test-level and run-level counts. Fall back to testDone.result otherwise.
    if (test.isFailure === true) return 'failure'
    if (test.isFailure === false) return 'error'
    return result === 'failure' ? 'failure' : 'error'
  }
  if (test.skipped === true) return 'skipped'
  return 'success'
}

function toCase (test: DartTest, file: string): TestCase {
  const time =
    test.start !== undefined && test.end !== undefined
      ? (test.end - test.start) / 1000.0
      : null
  const result = caseResult(test)

  const base: TestCase = {
    className: '',
    testName: test.name ?? '',
    resultFile: file,
    time,
    result
  }

  if (result === 'failure' || result === 'error') {
    const content = joinContent(test.error, test.stackTrace)
    return {
      ...base,
      message: test.error,
      content
    }
  }
  if (result === 'skipped' && test.reason !== undefined) {
    return { ...base, message: test.reason }
  }
  return base
}

/** Parse the Dart JSON event stream into leaf suites with their cases. */
export function parseDartJson (content: string, file = ''): ParsedFile {
  const tests = new Map<number, DartTest>()
  const suites = new Map<number, DartSuite>()
  const suiteOrder: number[] = []
  const suiteTests = new Map<number, number[]>()
  // Tracks the most recently started test id, to mirror dart.py's reason
  // handling (it keys skip messages off the last seen test id).
  let lastTestId: number | undefined

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: JsonObject | undefined
    try {
      event = asObject(JSON.parse(trimmed))
    } catch {
      continue
    }
    if (event === undefined) continue

    const type = str(event.type)

    if (type === 'suite') {
      const suite = asObject(event.suite)
      if (suite === undefined) continue
      const id = numOf(suite.id)
      if (id === undefined) continue
      if (!suites.has(id)) suiteOrder.push(id)
      suites.set(id, { path: str(suite.path) })
    } else if (type === 'testStart') {
      const test = asObject(event.test)
      if (test === undefined) continue
      const id = numOf(test.id)
      if (id === undefined) continue
      const suiteID = numOf(test.suiteID)
      const entry: DartTest = {
        name: str(test.name),
        suiteID,
        url: str(test.url),
        start: numOf(event.time)
      }
      tests.set(id, entry)
      lastTestId = id
      if (suiteID !== undefined) {
        const list = suiteTests.get(suiteID) ?? []
        list.push(id)
        suiteTests.set(suiteID, list)
      }
    } else if (type === 'testDone') {
      const id = numOf(event.testID)
      if (id === undefined) continue
      const entry = tests.get(id) ?? {}
      entry.result = str(event.result)
      entry.hidden = boolOf(event.hidden)
      entry.skipped = boolOf(event.skipped)
      entry.end = numOf(event.time)
      tests.set(id, entry)
    } else if (type === 'error') {
      const id = numOf(event.testID)
      if (id === undefined) continue
      const entry = tests.get(id) ?? {}
      entry.error = str(event.error)
      entry.stackTrace = str(event.stackTrace)
      entry.isFailure = boolOf(event.isFailure)
      tests.set(id, entry)
    } else if (type === 'print' && str(event.messageType) === 'skip') {
      // dart.py keys the skip reason off the last started test id.
      if (lastTestId !== undefined) {
        // lastTestId is only ever set by testStart, which always populates the
        // map for that id, so tests.get(lastTestId) is never undefined here.
        /* c8 ignore next */
        const entry = tests.get(lastTestId) ?? {}
        entry.reason = str(event.message)
        tests.set(lastTestId, entry)
      }
    }
  }

  const parsedSuites: ParsedSuite[] = []
  for (const suiteId of suiteOrder) {
    const suite = suites.get(suiteId)
    const ids = suiteTests.get(suiteId) ?? []
    // do not count hidden tests (the synthetic "loading <file>" entries)
    const cases = ids
      .map((id) => tests.get(id))
      .filter((t): t is DartTest => t !== undefined && t.hidden !== true)
      .map((t) => toCase(t, file))
    parsedSuites.push({ name: suite?.path ?? '', cases })
  }

  return { file, suites: parsedSuites }
}

/**
 * Sniff for a Dart JSON report: a `.json` file whose first line is a `start`
 * event carrying `protocolVersion`. Conservative and side-effect free.
 */
export function isDartJson (content: string, path: string): boolean {
  if (!path.endsWith('.json')) return false
  const newline = content.indexOf('\n')
  const first = (newline === -1 ? content : content.slice(0, newline)).trim()
  if (first === '') return false
  try {
    const event = asObject(JSON.parse(first))
    if (event === undefined) return false
    return event.type === 'start' && 'protocolVersion' in event
  } catch {
    return false
  }
}

export const dart: FormatParser = {
  name: 'Dart JSON',
  detect: (content, path) => isDartJson(content, path),
  parse: (content, path) => parseDartJson(content, path)
}
