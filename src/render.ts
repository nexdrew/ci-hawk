import { encodeDigestLine } from './digest.js'
import type { RunResults } from './types.js'

export type ReportFormat = 'text' | 'table'

const LABELS = {
  tests: 'tests',
  passed: '✅ passed',
  skipped: '💤 skipped',
  failed: '❌ failed',
  errors: '🔥 errors'
} as const

function delta (curr: number, prev: number | undefined): string {
  if (prev === undefined) return ''
  const d = curr - prev
  if (d === 0) return ' (±0)'
  return d > 0 ? ` (+${d})` : ` (${d})`
}

function durationStr (seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

/** Single-line, EnricoMi-style summary. */
function renderText (stats: RunResults, prev?: RunResults): string {
  return [
    `**${stats.tests}** ${LABELS.tests}${delta(stats.tests, prev?.tests)}`,
    `${stats.tests_succ} ${LABELS.passed}${delta(stats.tests_succ, prev?.tests_succ)}`,
    `${stats.tests_skip} ${LABELS.skipped}${delta(stats.tests_skip, prev?.tests_skip)}`,
    `${stats.tests_fail} ${LABELS.failed}${delta(stats.tests_fail, prev?.tests_fail)}`,
    `${stats.tests_error} ${LABELS.errors}${delta(stats.tests_error, prev?.tests_error)}`
  ].join(' · ')
}

/** Markdown table summary (per request: a real table instead of "dumb text"). */
function renderTable (stats: RunResults, prev?: RunResults): string {
  const rows: Array<[string, number, number | undefined]> = [
    [LABELS.tests, stats.tests, prev?.tests],
    [LABELS.passed, stats.tests_succ, prev?.tests_succ],
    [LABELS.skipped, stats.tests_skip, prev?.tests_skip],
    [LABELS.failed, stats.tests_fail, prev?.tests_fail],
    [LABELS.errors, stats.tests_error, prev?.tests_error]
  ]
  const hasDelta = prev !== undefined
  const head = hasDelta ? '| | Count | Δ |\n|---|--:|--:|' : '| | Count |\n|---|--:|'
  const body = rows
    .map(([label, curr, p]) => {
      if (!hasDelta) return `| ${label} | ${curr} |`
      // p is always a number here (prev is defined when hasDelta), so delta
      // returns a non-empty " (±N)" string.
      return `| ${label} | ${curr} | ${delta(curr, p).trim()} |`
    })
    .join('\n')
  return `${head}\n${body}`
}

export interface RenderOptions {
  title: string
  format: ReportFormat
  previous?: RunResults
  /** Heading level: 3 (###) for job summary, 2 (##) for PR comments. */
  headingLevel?: 2 | 3
  /** When set, append a "Results for commit <short>." line. */
  commit?: string
  /** When set, append a link to the check run / details. */
  detailsUrl?: string
  /** Hidden HTML marker appended for robust comment identification. */
  marker?: string
}

/**
 * Build the full markdown body for a check run / PR comment, including the
 * hidden digest marker line that the next run reads to compute deltas.
 * The presentation above the marker is fully configurable; the marker is not.
 */
export function renderReport (stats: RunResults, opts: RenderOptions): string {
  const summary =
    opts.format === 'table'
      ? renderTable(stats, opts.previous)
      : renderText(stats, opts.previous)

  const meta = `${stats.runs} runs in ${durationStr(stats.duration)} across ${stats.suites} suites`
  const heading = '#'.repeat(opts.headingLevel ?? 3)

  const lines = [`${heading} ${opts.title}`, '', summary, '', `_${meta}._`]

  if (opts.commit !== undefined && opts.commit !== '') {
    lines.push('', `Results for commit ${opts.commit.slice(0, 8)}.`)
  }
  if (opts.detailsUrl !== undefined && opts.detailsUrl !== '') {
    lines.push('', `[View details](${opts.detailsUrl})`)
  }

  lines.push('', encodeDigestLine(stats))
  if (opts.marker !== undefined && opts.marker !== '') lines.push(opts.marker)

  return lines.join('\n')
}
