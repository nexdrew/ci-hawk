import type { FormatParser, ParsedFile, TestCase } from '../types.js'

/**
 * TAP (Test Anything Protocol), versions 13/14 → parsed test model.
 *
 * This is what `bun test --reporter=tap` and node-tap emit. There is no
 * reference stylesheet in the EnricoMi action; this is implemented from the
 * TAP spec (https://testanything.org/tap-version-14-specification.html).
 *
 * Mapping decisions (documented for fidelity):
 *   - "ok N - desc"     -> result 'success'
 *   - "not ok N - desc" -> result 'failure'
 *   - "# SKIP <reason>" directive (case-insensitive) -> 'skipped',
 *     message = reason. A skipped point is skipped regardless of ok/not ok.
 *   - "# TODO <reason>" directive -> 'skipped'. TODO is a "not yet done" marker;
 *     a failing TODO is an expected failure (not a real failure) and a passing
 *     TODO is a bonus pass, so neither should count as a failure. We map both to
 *     'skipped' so they don't inflate the failure count. (Documented choice.)
 *   - className: TAP has no class concept -> '' (empty).
 *   - testName: the description text, with a leading "- " stripped.
 *   - time: TAP has no per-test time -> null.
 *
 * YAML diagnostic block: an indented block delimited by "---" and "..." that
 * follows a test point. We capture the raw block text as `content`, and if the
 * block contains a top-level "message:" key we surface its value as `message`.
 *
 * Subtests: TAP 14 allows indented nested subtests, each with its own plan and
 * points, summarised by a parent point. We flatten: only the top-level (least
 * indented) test points become cases; deeper-indented "ok"/"not ok" lines that
 * belong to a subtest are ignored, and the parent summary point is kept. This
 * keeps counts aligned with the declared top-level plan. (Documented choice.)
 */

interface TapPoint {
  ok: boolean
  description: string
  directive?: { type: 'skip' | 'todo', reason: string }
}

const VERSION_RE = /^\s*TAP\s+version\s+\d+\s*$/i
const PLAN_RE = /^\s*\d+\.\.\d+/
const POINT_RE = /^(\s*)(not\s+ok|ok)\b(.*)$/i
const DIRECTIVE_RE = /^\s*(skip|todo)\b\s*(.*)$/i

/** Leading-whitespace width of a line (tabs counted as one column each). */
function indentOf (line: string): number {
  const m = /^(\s*)/.exec(line)
  // /^(\s*)/ always matches with group 1 present; the fallback is unreachable.
  /* c8 ignore next */
  return m?.[1]?.length ?? 0
}

/**
 * Split a description at the first UNescaped '#'. Per the TAP spec the '#'
 * introduces the directive/comment section; a literal '#' inside a description
 * must be escaped as '\#'. Returns [description, commentSection|undefined].
 */
function splitOnUnescapedHash (s: string): [string, string | undefined] {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || s[i - 1] !== '\\')) {
      return [s.slice(0, i), s.slice(i + 1)]
    }
  }
  return [s, undefined]
}

/** Unescape TAP description escapes: '\#' -> '#', '\\' -> '\'. */
function unescape (s: string): string {
  return s.replace(/\\([\\#])/g, '$1')
}

/** Strip a leading point number and optional "- ", then unescape. */
function cleanDescription (raw: string): string {
  // raw is the description portion after "ok"/"not ok": e.g. " 1 - does a thing"
  let s = raw.trim()
  const numMatch = /^\d+\s*/.exec(s)
  // A successful exec always has match[0]; the ?? 0 fallback is unreachable.
  /* c8 ignore next */
  if (numMatch !== null) s = s.slice(numMatch[0]?.length ?? 0)
  if (s.startsWith('-')) s = s.slice(1).trimStart()
  return unescape(s.trim())
}

function parsePoint (line: string): TapPoint | undefined {
  const m = POINT_RE.exec(line)
  if (m === null) return undefined
  // POINT_RE captures groups 2 (ok|not ok) and 3 (.*) on every match; the
  // ?? '' fallbacks below are unreachable defensive guards.
  /* c8 ignore next */
  const ok = !/not/i.test(m[2] ?? '')

  // The description ends at the first unescaped '#'; anything after is a
  // directive (SKIP/TODO) or a plain comment. This prevents a description that
  // legitimately contains an escaped '\#' from being treated as a directive.
  /* c8 ignore next */
  const [descPart, comment] = splitOnUnescapedHash(m[3] ?? '')

  let directive: TapPoint['directive']
  if (comment !== undefined) {
    const dm = DIRECTIVE_RE.exec(comment)
    if (dm !== null) {
      // DIRECTIVE_RE captures group 1 (skip|todo) and group 2 (.*) on every
      // match; the ?? '' fallbacks are unreachable defensive guards.
      /* c8 ignore next 2 */
      const type = (dm[1] ?? '').toLowerCase() === 'skip' ? 'skip' : 'todo'
      directive = { type, reason: (dm[2] ?? '').trim() }
    }
    // otherwise it is a plain comment and is ignored (status stays ok/not ok)
  }

  return { ok, description: cleanDescription(descPart), directive }
}

/** Extract a top-level "message:" value from a captured YAML block. */
function messageFromYaml (block: string): string | undefined {
  for (const line of block.split('\n')) {
    const m = /^\s*message\s*:\s*(.*)$/.exec(line)
    if (m !== null) {
      // group 1 is (.*) so always present; the ?? '' fallback is unreachable.
      /* c8 ignore next */
      let v = (m[1] ?? '').trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      return v
    }
  }
  return undefined
}

function toCase (
  point: TapPoint,
  file: string,
  yaml: string | undefined
): TestCase {
  const base = {
    className: '',
    testName: point.description,
    resultFile: file,
    time: null
  }

  if (point.directive !== undefined) {
    const reason = point.directive.reason
    return {
      ...base,
      result: 'skipped',
      message: reason !== '' ? reason : undefined,
      content: yaml
    }
  }

  if (!point.ok) {
    const message = yaml !== undefined ? messageFromYaml(yaml) : undefined
    return {
      ...base,
      result: 'failure',
      message,
      content: yaml
    }
  }

  return { ...base, result: 'success', content: yaml }
}

export function parseTap (content: string, file = ''): ParsedFile {
  const lines = content.split(/\r?\n/)

  // Determine the indent level of the top-level test points. Subtests are more
  // deeply indented; we only emit cases at the minimum point indent.
  let topIndent: number | undefined
  for (const line of lines) {
    if (POINT_RE.test(line)) {
      const ind = indentOf(line)
      if (topIndent === undefined || ind < topIndent) topIndent = ind
    }
  }

  const cases: TestCase[] = []
  for (let i = 0; i < lines.length; i++) {
    // i is bounded by lines.length, so lines[i] is always defined here.
    /* c8 ignore next */
    const line = lines[i] ?? ''
    const point = parsePoint(line)
    if (point === undefined) continue
    // skip deeper-indented subtest points; only flatten top-level points
    if (topIndent !== undefined && indentOf(line) > topIndent) continue

    // Look ahead for an immediately-following YAML diagnostic block, which is
    // indented more than the point line and delimited by "---" / "...".
    let yaml: string | undefined
    const pointIndent = indentOf(line)
    let j = i + 1
    const open = lines[j] ?? ''
    if (j < lines.length && indentOf(open) > pointIndent && open.trim() === '---') {
      const blockLines: string[] = []
      j++
      // Both accesses are guarded by j < lines.length, so lines[j] is always
      // defined; the ?? '' fallbacks are unreachable defensive guards.
      /* c8 ignore next 3 */
      while (j < lines.length && (lines[j] ?? '').trim() !== '...') {
        blockLines.push(lines[j] ?? '')
        j++
      }
      yaml = blockLines.join('\n')
      i = j // consume through the closing "..." line
    }

    cases.push(toCase(point, file, yaml))
  }

  // A single flat suite: TAP has no suite/class grouping.
  return { file, suites: [{ name: '', cases }] }
}

/**
 * Conservative content/path sniff. We require either a "TAP version N" header
 * or a TAP plan ("1..N") combined with at least one "ok"/"not ok" point. This
 * avoids matching unrelated text files. Side-effect free; never throws.
 */
export function isTap (content: string, path = ''): boolean {
  const lines = content.split(/\r?\n/, 200)
  let hasVersion = false
  let hasPlan = false
  let hasPoint = false
  for (const line of lines) {
    if (VERSION_RE.test(line)) hasVersion = true
    if (PLAN_RE.test(line)) hasPlan = true
    if (POINT_RE.test(line)) hasPoint = true
  }
  if (hasVersion && (hasPlan || hasPoint)) return true
  if (hasPlan && hasPoint) return true
  if (/\.tap$/i.test(path) && hasPoint) return true
  return false
}

export const tap: FormatParser = {
  name: 'TAP',
  detect: (content, path) => isTap(content, path),
  parse: (content, path) => parseTap(content, path)
}
