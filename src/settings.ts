import * as core from '@actions/core'
import type { ReportFormat } from './render.js'

export type CommentMode = 'always' | 'off'

export interface Settings {
  token: string
  filesGlobs: string[]
  checkName: string
  commentTitle: string
  format: ReportFormat
  timeFactor: number
  jsonFile: string | undefined
  jobSummary: boolean
  checkRun: boolean
  commentMode: CommentMode
  commit: string
  retries: number
  // conclusion / failure control
  failOnFailures: boolean
  failOnErrors: boolean
  actionFail: boolean
  actionFailOnInconclusive: boolean
  compareEarlier: boolean
}

/** `core.getInput` returns '' when unset; treat '' as "use the fallback". */
function input (name: string, fallback = ''): string {
  const value = core.getInput(name)
  return value !== '' ? value : fallback
}

function boolInput (name: string, fallback: boolean): boolean {
  const value = core.getInput(name).toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function intInput (name: string, fallback: number): number {
  const value = core.getInput(name)
  if (value === '') return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function splitPatterns (value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export function getSettings (): Settings {
  const timeUnit = input('time_unit', 'seconds').toLowerCase()
  const timeFactor = timeUnit === 'milliseconds' ? 0.001 : 1.0

  const format: ReportFormat =
    input('report_format', 'text').toLowerCase() === 'table' ? 'table' : 'text'
  const checkName = input('check_name', 'Test Results')

  // fail_on controls the check-run conclusion. Escalation matches the Python
  // action: failing on test failures also fails on errors.
  const failOn = input('fail_on', 'test failures').toLowerCase()
  const failOnFailures = failOn === 'test failures'
  const failOnErrors = failOn === 'errors' || failOnFailures

  const commentMode: CommentMode =
    input('comment_mode', 'always') === 'off' ? 'off' : 'always'
  const jsonFile = input('json_file')

  return {
    token: input('github_token'),
    filesGlobs: splitPatterns(input('files')),
    checkName,
    commentTitle: input('comment_title', checkName),
    format,
    timeFactor,
    jsonFile: jsonFile !== '' ? jsonFile : undefined,
    jobSummary: boolInput('job_summary', true),
    checkRun: boolInput('check_run', true),
    commentMode,
    commit: input('commit', process.env.GITHUB_SHA ?? ''),
    retries: intInput('github_retries', 10),
    failOnFailures,
    failOnErrors,
    actionFail: boolInput('action_fail', false),
    actionFailOnInconclusive: boolInput('action_fail_on_inconclusive', false),
    compareEarlier: boolInput('compare_to_earlier_commit', true)
  }
}
