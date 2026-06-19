import { readFile, glob } from 'node:fs/promises'
import { parseContent } from './parse/registry.js'
import type { ParseError, ParsedFile } from './types.js'

/** Expand glob patterns (relative to cwd) into a sorted, de-duplicated list. */
export async function expandFiles (patterns: string[]): Promise<string[]> {
  const found = new Set<string>()
  for (const pattern of patterns) {
    for await (const entry of glob(pattern)) found.add(entry)
  }
  return [...found].sort()
}

export interface ParseOutcome {
  files: ParsedFile[]
  errors: ParseError[]
}

/**
 * Read and parse each path. A file that cannot be read or whose format is not
 * recognised becomes a ParseError rather than throwing — this keeps an advisory
 * step (e.g. `if: always()` with fail_on: nothing) green when a single result
 * file is missing or malformed. Parse errors are surfaced and can still drive
 * the conclusion via fail_on.
 */
export async function parseFiles (paths: string[]): Promise<ParseOutcome> {
  const files: ParsedFile[] = []
  const errors: ParseError[] = []
  for (const path of paths) {
    try {
      files.push(parseContent(await readFile(path, 'utf8'), path))
    } catch (err) {
      errors.push({
        file: path,
        // readFile and parseContent only throw Error instances, so the
        // String(err) fallback is defensive and unreachable in practice.
        /* c8 ignore next */
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { files, errors }
}
