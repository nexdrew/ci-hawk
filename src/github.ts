import * as core from '@actions/core'
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'

const CinctOctokit = GitHub.plugin(retry, throttling)

/** The Octokit instance type used throughout cinct (with retry + throttling). */
export type Octokit = InstanceType<typeof CinctOctokit>

interface ThrottleOptions {
  method: string
  url: string
}

/**
 * Build an Octokit client that retries transient failures and backs off on
 * primary and secondary rate limits, mirroring the throttling the Python action
 * gets from PyGithub. `retries` bounds both retry mechanisms.
 */
export function buildOctokit (token: string, retries: number): Octokit {
  return new CinctOctokit(
    getOctokitOptions(token, {
      retry: { retries },
      throttle: {
        onRateLimit: (
          retryAfter: number,
          options: ThrottleOptions,
          _octokit: unknown,
          retryCount: number
        ): boolean => {
          core.warning(
            `Request quota exhausted for ${options.method} ${options.url}; ` +
              `retrying after ${retryAfter}s (attempt ${retryCount + 1}/${retries})`
          )
          return retryCount < retries
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: ThrottleOptions,
          _octokit: unknown,
          retryCount: number
        ): boolean => {
          core.warning(
            `Secondary rate limit hit for ${options.method} ${options.url}; ` +
              `retrying after ${retryAfter}s (attempt ${retryCount + 1}/${retries})`
          )
          return retryCount < retries
        }
      }
    })
  )
}
