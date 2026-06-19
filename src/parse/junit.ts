import { XMLParser } from 'fast-xml-parser'
import type {
  CaseResult,
  FormatParser,
  ParsedFile,
  ParsedSuite,
  TestCase
} from '../types.js'

const ARRAY_TAGS = new Set([
  'testsuite',
  'testcase',
  'failure',
  'error',
  'skipped'
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // keep raw strings; we coerce numbers ourselves to control rounding
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
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

function text (node: XmlNode): string | undefined {
  const t = node['#text']
  return t === undefined || t === null ? undefined : String(t)
}

function caseResult (tc: XmlNode): {
  result: CaseResult
  message?: string
  content?: string
} {
  // precedence matches the Python action: error > failure > skipped > success
  for (const [tag, result] of [
    ['error', 'error'],
    ['failure', 'failure'],
    ['skipped', 'skipped']
  ] as const) {
    const first = asNodes(tc[tag])[0]
    if (first !== undefined) {
      return { result, message: attr(first, 'message'), content: text(first) }
    }
  }
  return { result: 'success' }
}

function toCase (tc: XmlNode, file: string): TestCase {
  const { result, message, content } = caseResult(tc)
  return {
    className: attr(tc, 'classname') ?? '',
    testName: attr(tc, 'name') ?? '',
    resultFile: file,
    time: num(attr(tc, 'time')),
    result,
    message,
    content
  }
}

/** Recursively collect leaf <testsuite> elements (those holding <testcase>s). */
function collectLeafSuites (
  node: XmlNode,
  file: string,
  out: ParsedSuite[]
): void {
  const childSuites = asNodes(node.testsuite)
  const cases = asNodes(node.testcase)

  if (cases.length > 0) {
    out.push({
      name: attr(node, 'name') ?? '',
      cases: cases.map((tc) => toCase(tc, file))
    })
  }
  for (const child of childSuites) collectLeafSuites(child, file, out)
}

/** Parse a JUnit XML string into a flat list of leaf suites with their cases. */
export function parseJUnitXml (xml: string, file = ''): ParsedFile {
  const doc = parser.parse(xml) as XmlNode
  const suites: ParsedSuite[] = []

  const roots =
    doc.testsuites !== undefined
      ? asNodes(doc.testsuites)
      : asNodes(doc.testsuite)
  for (const root of roots) collectLeafSuites(root, file, suites)

  return { file, suites }
}

/** Sniff for a JUnit root element. JUnit is the general XML fallback. */
export function isJUnit (xml: string): boolean {
  return /<\s*testsuites?[\s/>]/.test(xml)
}

export const junit: FormatParser = {
  name: 'JUnit',
  detect: (content) => isJUnit(content),
  parse: (content, path) => parseJUnitXml(content, path)
}
