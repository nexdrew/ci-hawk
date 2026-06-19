import type { Octokit } from './github.js'

/** Hidden marker used to find a comment cinct previously posted on a PR. */
export const COMMENT_MARKER = '<!-- cinct:test-results -->'

async function findCommentId (
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<number | undefined> {
  const iterator = octokit.paginate.iterator(
    octokit.rest.issues.listComments,
    { owner, repo, issue_number: issueNumber, per_page: 100 }
  )
  // Track the latest marker comment so re-runs converge on one comment even if
  // duplicates ever exist (listComments is returned oldest-first).
  let latest: number | undefined
  for await (const { data } of iterator) {
    for (const comment of data) {
      const body = comment.body
      if (typeof body === 'string' && body.includes(COMMENT_MARKER)) {
        latest = comment.id
      }
    }
  }
  return latest
}

/**
 * Create a cinct comment on the issue/PR, or edit the existing one (identified
 * by COMMENT_MARKER) so re-runs update in place rather than piling up.
 */
export async function upsertComment (
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const existingId = await findCommentId(octokit, owner, repo, issueNumber)
  if (existingId !== undefined) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body
    })
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body
    })
  }
}
