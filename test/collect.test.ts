import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandFiles, parseFiles } from '../src/collect.js'

async function withTmp (
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cinct-collect-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const JUNIT =
  '<testsuites><testsuite name="s">' +
  '<testcase name="t" classname="c"/></testsuite></testsuites>'

void test('expandFiles globs, de-duplicates, and sorts', async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, 'a.xml'), JUNIT)
    await writeFile(join(dir, 'b.xml'), JUNIT)
    await writeFile(join(dir, 'c.txt'), 'ignore me')
    const found = await expandFiles([
      join(dir, '*.xml'),
      join(dir, '*.xml') // duplicate pattern -> de-duplicated
    ])
    assert.deepEqual(found, [join(dir, 'a.xml'), join(dir, 'b.xml')])
  })
})

void test('parseFiles parses good files and collects errors for bad ones', async () => {
  await withTmp(async (dir) => {
    const good = join(dir, 'good.xml')
    const bad = join(dir, 'bad.xml')
    const missing = join(dir, 'missing.xml')
    await writeFile(good, JUNIT)
    await writeFile(bad, 'not a test report at all')

    const { files, errors } = await parseFiles([good, bad, missing])

    assert.equal(files.length, 1)
    assert.equal(files[0]?.suites.length, 1)
    // unsupported format + unreadable file both become ParseErrors, not throws
    assert.equal(errors.length, 2)
    assert.ok(errors.some((e) => e.file === bad))
    assert.ok(errors.some((e) => e.file === missing))
    assert.ok(errors.every((e) => typeof e.message === 'string'))
  })
})

void test('parseFiles on an empty list yields empty results', async () => {
  const { files, errors } = await parseFiles([])
  assert.equal(files.length, 0)
  assert.equal(errors.length, 0)
})
