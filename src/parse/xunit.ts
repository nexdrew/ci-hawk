import { XMLParser } from 'fast-xml-parser'
import type {
  FormatParser,
  ParsedFile,
  ParsedSuite,
  TestCase
} from '../types.js'

/**
 * xUnit (v2 `<assemblies>` format) → parsed test model.
 *
 * This is a direct port of `python/publish/xslt/xunit-to-junit.xslt` from the
 * EnricoMi action. The XSLT maps:
 *   assembly          -> outer testsuite (grouping only)
 *   collection | class -> leaf testsuite
 *   test              -> testcase  (name=@method, classname=@type, time=@time)
 *   test/reason       -> <skipped message="reason text">
 *   test/failure      -> <failure type=@exception-type message=message-text>
 *                          (body = message text + stack-trace text, concatenated)
 *
 * We emit the parsed model directly rather than round-tripping through a JUnit
 * XML string, but the semantics (and therefore the resulting stats) are
 * identical to running the stylesheet and then the JUnit parser.
 */

const ARRAY_TAGS = new Set([
  'assembly',
  'collection',
  'class',
  'test',
  'failure'
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // CDATA in <message>/<stack-trace>/<reason> must be preserved verbatim
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
  // Unreachable: parser is configured with parseAttributeValue:false and
  // parseTagValue:false, so every scalar is already a string (the cases above
  // cover undefined/null, object, and string). These arms remain as defensive
  // coercion only.
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
  // Unreachable: asNodes only returns a non-empty array for a real array value
  // (returned verbatim) or by wrapping a non-null object as [obj]; neither path
  // yields a null/undefined first element for these XML tags. Defensive only.
  /* c8 ignore next */
  if (node == null) return ''
  return `${scalar(node['#text'])}${scalar(node['#cdata'])}`
}

function toCase (test: XmlNode, file: string): TestCase {
  const className = attr(test, 'type') ?? ''
  const testName = attr(test, 'method') ?? ''
  const time = num(attr(test, 'time'))

  const failure = asNodes(test.failure)[0]
  if (failure !== undefined) {
    const message = elemText(failure.message)
    const stack = elemText(failure['stack-trace'])
    return {
      className,
      testName,
      resultFile: file,
      time,
      result: 'failure',
      message,
      content: `${message}${stack}`
    }
  }

  if (test.reason !== undefined) {
    return {
      className,
      testName,
      resultFile: file,
      time,
      result: 'skipped',
      message: elemText(test.reason)
    }
  }

  return { className, testName, resultFile: file, time, result: 'success' }
}

export function isXUnit (xml: string): boolean {
  // root element is <assemblies> (xUnit v2) — cheap sniff before full parse
  return /<\s*assemblies[\s>]/.test(xml)
}

export function parseXUnitXml (xml: string, file = ''): ParsedFile {
  const doc = parser.parse(xml) as XmlNode
  const suites: ParsedSuite[] = []

  const assemblies =
    doc.assemblies !== undefined
      ? asNodes((doc.assemblies as XmlNode).assembly)
      : asNodes(doc.assembly)

  for (const assembly of assemblies) {
    const groups = [
      ...asNodes(assembly.collection),
      ...asNodes(assembly.class)
    ]
    for (const group of groups) {
      const tests = asNodes(group.test)
      suites.push({
        name: attr(group, 'name') ?? '',
        cases: tests.map((t) => toCase(t, file))
      })
    }
  }

  return { file, suites }
}

export const xunit: FormatParser = {
  name: 'xUnit',
  detect: (content) => isXUnit(content),
  parse: (content, path) => parseXUnitXml(content, path)
}
