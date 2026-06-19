/** A single test case execution ("run"). */
export interface TestCase {
  className: string
  testName: string
  /** Path to the result file this case came from (used for annotations). */
  resultFile?: string
  /** Execution time in the file's native time unit (seconds by default). */
  time: number | null
  result: CaseResult
  message?: string
  content?: string
}

export type CaseResult = 'success' | 'skipped' | 'failure' | 'error'

/**
 * Aggregated run statistics. Field names and order intentionally match the
 * Python action's `UnitTestRunResults.to_dict()` so the gzip+base64 digest
 * stays byte-compatible across the two implementations.
 *
 * See: python/publish/unittestresults.py (to_dict / from_dict)
 */
export interface RunResults {
  files: number
  suites: number
  duration: number

  tests: number
  tests_succ: number
  tests_skip: number
  tests_fail: number
  tests_error: number

  runs: number
  runs_succ: number
  runs_skip: number
  runs_fail: number
  runs_error: number

  commit: string
}

/** A flat suite extracted from a JUnit tree: a leaf testsuite plus its cases. */
export interface ParsedSuite {
  name: string
  cases: TestCase[]
  /**
   * Optional suite-level duration in the file's native time unit. Some formats
   * report a suite total that is not the sum of case times (e.g. Mocha's
   * stats.duration, Dart's suite end-start). When set, aggregate() uses it for
   * the run duration; otherwise it falls back to the sum of case times. This
   * keeps the digest's `duration` field compatible with the Python action.
   */
  time?: number | null
}

export interface ParsedFile {
  file: string
  suites: ParsedSuite[]
}

/** A file that could not be parsed by any registered format. */
export interface ParseError {
  file: string
  message: string
}

/**
 * A pluggable parser for one test result format. Adding support for a new
 * format is a single new module exporting one of these plus a registry entry.
 */
export interface FormatParser {
  /** Human-readable format name, e.g. "JUnit", "TAP". */
  name: string
  /**
   * Cheap content/path sniff. Must be side-effect free and tolerant of
   * unrelated files (return false rather than throwing). Parsers are tried in
   * registry order; the first match wins, so more specific formats register
   * before more general ones.
   */
  detect: (content: string, path: string) => boolean
  /** Parse a matched file into the common model. */
  parse: (content: string, path: string) => ParsedFile
}
