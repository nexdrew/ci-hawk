import type { ParsedFile } from './types.js'

/** A GitHub check-run annotation (subset of fields cinct emits). */
export interface Annotation {
  path: string
  start_line: number
  end_line: number
  annotation_level: 'notice' | 'warning' | 'failure'
  message: string
  title?: string
  raw_details?: string
}

// GitHub allows at most 50 annotations per check-run API request.
export const ANNOTATION_BATCH = 50
const MAX_MESSAGE = 64 * 1024
const MAX_TITLE = 255

function truncate (s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * Build one annotation per failing or errored case. Annotations point at the
 * test's result file (line 1) — test result formats rarely carry a source
 * location, so this surfaces the failure on the file the case came from.
 */
export function buildAnnotations (files: ParsedFile[]): Annotation[] {
  const annotations: Annotation[] = []
  for (const file of files) {
    for (const suite of file.suites) {
      for (const c of suite.cases) {
        if (c.result !== 'failure' && c.result !== 'error') continue
        const path = c.resultFile !== undefined && c.resultFile !== ''
          ? c.resultFile
          : file.file
        const titleParts = [c.className, c.testName].filter((p) => p !== '')
        const message = c.message ?? c.content ?? `${c.testName} ${c.result}`
        annotations.push({
          path: path !== '' ? path : 'unknown',
          start_line: 1,
          end_line: 1,
          annotation_level: 'failure',
          message: truncate(message, MAX_MESSAGE),
          title: truncate(titleParts.join(' ▸ '), MAX_TITLE),
          raw_details:
            c.content !== undefined ? truncate(c.content, MAX_MESSAGE) : undefined
        })
      }
    }
  }
  return annotations
}
