import { gzipSync, gunzipSync } from 'node:zlib'
import type { RunResults } from './types.js'

/**
 * Marker line embedded in the check-run summary / PR comment that carries the
 * gzip+base64 digest of the run stats. Identical to the Python action's
 * `digest_header` so deltas interoperate across both implementations:
 *   digest_prefix + mime + ';' + encoding + ','
 */
export const DIGEST_HEADER = '[test-results]:data:application/gzip;base64,'

/**
 * Field order and JSON formatting must match Python's
 * `json.dumps(UnitTestRunResults.to_dict() minus 'errors')` so that the
 * compressed bytes are byte-for-byte compatible. `to_dict` excludes `errors`
 * and `suite_details` and drops null values; the remaining fields serialize in
 * dataclass declaration order with `", "` / `": "` separators.
 */
const DIGEST_FIELDS = [
  'files',
  'suites',
  'duration',
  'tests',
  'tests_succ',
  'tests_skip',
  'tests_fail',
  'tests_error',
  'runs',
  'runs_succ',
  'runs_skip',
  'runs_fail',
  'runs_error',
  'commit'
] as const satisfies ReadonlyArray<keyof RunResults>

/** Serialize stats exactly like Python's default `json.dumps` (spaces, order). */
export function serializeStats (stats: RunResults): string {
  const parts = DIGEST_FIELDS.map(
    (key) => `${JSON.stringify(key)}: ${JSON.stringify(stats[key])}`
  )
  return `{${parts.join(', ')}}`
}

/**
 * Encode stats into a digest string (without the header).
 *
 * Note: the gzip bytes are NOT identical to the Python action's (CPython's and
 * Node's zlib builds emit different—but mutually decodable—DEFLATE streams).
 * That's fine: nothing compares raw digest strings across implementations. The
 * guarantees that matter are that each side can decode the other's digest and
 * that our JSON payload is byte-identical (see serializeStats).
 */
export function encodeDigest (stats: RunResults): string {
  const json = serializeStats(stats)
  return gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64')
}

/** Encode stats into the full embeddable marker line. */
export function encodeDigestLine (stats: RunResults): string {
  return `${DIGEST_HEADER}${encodeDigest(stats)}`
}

/** Decode a digest (with or without header / surrounding whitespace) to stats. */
export function decodeDigest (digest: string): RunResults {
  let payload = digest.trim()
  const headerIdx = payload.indexOf(DIGEST_HEADER)
  if (headerIdx >= 0) payload = payload.slice(headerIdx + DIGEST_HEADER.length)
  // tolerate the MIME newlines Python's base64.encodebytes would have produced
  payload = payload.replace(/\s+/g, '')

  const json = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8')
  const raw = JSON.parse(json) as Partial<Record<keyof RunResults, unknown>>

  const int = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return {
    files: int(raw.files),
    suites: int(raw.suites),
    duration: int(raw.duration),
    tests: int(raw.tests),
    tests_succ: int(raw.tests_succ),
    tests_skip: int(raw.tests_skip),
    tests_fail: int(raw.tests_fail),
    tests_error: int(raw.tests_error),
    runs: int(raw.runs),
    runs_succ: int(raw.runs_succ),
    runs_skip: int(raw.runs_skip),
    runs_fail: int(raw.runs_fail),
    runs_error: int(raw.runs_error),
    commit: typeof raw.commit === 'string' ? raw.commit : ''
  }
}

/** Extract a digest embedded anywhere in a check-run summary / comment body. */
export function findDigestLine (body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    if (line.includes(DIGEST_HEADER)) return line.trim()
  }
  return undefined
}
