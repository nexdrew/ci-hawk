import type {
  CaseResult,
  FormatParser,
  ParsedFile,
  ParsedSuite,
  TestCase
} from '../types.js'

/**
 * Mocha JSON reporter → parsed test model.
 *
 * This is a faithful port of `python/publish/mocha.py` from the EnricoMi
 * action. A Mocha JSON document is a single object:
 *
 *   { stats: { suites, duration, start, ... },
 *     tests: [ { fullTitle, file, duration, err } ],
 *     pending: [ { fullTitle, ... } ] }
 *
 * The Python port flattens every entry in `tests` into one `<testcase>` under
 * a single `<testsuite>` (so a Mocha file is always one leaf suite). Mapping:
 *   testcase name        = test.fullTitle
 *   testcase file        = test.file
 *   testcase time        = test.duration
 *   non-empty test.err   => failure, or error when err.errorMode is set
 *   fullTitle in pending => skipped
 *   otherwise            => success
 *   failure/error message = err.message (control chars stripped)
 *   failure/error content = name + message + stack joined by '\n'
 *                           (each control-char-stripped, empty parts dropped)
 *
 * DURATION: the EnricoMi pipeline takes the run duration from the suite's
 * `time` attribute, which it sets to `stats.duration`. We set the suite-level
 * `time` to `stats.duration` so aggregate() reports the same `duration` as the
 * Python action (keeping the digest compatible). Per-case `duration` is still
 * carried for per-test fidelity.
 */

type JsonObj = Record<string, unknown>

function asObj (value: unknown): JsonObj | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObj
  }
  return undefined
}

function asArray (value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Coerce a JSON scalar to a string; objects/arrays/null/undefined become ''. */
function str (value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

function num (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/** Strip C0 control characters (code points 0–31), matching the Python port. */
function stripControl (value: string): string {
  let out = ''
  for (const ch of value) {
    if (ch.charCodeAt(0) >= 32) out += ch
  }
  return out
}

function toCase (
  test: JsonObj,
  skipped: Set<string>,
  file: string
): TestCase {
  const testName = str(test.fullTitle)
  const className = ''
  const time = num(test.duration)
  const sourceFile = str(test.file)
  const resultFile = sourceFile !== '' ? sourceFile : file

  const err = asObj(test.err)
  // a non-empty err object signals failure/error
  if (err !== undefined && Object.keys(err).length > 0) {
    const errorMode = str(err.errorMode)
    const result: CaseResult = errorMode !== '' ? 'error' : 'failure'
    const message = stripControl(str(err.message))
    const content = [err.name, err.message, err.stack]
      .map((part) => stripControl(str(part)))
      .filter((part) => part !== '')
      .join('\n')
    return {
      className,
      testName,
      resultFile,
      time,
      result,
      message,
      content
    }
  }

  if (skipped.has(testName)) {
    return { className, testName, resultFile, time, result: 'skipped' }
  }

  return { className, testName, resultFile, time, result: 'success' }
}

/** Sniff for a Mocha JSON document. Conservative and side-effect free. */
export function isMochaJson (content: string, path = ''): boolean {
  if (!path.endsWith('.json') && path !== '') return false
  let doc: unknown
  try {
    doc = JSON.parse(content)
  } catch {
    return false
  }
  const root = asObj(doc)
  if (root === undefined) return false
  const stats = asObj(root.stats)
  if (stats === undefined || !('suites' in stats)) return false
  if (!Array.isArray(root.tests)) return false
  const tests = root.tests
  if (!tests.every((t) => asObj(t) !== undefined)) return false
  // every test must carry a non-empty fullTitle (empty list is fine)
  return tests.every((t) => {
    const obj = asObj(t)
    return obj !== undefined && str(obj.fullTitle) !== ''
  })
}

export function parseMochaJson (content: string, file = ''): ParsedFile {
  const doc = JSON.parse(content) as unknown
  const root = asObj(doc) ?? {}

  const skipped = new Set<string>()
  for (const p of asArray(root.pending)) {
    const obj = asObj(p)
    if (obj !== undefined) {
      const title = str(obj.fullTitle)
      if (title !== '') skipped.add(title)
    }
  }

  const cases: TestCase[] = []
  for (const t of asArray(root.tests)) {
    const obj = asObj(t)
    if (obj !== undefined) cases.push(toCase(obj, skipped, file))
  }

  // a Mocha document is always a single leaf suite; its duration is the
  // reported stats.duration (matching the Python action), not the case-time sum
  const stats = asObj(root.stats)
  const suiteTime = stats !== undefined ? num(stats.duration) : null
  const suites: ParsedSuite[] = [{ name: '', cases, time: suiteTime }]
  return { file, suites }
}

export const mocha: FormatParser = {
  name: 'Mocha JSON',
  detect: (content, path) => isMochaJson(content, path),
  parse: (content, path) => parseMochaJson(content, path)
}
