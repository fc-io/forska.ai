import {access, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {captureJudgmentRequestEvidence} from './judgeRequestEvidence.ts'

const roots: string[] = []

afterEach(async () => {
  process.env.NODE_ENV = 'test'
  delete process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED
  delete process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST
  delete process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT
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
  process.env.NODE_ENV = 'test'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED = 'true'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT = root

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

test('is inert outside the test environment even when hook variables are present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-request-evidence-'))
  roots.push(root)
  const outputPath = join(root, 'evidence.jsonl')
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({fixtures: [], outputPath}), 'utf8')
  process.env.NODE_ENV = 'production'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED = 'true'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT = root

  await captureJudgmentRequestEvidence({articleId: 'a', jobId: 'j', prompt: 'p', systemPrompt: 's'})

  let outputExists = true
  try {
    await access(outputPath)
  } catch {
    outputExists = false
  }
  expect(outputExists).toBeFalse()
})

test('is inert without the explicit opt-in in the test environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-request-evidence-'))
  roots.push(root)
  const outputPath = join(root, 'evidence.jsonl')
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({fixtures: [], outputPath}), 'utf8')
  process.env.NODE_ENV = 'test'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT = root

  await captureJudgmentRequestEvidence({articleId: 'a', jobId: 'j', prompt: 'p', systemPrompt: 's'})

  let outputExists = true
  try {
    await access(outputPath)
  } catch {
    outputExists = false
  }
  expect(outputExists).toBeFalse()
})

test('rejects an evidence output path outside the declared test root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-request-evidence-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'forska-request-evidence-outside-'))
  roots.push(root, outsideRoot)
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({fixtures: [], outputPath: join(outsideRoot, 'evidence.jsonl')}), 'utf8')
  process.env.NODE_ENV = 'test'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED = 'true'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT = root

  let error: unknown
  try {
    await captureJudgmentRequestEvidence({articleId: 'a', jobId: 'j', prompt: 'p', systemPrompt: 's'})
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('must be confined under the declared test root')
})

test('rejects an in-root output symlink that points outside the declared test root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-request-evidence-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'forska-request-evidence-outside-'))
  roots.push(root, outsideRoot)
  const outputPath = join(root, 'evidence.jsonl')
  const outsideOutputPath = join(outsideRoot, 'escaped.jsonl')
  const manifestPath = join(root, 'manifest.json')
  const fixture = {
    abstract: 'ABSTRACT',
    fixtureId: 'article-a',
    fulltextSentinel: 'FULLTEXT',
    imageSentinelUrl: 'IMAGE',
    title: 'TITLE',
  }
  await symlink(outsideOutputPath, outputPath)
  await writeFile(manifestPath, JSON.stringify({fixtures: [fixture], outputPath}), 'utf8')
  process.env.NODE_ENV = 'test'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED = 'true'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT = root

  let error: unknown
  try {
    await captureJudgmentRequestEvidence({
      articleId: fixture.fixtureId,
      jobId: 'job-a',
      prompt: `${fixture.title}\n${fixture.abstract}`,
      systemPrompt: 'system',
    })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  let outsideOutputExists = true
  try {
    await access(outsideOutputPath)
  } catch {
    outsideOutputExists = false
  }
  expect(outsideOutputExists).toBeFalse()
})

test('rejects a manifest outside the declared test root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forska-request-evidence-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'forska-request-evidence-outside-'))
  roots.push(root, outsideRoot)
  const manifestPath = join(outsideRoot, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify({fixtures: [], outputPath: join(root, 'evidence.jsonl')}), 'utf8')
  process.env.NODE_ENV = 'test'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED = 'true'
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = manifestPath
  process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT = root

  let error: unknown
  try {
    await captureJudgmentRequestEvidence({articleId: 'a', jobId: 'j', prompt: 'p', systemPrompt: 's'})
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('manifest path must be confined')
})
