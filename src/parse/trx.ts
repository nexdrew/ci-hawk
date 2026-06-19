import { XMLParser } from 'fast-xml-parser'
import type {
  CaseResult,
  FormatParser,
  ParsedFile,
  ParsedSuite,
  TestCase
} from '../types.js'

/**
 * Visual Studio TRX (`<TestRun>`) → parsed test model.
 *
 * Direct port of `python/publish/xslt/trx-to-junit.xslt` from the EnricoMi
 * action. TRX records test outcomes in `<Results>/<UnitTestResult>` and the
 * test method metadata (classname/name) in `<TestDefinitions>/<UnitTest>`.
 * The two are correlated by `testId` (UnitTestResult/@testId == UnitTest/@id)
 * for the 2010 schema, and by `executionId` (UnitTestResult/@executionId ==
 * UnitTest/Execution/@id) for the 2006 schema. The XSLT keys on @id; we build
 * both maps so either schema resolves.
 *
 * outcome attribute determines status (default 'Error' when absent):
 *   contains 'Failed'                          -> failure
 *   contains 'Error'                           -> error
 *   contains 'Passed'                          -> success
 *   anything else (NotExecuted/Aborted/...)    -> skipped
 * ErrorInfo/Message becomes the case message; Message+StackTrace concatenated
 * becomes the content. We emit a single leaf suite ("MSTestSuite"), exactly as
 * the stylesheet does, so the resulting stats are identical.
 *
 * Data-driven tests nest their per-iteration results under <InnerResults>. The
 * XSLT selects //UnitTestResult (any depth), so we gather results recursively —
 * the outer aggregate result and each inner iteration each become a case
 * (resolved via testId/executionId like any other result).
 */

const ARRAY_TAGS = new Set(['UnitTestResult', 'UnitTest'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // TRX namespaces every element (TeamTest 2006/2010); drop the prefix so the
  // element names match the schema-agnostic structure the XSLT walks.
  removeNSPrefix: true,
  // Message/StackTrace bodies may arrive as CDATA; keep them verbatim.
  cdataPropName: '#cdata',
  isArray: (name) => ARRAY_TAGS.has(name)
})

type XmlNode = Record<string, unknown>

function attr (node: XmlNode, name: string): string | undefined {
  const v = node[`@_${name}`]
  return v === undefined || v === null ? undefined : String(v)
}

function asNodes (value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value as XmlNode[]
  if (value !== null && typeof value === 'object') return [value as XmlNode]
  return []
}

/** Coerce a primitive XML scalar to a string; objects/arrays become ''. */
function scalar (value: unknown): string {
  if (value === undefined || value === null) return ''
  // Unreachable in practice: callers only pass element values / #text / #cdata,
  // which this parser config yields as string-or-undefined, never an object.
  // Kept to honour the documented "objects/arrays become ''" contract.
  /* c8 ignore next */
  if (typeof value === 'object') return ''
  if (typeof value === 'string') return value
  // Unreachable: the XMLParser is configured with parseAttributeValue:false and
  // parseTagValue:false, so every value reaching here is already a string (or
  // object/null, handled above). Kept as a defensive coercion.
  /* c8 ignore next 4 */
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

/** Decode numeric XML character references (e.g. &#xD; -> CR, &#10; -> LF). */
function decodeNumericEntities (s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      codePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      codePoint(Number.parseInt(dec, 10))
    )
}

function codePoint (n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
    // Unreachable catch: the range/finiteness guard above already excludes every
    // input that would make String.fromCodePoint throw (the regex only yields
    // non-negative integers, and surrogates do not throw). Defensive only.
    /* c8 ignore next 3 */
  } catch {
    return ''
  }
}

/**
 * Text content of an element, joining a regular text node and any CDATA.
 * fast-xml-parser (with parseTagValue:false) decodes named entities but leaves
 * numeric character references literal, so we decode those here to match the
 * lxml/XSLT output (e.g. failure detail with &#xD;&#xA; line breaks).
 */
function elemText (value: unknown): string {
  const nodes = asNodes(value)
  if (nodes.length === 0) return decodeNumericEntities(scalar(value))
  const node = nodes[0]
  // Unreachable: nodes.length > 0 was just checked, so nodes[0] is defined. The
  // guard exists only to satisfy noUncheckedIndexedAccess.
  /* c8 ignore next */
  if (node === undefined) return ''
  return decodeNumericEntities(`${scalar(node['#text'])}${scalar(node['#cdata'])}`)
}

/**
 * Parse a TRX duration "HH:MM:SS.fffffff" into seconds, mirroring the XSLT
 * substring arithmetic. Returns null when the string is unparseable.
 */
function parseDuration (value: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value)
  if (m === null) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  // Unreachable: the regex only matches digit groups, so each Number(...) is a
  // finite value. Defensive guard against a malformed capture.
  /* c8 ignore next 3 */
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null
  }
  return hours * 3600 + minutes * 60 + seconds
}

/** ISO-8601 timestamp -> epoch seconds (fractional). null when invalid. */
function isoSeconds (value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms / 1000 : null
}

/** Case execution time, preferring @duration then @startTime/@endTime. */
function caseTime (result: XmlNode): number | null {
  const duration = attr(result, 'duration')
  if (duration !== undefined) return parseDuration(duration)

  const start = attr(result, 'startTime')
  const end = attr(result, 'endTime')
  if (start !== undefined && end !== undefined) {
    const s = isoSeconds(start)
    const e = isoSeconds(end)
    if (s !== null && e !== null) return e - s
  }
  return 0
}

/**
 * Map a TRX outcome to a case result. Absent outcome is treated as 'Error'
 * (the XSLT's `@otherwise` branch). The order matches the stylesheet's
 * `contains()` checks: Failed, then Error, then Passed, else skipped.
 */
function mapOutcome (outcome: string | undefined): CaseResult {
  const value = outcome ?? 'Error'
  if (value.includes('Failed')) return 'failure'
  if (value.includes('Error')) return 'error'
  if (value.includes('Passed')) return 'success'
  return 'skipped'
}

/**
 * className per XSLT: take TestMethod/@className up to the first comma (the
 * assembly-qualified suffix is dropped).
 */
function classNameOf (unitTest: XmlNode): string {
  const method = asNodes(unitTest.TestMethod)[0]
  const raw = method !== undefined ? attr(method, 'className') : undefined
  if (raw === undefined) return ''
  const comma = raw.indexOf(',')
  return comma === -1 ? raw : raw.slice(0, comma)
}

/**
 * shortTestName per XSLT: when @testName begins with "className." strip that
 * prefix, otherwise use @testName verbatim.
 */
function shortTestName (testName: string, className: string): string {
  const prefix = `${className}.`
  return className !== '' && testName.startsWith(prefix)
    ? testName.slice(prefix.length)
    : testName
}

interface UnitTestMaps {
  byId: Map<string, XmlNode>
  byExecutionId: Map<string, XmlNode>
}

function indexUnitTests (defs: XmlNode | undefined): UnitTestMaps {
  const byId = new Map<string, XmlNode>()
  const byExecutionId = new Map<string, XmlNode>()
  if (defs === undefined) return { byId, byExecutionId }

  for (const unitTest of asNodes(defs.UnitTest)) {
    const id = attr(unitTest, 'id')
    if (id !== undefined) byId.set(id, unitTest)
    const exec = asNodes(unitTest.Execution)[0]
    const execId = exec !== undefined ? attr(exec, 'id') : undefined
    if (execId !== undefined) byExecutionId.set(execId, unitTest)
  }
  return { byId, byExecutionId }
}

function toCase (
  result: XmlNode,
  unitTest: XmlNode | undefined,
  file: string
): TestCase {
  const testName = attr(result, 'testName') ?? ''
  // The else arm is unreachable: parseTrxXml `continue`s before calling toCase
  // when no UnitTest matched, so unitTest is always defined here.
  /* c8 ignore next */
  const className = unitTest !== undefined ? classNameOf(unitTest) : ''
  const status = mapOutcome(attr(result, 'outcome'))
  const time = caseTime(result)

  const base: TestCase = {
    className,
    testName: shortTestName(testName, className),
    resultFile: file,
    time,
    result: status
  }

  if (status === 'success') return base

  const errorInfo = asNodes(asNodes(result.Output)[0]?.ErrorInfo)[0]
  const message =
    errorInfo !== undefined ? elemText(errorInfo.Message) : ''
  const stack =
    errorInfo !== undefined ? elemText(errorInfo.StackTrace) : ''

  // The XSLT writes message+stacktrace as body for failure/error; for skipped
  // it passes an empty stacktrace, so content is just the message.
  base.message = message
  base.content = status === 'skipped' ? message : `${message}${stack}`
  return base
}

/** Collect UnitTestResult elements at any depth (outer + nested InnerResults). */
function gatherResults (container: XmlNode | undefined, out: XmlNode[]): void {
  if (container === undefined) return
  for (const result of asNodes(container.UnitTestResult)) {
    out.push(result)
    gatherResults(asNodes(result.InnerResults)[0], out)
  }
}

export function parseTrxXml (xml: string, file = ''): ParsedFile {
  const doc = parser.parse(xml) as XmlNode
  const run = asNodes(doc.TestRun)[0]
  if (run === undefined) return { file, suites: [] }

  const { byId, byExecutionId } = indexUnitTests(asNodes(run.TestDefinitions)[0])
  const results: XmlNode[] = []
  gatherResults(asNodes(run.Results)[0], results)

  const cases: TestCase[] = []
  for (const result of results) {
    const testId = attr(result, 'testId')
    const executionId = attr(result, 'executionId')
    let unitTest: XmlNode | undefined
    if (testId !== undefined) unitTest = byId.get(testId)
    if (unitTest === undefined && executionId !== undefined) {
      unitTest = byExecutionId.get(executionId)
    }
    // The XSLT emits a testcase only inside `for-each key('unitTests',...)`, so
    // a result with no matching UnitTest definition produces no case.
    if (unitTest === undefined) continue
    cases.push(toCase(result, unitTest, file))
  }

  // The stylesheet emits exactly one leaf <testsuite name="MSTestSuite">.
  const suites: ParsedSuite[] =
    cases.length > 0 ? [{ name: 'MSTestSuite', cases }] : []
  return { file, suites }
}

/** Sniff for a TRX root <TestRun> element. Conservative and side-effect free. */
export function isTrx (xml: string): boolean {
  return /<\s*TestRun[\s/>]/.test(xml)
}

export const trx: FormatParser = {
  name: 'TRX',
  detect: (content) => isTrx(content),
  parse: (content, path) => parseTrxXml(content, path)
}
