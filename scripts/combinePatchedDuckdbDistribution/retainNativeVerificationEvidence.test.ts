import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Archive} from 'bun'
import {expect, test} from 'bun:test'

import {nativeVerificationFixture} from './nativeVerificationFixture'
import {retainNativeVerificationEvidence} from './retainNativeVerificationEvidence'

test('release evidence preserves exact XML/results and deterministic target identity without modifying packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-native-evidence-'))
  const repeat = await mkdtemp(join(tmpdir(), 'forska-native-evidence-repeat-'))
  try {
    const one = nativeVerificationFixture(0)
    const two = nativeVerificationFixture(1)
    const original = JSON.stringify(one)
    const first = await retainNativeVerificationEvidence([two, one], root)
    expect(await retainNativeVerificationEvidence([one, two], repeat)).toEqual(first)
    expect(JSON.stringify(one)).toBe(original)
    const files = await new Archive(await readFile(join(root, first.filename))).files()
    const target = `${one.platform.platform}-${one.platform.arch}`
    expect(await files.get(`${target}-native-tests.xml`)?.text()).toBe(new TextDecoder().decode(one.nativeXml))
    expect(await files.get(`${target}-verification.json`)?.text()).toBe(new TextDecoder().decode(one.verification))
    const report = JSON.parse(await readFile(join(root, 'NATIVE_VERIFICATION.json'), 'utf8')) as {
      targetCount: number
      targets: {
        native: {passed: number; failed: number; skipped: number}
        workflow: {runId: string}
        package: {sha256: string}
      }[]
    }
    expect(report.targetCount).toBe(2)
    expect(report.targets[0]?.native).toMatchObject({passed: 18, failed: 0, skipped: 0})
    expect(report.targets[0]?.workflow.runId).toBe('test-run')
    expect(report.targets[0]?.package.sha256).toBe(one.platform.sha256)
  } finally {
    await Promise.all([rm(root, {recursive: true, force: true}), rm(repeat, {recursive: true, force: true})])
  }
})

test('release evidence rejects partial/skipped native cases, missing semantic phases and changed identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-native-evidence-reject-'))
  try {
    const entry = nativeVerificationFixture()
    const xml = new TextDecoder().decode(entry.nativeXml)
    await assert.rejects(
      retainNativeVerificationEvidence(
        [{...entry, nativeXml: Buffer.from(xml.replace(/<testcase[^>]+\/>/, ''))}],
        root,
      ),
      /13 checkpoint|18 named/,
    )
    await assert.rejects(
      retainNativeVerificationEvidence(
        [{...entry, nativeXml: Buffer.from(xml.replace('</testsuite>', '<skipped/></testsuite>'))}],
        root,
      ),
      /failed or skipped/,
    )
    const result = JSON.parse(new TextDecoder().decode(entry.verification)) as Record<string, unknown>
    await assert.rejects(
      retainNativeVerificationEvidence(
        [{...entry, verification: Buffer.from(JSON.stringify({...result, phases: ['seed']}))}],
        root,
      ),
      /Incomplete native package/,
    )
    await assert.rejects(
      retainNativeVerificationEvidence([{...entry, engine: {...entry.engine, sourceId: 'different'}}], root),
      /different/,
    )
    await assert.rejects(retainNativeVerificationEvidence([entry, entry], root), /Duplicate native verification/)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
