import { writeFile } from 'node:fs/promises'
import * as core from '@actions/core'
import { getSettings } from './settings.js'
import { expandFiles, parseFiles } from './collect.js'
import { aggregate } from './results.js'
import { getConclusion, actionFailRequired } from './conclusion.js'
import { renderReport } from './render.js'
import { publishToGitHub } from './publish.js'

export async function run (): Promise<void> {
  const settings = getSettings()

  const paths = await expandFiles(settings.filesGlobs)
  if (paths.length === 0) {
    const patterns =
      settings.filesGlobs.length > 0
        ? settings.filesGlobs.join(', ')
        : '(none provided)'
    core.warning(`No test result files matched: ${patterns}`)
  }
  core.info(`Found ${paths.length} test result file(s)`)

  const { files: parsed, errors: parseErrors } = await parseFiles(paths)
  for (const e of parseErrors) {
    core.warning(`Failed to read/parse ${e.file}: ${e.message}`)
  }

  const stats = aggregate(parsed, {
    commit: settings.commit,
    timeFactor: settings.timeFactor
  })

  core.info(
    `${stats.tests} tests (${stats.runs} runs): ` +
      `${stats.tests_succ} passed, ${stats.tests_skip} skipped, ` +
      `${stats.tests_fail} failed, ${stats.tests_error} errors`
  )

  const conclusion = getConclusion(stats, {
    failOnFailures: settings.failOnFailures,
    failOnErrors: settings.failOnErrors,
    parseErrors: parseErrors.length
  })

  // JSON output + optional file
  const json = JSON.stringify(stats)
  core.setOutput('json', json)
  if (settings.jsonFile !== undefined) {
    await writeFile(settings.jsonFile, json, 'utf8')
  }

  // GitHub publishing reads the previous digest (for deltas) and writes the
  // report as a check run / PR comment. Falls back to local-only when there is
  // no token (e.g. running outside Actions).
  const previous = await publishToGitHub(settings, stats, conclusion, parsed)

  // Job summary (always available, no API needed)
  if (settings.jobSummary) {
    const body = renderReport(stats, {
      title: settings.checkName,
      format: settings.format,
      previous
    })
    await core.summary.addRaw(body).write()
  }

  if (
    actionFailRequired(
      conclusion,
      settings.actionFail,
      settings.actionFailOnInconclusive
    )
  ) {
    const status = conclusion === 'neutral' ? 'inconclusive' : conclusion
    core.setFailed(`Test results have status ${status}.`)
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
