import { XMLParser } from 'fast-xml-parser'
import type {
  CaseResult,
  FormatParser,
  ParsedFile,
  ParsedSuite,
  TestCase
} from '../types.js'

/**
 * NUnit (v2 `<test-results>` and v3 `<test-run>`) → parsed test model.
 *
 * This is a direct port of `python/publish/xslt/nunit3-to-junit.xslt` from the
 * EnricoMi action, which the Python pipeline applies to *both* the NUnit 3
 * `<test-run>` root and the legacy NUnit 2 `<test-results>` root (its template
 * matches `/test-run | /test-results`). The stylesheet maps:
 *   test-suite -> testsuite   (recursively; grouping + leaf suites)
 *   test-case  -> testcase    (name=@name, classname=@classname,
 *                              time=@duration|@time)
 *   test-case/failure -> <error> when the case's @result='Error',
 *                        otherwise <failure>
 *                        (message=failure/message, body=failure/stack-trace)
 *   test-case skip       -> <skipped message="reason/message"> when
 *                           @executed='False' or @result/@runstate is one of
 *                           Skipped / Ignored / NotRunnable / Inconclusive
 *
 * Per the stylesheet, `test-suite/failure` is dropped (only test-case failures
 * count) and `@label` is ignored for error detection — only `@result='Error'`
 * promotes a failure to an error.
 *
 * We emit the parsed model directly rather than round-tripping through a JUnit
 * XML string, but the semantics (and therefore the resulting stats) are
 * identical to running the stylesheet and then the JUnit parser. Only leaf
 * suites (test-suites that directly hold test-cases) are emitted, matching how
 * the JUnit parser collapses the nested testsuite tree.
 */

const ARRAY_TAGS = new Set(['test-suite', 'test-case'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // keep raw strings; we coerce numbers ourselves to control rounding
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // CDATA in <message>/<stack-trace> must be preserved verbatim
  cdataPropName: '#cdata',
  isArray: (name) => ARRAY_TAGS.has(name)
})

type XmlNode = Record<string, unknown>

function attr (node: XmlNode, name: string): string | undefined {
  const v = node[`@_${name}`]
  return v === undefined || v === null ? undefined : String(v)
}

function num (value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asNodes (value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value as XmlNode[]
  if (value !== null && typeof value === 'object') return [value as XmlNode]
  return []
}

/** Coerce a primitive XML scalar to a string; objects/arrays become ''. */
function scalar (value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return ''
  if (typeof value === 'string') return value
  // XMLParser uses parseAttributeValue:false and parseTagValue:false, so every
  // scalar is already a string; the number/boolean arm (and the final fallback)
  // is unreachable defensive code.
  /* c8 ignore next 4 */
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

/** Text content of an element, joining a regular text node and any CDATA. */
function elemText (value: unknown): string {
  const nodes = asNodes(value)
  if (nodes.length === 0) {
    // could be a plain scalar (no children/attrs)
    return scalar(value)
  }
  const node = nodes[0]
  // message/reason/stack-trace are never in ARRAY_TAGS, so asNodes only ever
  // returns a single-element array of a defined object here; the undefined
  // guard exists only to satisfy noUncheckedIndexedAccess and is unreachable.
  /* c8 ignore next */
  if (node === undefined) return ''
  return `${scalar(node['#text'])}${scalar(node['#cdata'])}`
}

const SKIP_RESULTS = new Set([
  'Skipped',
  'Ignored',
  'NotRunnable',
  'Inconclusive'
])
const SKIP_RUNSTATES = new Set(['Skipped', 'Ignored', 'NotRunnable'])

/** Mirror the stylesheet's skip predicate for a test-case. */
function isSkipped (tc: XmlNode): boolean {
  if (attr(tc, 'executed') === 'False') return true
  const result = attr(tc, 'result')
  if (result !== undefined && SKIP_RESULTS.has(result)) return true
  const runstate = attr(tc, 'runstate')
  if (runstate !== undefined && SKIP_RUNSTATES.has(runstate)) return true
  return false
}

function toCase (tc: XmlNode, file: string): TestCase {
  const className = attr(tc, 'classname') ?? ''
  const testName = attr(tc, 'name') ?? ''
  const time = num(attr(tc, 'duration') ?? attr(tc, 'time'))

  const failure = asNodes(tc.failure)[0]
  if (failure !== undefined) {
    // @result='Error' promotes the failure element to an error; otherwise it
    // is a plain failure. precedence error > failure matches the JUnit parser.
    const result: CaseResult =
      attr(tc, 'result') === 'Error' ? 'error' : 'failure'
    const message = elemText(failure.message)
    const stack = elemText(failure['stack-trace'])
    return {
      className,
      testName,
      resultFile: file,
      time,
      result,
      message,
      content: `${message}${stack}`
    }
  }

  if (isSkipped(tc)) {
    const reason = asNodes(tc.reason)[0]
    const message = reason !== undefined ? elemText(reason.message) : ''
    return {
      className,
      testName,
      resultFile: file,
      time,
      result: 'skipped',
      message
    }
  }

  return { className, testName, resultFile: file, time, result: 'success' }
}

/**
 * Compute the leaf-suite name the way the stylesheet does: prefer @fullname,
 * then @classname, otherwise the dotted path of ancestor TestSuite/Namespace
 * names plus this suite's own @name. The name does not affect stats; it only
 * labels the suite.
 */
function suiteName (node: XmlNode, ancestors: string[]): string {
  const full = attr(node, 'fullname')
  if (full !== undefined) return full
  const cls = attr(node, 'classname')
  if (cls !== undefined) return cls
  const own = attr(node, 'name') ?? ''
  return ancestors.length > 0 ? `${ancestors.join('.')}.${own}` : own
}

/**
 * Children of a test-suite. NUnit 2 wraps them in a `<results>` element
 * (`test-suite > results > test-suite|test-case`); NUnit 3 nests them directly.
 * Support both by descending into `results` when present.
 */
function childContainer (node: XmlNode): XmlNode {
  const results = asNodes(node.results)[0]
  return results ?? node
}

/** Recursively collect leaf <test-suite> elements (those holding test-cases). */
function collectLeafSuites (
  node: XmlNode,
  file: string,
  ancestors: string[],
  out: ParsedSuite[]
): void {
  const container = childContainer(node)
  const cases = asNodes(container['test-case'])
  const childSuites = asNodes(container['test-suite'])

  // Mirrors get_leaf_suites() in python/publish/junit.py: a suite is a leaf
  // when it directly holds test-cases, OR when it has no child suites at all
  // (an empty leaf still counts as a suite).
  if (cases.length > 0 || childSuites.length === 0) {
    out.push({
      name: suiteName(node, ancestors),
      cases: cases.map((tc) => toCase(tc, file))
    })
  }

  const type = attr(node, 'type')
  const nextAncestors =
    type === 'TestSuite' || type === 'Namespace'
      ? [...ancestors, attr(node, 'name') ?? '']
      : ancestors

  for (const child of childSuites) {
    collectLeafSuites(child, file, nextAncestors, out)
  }
}

/** Parse an NUnit XML string into a flat list of leaf suites with cases. */
export function parseNUnitXml (xml: string, file = ''): ParsedFile {
  const doc = parser.parse(xml) as XmlNode
  const suites: ParsedSuite[] = []

  const root =
    doc['test-run'] !== undefined
      ? doc['test-run']
      : doc['test-results'] !== undefined
        ? doc['test-results']
        : doc['test-suite']

  for (const node of asNodes(root)) {
    collectLeafSuites(node, file, [], suites)
  }

  return { file, suites }
}

/** Sniff for an NUnit root element. Conservative and side-effect free. */
export function isNUnit (xml: string): boolean {
  return /<\s*test-(run|results|suite)[\s/>]/.test(xml)
}

export const nunit: FormatParser = {
  name: 'NUnit',
  detect: (content) => isNUnit(content),
  parse: (content, path) => parseNUnitXml(content, path)
}
