import type { FormatParser, ParsedFile } from '../types.js'
import { junit } from './junit.js'
import { xunit } from './xunit.js'
import { nunit } from './nunit.js'
import { trx } from './trx.js'
import { tap } from './tap.js'
import { dart } from './dart.js'
import { mocha } from './mocha.js'

/**
 * Registered parsers in priority order. More specific formats come first;
 * JUnit is the general XML fallback and must stay last among the XML parsers.
 * Add a new format by appending its FormatParser here.
 *
 * Detection is mutually exclusive in practice: dart/mocha key off distinct JSON
 * shapes, tap off TAP markers, and the XML parsers off their root elements
 * (assemblies / TestRun / test-run|test-results|test-suite / testsuites).
 */
export const PARSERS: FormatParser[] = [
  dart,
  mocha,
  tap,
  xunit,
  nunit,
  trx,
  junit
]

/** Detect the format of one file's content and parse it, or throw if unknown. */
export function parseContent (content: string, path: string): ParsedFile {
  for (const parser of PARSERS) {
    if (parser.detect(content, path)) return parser.parse(content, path)
  }
  throw new Error(`Unsupported test result format: ${path}`)
}
