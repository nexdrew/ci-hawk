import type { RunResults } from './types.js'

export type Conclusion = 'success' | 'failure' | 'neutral'

export interface ConclusionOptions {
  failOnFailures: boolean
  failOnErrors: boolean
  /** Number of files that failed to parse (counts as errors). */
  parseErrors?: number
}

/**
 * Derive the check-run conclusion, mirroring `get_conclusion` in the Python
 * action: no files -> neutral; failure when the relevant fail_on thresholds are
 * crossed; otherwise success. Uses run-level (not deduplicated) counts.
 */
export function getConclusion (
  stats: RunResults,
  opts: ConclusionOptions
): Conclusion {
  if (stats.files === 0) return 'neutral'

  const parseErrors = opts.parseErrors ?? 0
  if (opts.failOnErrors && parseErrors > 0) return 'failure'
  if (
    (opts.failOnFailures && stats.runs_fail > 0) ||
    (opts.failOnErrors && stats.runs_error > 0)
  ) {
    return 'failure'
  }
  return 'success'
}

/** Whether the action step itself should fail (vs. just reporting). */
export function actionFailRequired (
  conclusion: Conclusion,
  actionFail: boolean,
  actionFailOnInconclusive: boolean
): boolean {
  return (
    (actionFail && conclusion === 'failure') ||
    (actionFailOnInconclusive && conclusion === 'neutral')
  )
}
