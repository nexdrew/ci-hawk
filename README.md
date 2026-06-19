# `nexdrew/cinct`

**Fast, native, cross-platform test result reporter for CI — especially on Windows.**

`cinct` (succinct + CI) is a GitHub Action that collects your test result files
and publishes a **test report** — a check run, a PR comment, and a job summary —
with cross-commit deltas. It speaks the common CI formats (**JUnit**, **xUnit**,
**NUnit**, **TRX**, **TAP**, Dart JSON, Mocha JSON) and is wire-compatible with
the well-known Python action it was inspired by.

It's a native Node 24 action. There is **no Python, no virtualenv, no `pip
install`, no Docker pull** — so it starts in well under a second on every runner,
including Windows, where Python-based reporters spend roughly a minute just
bootstrapping their interpreter before doing any work.

> Status: **pre-1.0.** All parsers, stats, digest, rendering, and GitHub
> publishing (check run, PR comment, annotations, deltas, fork handling) are
> implemented. A floating `v1` tag will be published once test coverage reaches
> 100% with green CI. Until then, pin a commit SHA or an exact tag. See
> [Roadmap](#roadmap).

## Why

| | Python-based reporters | `cinct` |
|---|---|---|
| Runtime setup on Windows | venv + `pip install` (~minute) | none (Node preinstalled) |
| Distribution | composite + Python, or Docker (Linux only) | single `node24` action |
| Cold start | tens of seconds | < 1s |
| Cross-platform | setup cost per-OS | uniform |

If all you want is to **collect and publish test results**, the work itself
takes about a second. `cinct` keeps it that way.

## Usage

```yaml
- uses: nexdrew/cinct@v1   # @v1 is reserved until 1.0.0 — until then pin a commit SHA
  if: always()             # report results even when tests failed
  with:
    files: |
      **/test-results/**/*.xml
      **/*.trx
    report_format: table   # 'text' (default) or 'table'
```

### Supported formats

`cinct` detects each file's format from its content and parses it:

| Format | Notes |
|---|---|
| **JUnit** XML | `<testsuites>` / `<testsuite>`; the general XML fallback |
| **xUnit** XML | `<assemblies>` (xUnit.net) |
| **NUnit** XML | NUnit 3 `<test-run>` and legacy NUnit 2 `<test-results>` |
| **TRX** | Visual Studio / MSTest `<TestRun>` |
| **TAP** | Test Anything Protocol v13/v14 |
| Dart JSON | `dart test --reporter json` event stream |
| Mocha JSON | Mocha's `json` reporter document |

**Bun:** run `bun test --reporter=junit` to emit JUnit XML, **or**
`bun test --reporter=tap` to emit TAP — both are supported, pick whichever you
prefer. **Node:** `node:test` (and `node --test`) can emit TAP, which `cinct`
parses directly.

### Inputs

Every input is optional. Defaults are shown.

| Input | Default | Description |
|---|---|---|
| `files` | – | Newline-separated glob patterns of test result files |
| `check_name` | `Test Results` | Name of the created check run |
| `comment_title` | = `check_name` | Title for the PR comment |
| `comment_mode` | `always` | `always` or `off` |
| `fail_on` | `test failures` | Check-run conclusion threshold: `test failures` (fail on failures or errors), `errors` (fail only on errors), or `nothing` (always neutral/success). Computed from run-level (non-deduplicated) counts, which may differ from the deduplicated `tests_*` shown in the summary. |
| `action_fail` | `false` | When `true`, the action step itself fails when the conclusion is a failure (per `fail_on`) |
| `action_fail_on_inconclusive` | `false` | When `true`, the action step itself fails when results are inconclusive (no test results) |
| `compare_to_earlier_commit` | `true` | Compare results to an earlier commit to show deltas (`true`/`false`) |
| `report_format` | `text` | Summary presentation: `text` (single line) or `table` (Markdown table) |
| `time_unit` | `seconds` | Time unit in result files: `seconds` or `milliseconds` |
| `commit` | `GITHUB_SHA` | Commit SHA to publish results to |
| `check_run` | `true` | Publish results as a check run (`true`/`false`) |
| `job_summary` | `true` | Publish results to the job summary (`true`/`false`) |
| `json_file` | – | If set, write the run-stats JSON to this path |
| `github_token` | `${{ github.token }}` | Token used to create the check run / comment |
| `github_retries` | `10` | How many times to retry GitHub API requests (rate limits, transient errors) |

### Outputs

| Output | Description |
|---|---|
| `json` | Run statistics as JSON |

## Features

- **Check run** — publishes a `completed` check run on the commit with the
  rendered report as its summary. Controlled by `check_run` and `check_name`.
- **PR comment** — finds the pull request(s) for the commit and posts a comment.
  The comment is **created once, then edited in place** on re-runs (identified by
  a hidden marker), so re-runs update rather than pile up. Controlled by
  `comment_mode` and `comment_title`.
- **Earlier-commit deltas** — when `compare_to_earlier_commit` is `true`, the PR
  comment reads the base commit's digest to show a `Δ` delta column. The check
  run shows deltas against the previous run on the *same* commit (re-runs).
- **Check-run annotations** — failing and erroring tests are surfaced as
  check-run annotations, batched to GitHub's 50-annotations-per-request limit
  (the first batch on create, the rest via update). Each annotation points at
  the result file (line 1), since most test formats carry no source location.
- **Job summary** — writes the same report to the GitHub Actions job summary.
  Controlled by `job_summary`. Always available, even on fork PRs.
- **Configurable report** — `report_format: text` renders a single EnricoMi-style
  line; `report_format: table` renders a real Markdown table (see below).
- **Advisory mode** — `fail_on` controls the check-run *conclusion*
  (`test failures` / `errors` / `nothing`), while `action_fail` decides whether
  the action *step* fails. Leave `action_fail: false` to report results without
  failing the job.
- **Throttling + retry** — the GitHub client uses Octokit's throttling and retry
  plugins to ride out rate limits and transient errors (`github_retries`).
- **Fork handling** — on a pull request from a fork, the `GITHUB_TOKEN` cannot
  create check runs or comments, so `cinct` produces **only the job summary** and
  skips the API writes (no failed steps from missing permissions).

### Configurable report format

`report_format: table` produces a real Markdown table:

| | Count |
|---|--:|
| tests | 5 |
| ✅ passed | 1 |
| 💤 skipped | 1 |
| ❌ failed | 3 |
| 🔥 errors | 0 |

When a previous run is found, a delta column (`Δ`) is added automatically.
`report_format: text` renders the same numbers on a single line.

## Cross-commit deltas (digest)

`cinct` embeds a compact **gzip + base64 digest** of the run stats in the report.
The next run reads the prior digest to compute deltas. The digest is
**wire-compatible** with `EnricoMi/publish-unit-test-result-action`: `cinct` can
read digests written by that action (and vice-versa). The JSON schema and
encoding match; only the compressed gzip bytes differ, which is harmless because
digests are always decoded, never string-compared.

## Acknowledgements / Inspired by

`cinct` is inspired by and modeled on
[**EnricoMi/publish-unit-test-result-action**](https://github.com/EnricoMi/publish-unit-test-result-action),
an excellent and widely used reporter. `cinct` is an **independent,
format-compatible reimplementation** of the parts of that action most CI
pipelines actually use — written natively for Node so it starts fast everywhere,
especially Windows. It is **not affiliated with or endorsed by** that project.
The format parsers are faithful ports of its XSLT stylesheets and Python
modules, validated against its own test fixtures, and the digest format is
deliberately interoperable.

## Replacing EnricoMi/publish-unit-test-result-action

A common setup is the Windows advisory variant, which reports results without
failing the job. **Before** (their action):

```yaml
permissions:
  checks: write
  pull-requests: write
  contents: read

steps:
  - uses: EnricoMi/publish-unit-test-result-action/windows@v2
    if: always()
    with:
      files: test-results.xml
      fail_on: nothing
```

**After** (`cinct`, same permissions and inputs):

```yaml
permissions:
  checks: write
  pull-requests: write
  contents: read

steps:
  - uses: nexdrew/cinct@v1
    if: always()
    with:
      files: test-results.xml
      fail_on: nothing
```

`cinct` is a single `node24` action, so there is no `/windows` (or `/composite`,
`/docker`) variant — one `uses:` line works identically on Linux, macOS, and
Windows.

## Testing & coverage

The pure logic — every parser, the stats aggregation, the digest, the report
renderer, settings, and file collection — is held at **100% coverage**
(statements, branches, functions, and lines), enforced in CI via
`npm run coverage:check`. Genuinely-unreachable defensive branches are marked
with justified `c8 ignore` comments.

The GitHub-API modules (`publish.ts`, `comment.ts`, `github.ts`) and the entry
shim (`main.ts`) are excluded from the coverage gate by design — they're thin
wrappers over Octokit whose behaviour is best verified against the live API.
Their pure helpers (conclusion, annotation building, rendering) are fully
tested.

## Notes

- **Annotations** point at the test result file at line 1, since most test
  formats carry no source location. Use repo-relative `files` globs so the
  annotation resolves against the repository tree.

## npm / distribution

The package is **`private: true`** and is **not published to npm**. A GitHub
Action is consumed via `uses: owner/repo@ref`, not from npm, so there is nothing
to publish for the action itself — the committed `dist/index.js` bundle is what
runs. A separate library entry point could be published to npm later if there's
demand for using the parsers/digest outside of Actions.

## Development

```bash
npm install
npm test         # node:test + tsx
npm run typecheck
npm run lint     # ts-standard (CI enforced)
npm run build    # bundles src -> dist/index.js via @vercel/ncc
```

`dist/index.js` is committed (required for JS actions) and CI verifies it stays
in sync with `src/`.

### Project layout

```
action.yml            # node24 action definition
src/
  main.ts             # entry: collect -> parse -> aggregate -> render -> publish
  collect.ts          # glob + format detection
  parse/registry.ts   # format detection + dispatch
  parse/junit.ts      # JUnit XML
  parse/xunit.ts      # xUnit (<assemblies>)
  parse/nunit.ts      # NUnit 2/3
  parse/trx.ts        # Visual Studio / MSTest TRX
  parse/tap.ts        # TAP v13/v14
  parse/dart.ts       # Dart test JSON event stream
  parse/mocha.ts      # Mocha JSON reporter
  results.ts          # aggregation: runs vs distinct tests
  digest.ts           # gzip+base64 digest (read/write, EnricoMi-compatible)
  conclusion.ts       # fail_on / action_fail conclusion logic
  render.ts           # configurable text/table report
  annotations.ts      # check-run annotations for failures/errors
  comment.ts          # PR comment upsert (create then edit in place)
  publish.ts          # GitHub check run + comments + digest read + fork handling
test/                 # node:test specs + fixtures
```

## Roadmap

- [x] JUnit + xUnit parsing
- [x] NUnit + TRX parsing
- [x] TAP parsing (Bun / node:test)
- [x] Dart JSON + Mocha JSON parsing
- [x] tests-vs-runs aggregation (validated against reference fixtures)
- [x] EnricoMi-compatible digest read/write
- [x] configurable `text` / `table` report
- [x] check run
- [x] job summary + `json` output
- [x] PR comment create / edit in place
- [x] earlier-commit deltas (`compare_to_earlier_commit`)
- [x] check-run annotations (batched at 50/request)
- [x] read/write throttling + retry
- [x] fork / pull-request-from-fork handling (job summary only)
- [x] `ts-standard` lint in CI
- [x] TRX numeric character reference decoding
- [x] TRX data-driven `<InnerResults>` expansion
- [x] Dart `isFailure`-vs-`result` run/test mapping
- [x] 100% coverage (pure modules) enforced in CI
- [x] automated releases (release-please) + floating major tag
- [ ] live-API verification on a real PR, then tag `v1.0.0`

## Versioning & releases

Releases follow the GitHub Action moving-tag convention. Pin whichever level of
stability you want:

- `@v1` — latest compatible release (all `1.x`)
- `@v1.2` — latest patch within a minor (all `1.2.x`)
- `@v1.2.3` — an exact release (fully reproducible)

`@v1` and `@v1.2` are force-moved to each new matching release by the release
workflow; `@v1.2.3` never moves.

Releases are automated with
[`release-please`](https://github.com/googleapis/release-please-action) using
[Conventional Commits](https://www.conventionalcommits.org/):

1. Merging to `main` opens/updates a **Release PR** that accumulates the version
   bump and `CHANGELOG.md` entries derived from commit messages.
2. Merging that Release PR creates the `vX.Y.Z` tag and GitHub release, and a CI
   step force-updates the floating major tag (e.g. `v1`) to point at it.

To cut the first stable release, include `Release-As: 1.0.0` in a commit on
`main` (e.g. in the Release PR), and release-please will propose `v1.0.0`.

> Pre-1.0: pin a commit SHA or exact tag until `v1.0.0` ships.

## License

MIT
