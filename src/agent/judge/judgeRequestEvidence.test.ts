import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {captureJudgmentRequestEvidence} from './judgeRequestEvidence.ts'

const roots: string[] = []

afterEach(async () => {
  delete process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST
  await Promise.all(
    roots.splice(0).map((root) => {
      return rm(root, {force: true, recursive: true})
    }),
  )
})

test('captures request-boundary inclusion evidence without persisting prompt text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-request-evidence-'))
  roots.push(root)
  const outputPath = join(root, 'evidence.jsonl')
  const manifestPath = join(root, 'manifest.json')
  const fixture = {
    abstract: 'UNIQUE_ABSTRACT',
    fixtureId: 'article-a',
    fulltextSentinel: 'EXCLUDED_FULLTEXT',
    imageSentinelUrl: 'EXCLUDED_IMAGE',
    title: 'UNIQUE_TITLE',
  }
  await writeFile(manifestPath, JSON.stringify({fixtures: [fixture], outputPath}), 'utf8')
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath

  await captureJudgmentRequestEvidence({
    articleId: 'article-a',
    jobId: 'job-a',
    prompt: 'UNIQUE_TITLE\nUNIQUE_ABSTRACT',
    systemPrompt: 'system',
  })

  const evidenceText = await readFile(outputPath, 'utf8')
  const evidence = JSON.parse(evidenceText) as Record<string, unknown>
  expect(evidence).toMatchObject({
    articleFixtureId: 'article-a',
    hasAbstract: true,
    hasExcludedFulltext: false,
    hasExcludedImage: false,
    hasTitle: true,
    jobId: 'job-a',
  })
  expect(evidence.requestPayloadSha256).toBeString()
  expect(evidenceText).not.toContain('UNIQUE_TITLE')
  expect(evidenceText).not.toContain('UNIQUE_ABSTRACT')
})
