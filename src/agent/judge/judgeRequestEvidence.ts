import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {open, readFile, realpath} from 'node:fs/promises'
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path'

type RequestEvidenceFixture = {
  abstract: string
  fixtureId: string
  fulltextSentinel: string
  imageSentinelUrl: string
  title: string
}

type RequestEvidenceManifest = {fixtures: RequestEvidenceFixture[]; outputPath: string}

let cachedManifestPath: string | null = null
let cachedTestRoot: string | null = null
let cachedManifest: RequestEvidenceManifest | null = null

const isConfinedPath = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

const getManifest = async (): Promise<RequestEvidenceManifest | null> => {
  if (process.env.NODE_ENV !== 'test' || process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ENABLED !== 'true') {
    return null
  }

  const manifestPath = process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST?.trim()
  const testRoot = process.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_ROOT?.trim()

  if (!manifestPath || !testRoot) return null
  if (cachedManifestPath === manifestPath && cachedTestRoot === testRoot && cachedManifest) return cachedManifest

  const canonicalRoot = await realpath(resolve(testRoot))
  const canonicalManifestPath = await realpath(resolve(manifestPath))
  if (!isConfinedPath(canonicalRoot, canonicalManifestPath)) {
    throw new Error('Judgment request evidence manifest path must be confined under the declared test root')
  }

  const parsed = JSON.parse(await readFile(canonicalManifestPath, 'utf8')) as RequestEvidenceManifest
  if (!parsed.outputPath || !Array.isArray(parsed.fixtures)) {
    throw new Error('Judgment request evidence manifest is invalid')
  }

  const canonicalOutputParent = await realpath(dirname(resolve(parsed.outputPath)))
  const canonicalOutput = resolve(canonicalOutputParent, basename(parsed.outputPath))
  if (!isConfinedPath(canonicalRoot, canonicalOutput) || canonicalOutput === canonicalRoot) {
    throw new Error('Judgment request evidence output path must be confined under the declared test root')
  }
  cachedManifestPath = manifestPath
  cachedTestRoot = testRoot
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
  const output = await open(
    manifest.outputPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await output.writeFile(`${JSON.stringify(evidence)}\n`, 'utf8')
  } finally {
    await output.close()
  }
}
