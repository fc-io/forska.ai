import {createHash} from 'node:crypto'
import {appendFile, readFile} from 'node:fs/promises'

type RequestEvidenceFixture = {
  abstract: string
  fixtureId: string
  fulltextSentinel: string
  imageSentinelUrl: string
  title: string
}

type RequestEvidenceManifest = {fixtures: RequestEvidenceFixture[]; outputPath: string}

let cachedManifestPath: string | null = null
let cachedManifest: RequestEvidenceManifest | null = null

const getManifest = async (): Promise<RequestEvidenceManifest | null> => {
  const manifestPath = process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST?.trim()

  if (!manifestPath) return null
  if (cachedManifestPath === manifestPath && cachedManifest) return cachedManifest

  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as RequestEvidenceManifest
  if (!parsed.outputPath || !Array.isArray(parsed.fixtures)) {
    throw new Error('Judgment request evidence manifest is invalid')
  }
  cachedManifestPath = manifestPath
  cachedManifest = parsed
  return parsed
}

export const captureJudgmentRequestEvidence = async ({
  articleId,
  jobId,
  prompt,
  systemPrompt,
}: {
  articleId: string
  jobId: string
  prompt: string
  systemPrompt: string
}): Promise<void> => {
  const manifest = await getManifest()
  if (!manifest) return

  const fixture = manifest.fixtures.find(({fixtureId}) => {
    return articleId === fixtureId || articleId.endsWith(`:${fixtureId}`)
  })
  if (!fixture) return

  const requestPayload = `${systemPrompt}\n${prompt}`
  const evidence = {
    articleFixtureId: fixture.fixtureId,
    hasAbstract: requestPayload.includes(fixture.abstract),
    hasExcludedFulltext: requestPayload.includes(fixture.fulltextSentinel),
    hasExcludedImage: requestPayload.includes(fixture.imageSentinelUrl),
    hasTitle: requestPayload.includes(fixture.title),
    jobId,
    requestPayloadSha256: createHash('sha256').update(requestPayload, 'utf8').digest('hex'),
  }
  await appendFile(manifest.outputPath, `${JSON.stringify(evidence)}\n`, 'utf8')
}
