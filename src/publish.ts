import * as core from '@actions/core'
import * as github from '@actions/github'
import { buildOctokit, type Octokit } from './github.js'
import { decodeDigest, findDigestLine } from './digest.js'
import { renderReport } from './render.js'
import { buildAnnotations, ANNOTATION_BATCH } from './annotations.js'
import { upsertComment, COMMENT_MARKER } from './comment.js'
import type { Conclusion } from './conclusion.js'
import type { Settings } from './settings.js'
import type { ParsedFile, RunResults } from './types.js'

interface PullRef {
  number: number
  baseRef: string
  baseRepo: string
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target'])

/** Safe nested property access over loosely-typed webhook payloads. */
function getPath (obj: unknown, ...keys: string[]): unknown {
  let cur = obj
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * The commit results are published to. An explicit `commit` input wins;
 * otherwise on pull_request events use the PR head SHA — GITHUB_SHA there is the
 * synthetic merge commit, which GitHub does not surface on the PR and which
 * isn't associated with the PR for comment lookup. All other events use
 * GITHUB_SHA / context.sha.
 */
export function resolveCommit (explicit: string): string {
  if (explicit !== '') return explicit
  if (PR_EVENTS.has(github.context.eventName)) {
    const head = getPath(github.context.payload, 'pull_request', 'head', 'sha')
    if (typeof head === 'string' && head !== '') return head
  }
  return github.context.sha
}

/** The pull request from the triggering event payload, if present. */
function pullFromEvent (): PullRef | undefined {
  const pr = getPath(github.context.payload, 'pull_request')
  const number = getPath(pr, 'number')
  const baseRef = getPath(pr, 'base', 'ref')
  const baseRepo = getPath(pr, 'base', 'repo', 'full_name')
  if (
    typeof number === 'number' &&
    typeof baseRef === 'string' &&
    typeof baseRepo === 'string'
  ) {
    return { number, baseRef, baseRepo }
  }
  return undefined
}

/**
 * True when running on a `pull_request` event from a fork, where the
 * GITHUB_TOKEN is read-only. Only `pull_request` is affected: on
 * `pull_request_target` and `workflow_run` the token has write access even for
 * fork PRs, so we must NOT skip there.
 */
function isForkPullRequest (fullName: string): boolean {
  if (github.context.eventName !== 'pull_request') return false
  const headRepo = getPath(
    github.context.payload,
    'pull_request',
    'head',
    'repo',
    'full_name'
  )
  return typeof headRepo === 'string' && headRepo !== fullName
}

/**
 * Resolve the merge-base between a PR's base branch and the current commit.
 * EnricoMi compares against the merge-base (not pull.base.sha, which is the
 * mutable tip of the base branch) so deltas reflect the PR's own changes.
 */
async function mergeBaseSha (
  octokit: Octokit,
  owner: string,
  repo: string,
  baseRef: string,
  sha: string
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseRef}...${sha}`
    })
    return data.merge_base_commit.sha
  } catch (err) {
    core.debug(`Could not compute merge base ${baseRef}...${sha}: ${String(err)}`)
    return undefined
  }
}

/** Read the stats digest from the named check run on a commit, if present. */
async function readCommitDigest (
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  checkName: string
): Promise<RunResults | undefined> {
  try {
    const { data } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref,
      check_name: checkName,
      per_page: 1
    })
    const summary = data.check_runs[0]?.output?.summary ?? ''
    const line = findDigestLine(summary)
    return line !== undefined ? decodeDigest(line) : undefined
  } catch (err) {
    core.debug(`Could not read digest for ${ref}: ${String(err)}`)
    return undefined
  }
}

async function publishCheckRun (
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  settings: Settings,
  stats: RunResults,
  conclusion: Conclusion,
  previous: RunResults | undefined,
  parsed: ParsedFile[]
): Promise<void> {
  const body = renderReport(stats, {
    title: settings.checkName,
    format: settings.format,
    previous,
    commit: sha,
    headingLevel: 3
  })
  const annotations = buildAnnotations(parsed)
  try {
    const { data: created } = await octokit.rest.checks.create({
      owner,
      repo,
      name: settings.checkName,
      head_sha: sha,
      status: 'completed',
      conclusion,
      output: {
        title: settings.checkName,
        summary: body,
        annotations: annotations.slice(0, ANNOTATION_BATCH)
      }
    })
    // GitHub accepts at most 50 annotations per request; add the rest via update
    for (let i = ANNOTATION_BATCH; i < annotations.length; i += ANNOTATION_BATCH) {
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: created.id,
        output: {
          title: settings.checkName,
          summary: body,
          annotations: annotations.slice(i, i + ANNOTATION_BATCH)
        }
      })
    }
    core.info(
      `Published check run "${settings.checkName}" (${annotations.length} annotation(s))`
    )
  } catch (err) {
    core.warning(`Failed to publish check run: ${String(err)}`)
  }
}

async function pullsForCommit (
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string
): Promise<PullRef[]> {
  try {
    const data = await octokit.paginate(
      octokit.rest.repos.listPullRequestsAssociatedWithCommit,
      { owner, repo, commit_sha: sha, per_page: 100 }
    )
    return data.map((p) => ({
      number: p.number,
      baseRef: p.base.ref,
      baseRepo: p.base.repo.full_name
    }))
  } catch (err) {
    core.warning(`Could not list pull requests for ${sha}: ${String(err)}`)
    return []
  }
}

async function publishComments (
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  settings: Settings,
  stats: RunResults
): Promise<void> {
  const fullName = `${owner}/${repo}`
  // Prefer the PR from the triggering event payload (reliable on pull_request
  // events, where the commit-association lookup misses the merge commit); fall
  // back to commit association for push / workflow_run.
  const eventPull = pullFromEvent()
  const pulls = (
    eventPull !== undefined ? [eventPull] : await pullsForCommit(octokit, owner, repo, sha)
  ).filter((p) => p.baseRepo === fullName)
  if (pulls.length === 0) {
    core.info(`No pull request found for commit ${sha}`)
    return
  }

  for (const pull of pulls) {
    // Compare against the merge-base, skipping when it resolves to the commit
    // itself (e.g. first commit on a branch) to avoid a zero-delta overwrite.
    let baseStats: RunResults | undefined
    if (settings.compareEarlier) {
      const baseSha = await mergeBaseSha(octokit, owner, repo, pull.baseRef, sha)
      if (baseSha !== undefined && baseSha !== sha) {
        baseStats = await readCommitDigest(
          octokit,
          owner,
          repo,
          baseSha,
          settings.checkName
        )
      }
    }
    const body = renderReport(stats, {
      title: settings.commentTitle,
      format: settings.format,
      previous: baseStats,
      commit: sha,
      headingLevel: 2,
      marker: COMMENT_MARKER
    })
    try {
      await upsertComment(octokit, owner, repo, pull.number, body)
      core.info(`Commented on PR #${pull.number}`)
    } catch (err) {
      core.warning(`Failed to comment on PR #${pull.number}: ${String(err)}`)
    }
  }
}

/**
 * Publish the report to GitHub (check run + PR comments with earlier-commit
 * deltas) and return the previous run's stats on this commit for job-summary
 * deltas. Falls back to local-only (returns undefined) with no token/context,
 * or on a fork PR where the token cannot write.
 */
export async function publishToGitHub (
  settings: Settings,
  stats: RunResults,
  conclusion: Conclusion,
  parsed: ParsedFile[]
): Promise<RunResults | undefined> {
  if (settings.token === '' || process.env.GITHUB_REPOSITORY === undefined) {
    core.info('No github_token / repository context — skipping API publish.')
    return undefined
  }

  const octokit = buildOctokit(settings.token, settings.retries)
  const { owner, repo } = github.context.repo
  const fullName = `${owner}/${repo}`
  const sha = resolveCommit(settings.commit)

  if (isForkPullRequest(fullName)) {
    core.warning(
      'Pull request from a fork: the GITHUB_TOKEN cannot create check runs or ' +
        'comments, so only the job summary is produced. See the README section ' +
        'on fork support.'
    )
    return undefined
  }

  // previous stats on this same commit (for re-run deltas in the check run)
  const previous = await readCommitDigest(
    octokit,
    owner,
    repo,
    sha,
    settings.checkName
  )

  if (settings.checkRun) {
    await publishCheckRun(
      octokit,
      owner,
      repo,
      sha,
      settings,
      stats,
      conclusion,
      previous,
      parsed
    )
  }

  if (settings.commentMode !== 'off') {
    await publishComments(octokit, owner, repo, sha, settings, stats)
  }

  return previous
}
