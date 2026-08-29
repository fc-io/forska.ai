import {createHash} from 'node:crypto'
import {access, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'

import {spawnSync, which} from 'bun'

type Environment = Record<string, string | undefined>

export const realCodexOptInEnvironmentVariable = 'FORSKA_RUN_REAL_CODEX_SMOKE'
export const realCodexPinnedModel = 'gpt-5.6-luna'
export const realCodexPinnedThinking = 'low'
export const realCodexOverallTimeoutMs = 20 * 60 * 1_000
export const realCodexMaximumRecoverableAttemptsPerArticle = 2
export const realCodexPrompt =
  'Does the title and abstract describe original empirical research involving human participants?'

export type RealArticleFixture = {
  abstract: string
  authors: string[]
  contentSha256: string
  doi: string
  fixtureId: string
  license: string
  licenseEvidenceUrl: string
  publicationDate: string
  sourceUrl: string
  title: string
}

export type RealCodexContentFlags = {useAbstract: true; useFulltext: false; useFulltextNoImages: false; useTitle: true}

export type RealCodexSeedArticle = RealArticleFixture & {fulltextSentinel: string; imageSentinelUrl: string}

export type RealCodexProvisionedFixture = {
  jobId: string
  modelId: string
  projectId: string
  promptId: string
  providerConnectionId: string
}

export type RealCodexTerminalObservation = {
  articleCount: number
  elapsedMs: number
  error: string | null
  inputTokens: number | null
  logicalDispatchCount: number
  outputTokens: number | null
  requestAttemptCount: number
  status: 'completed' | 'failed' | 'timed_out'
}

export type RealCodexEvidence = {
  contentFlags: RealCodexContentFlags
  executionInputs: Array<{articleFixtureId: string; renderedInput: string}>
  judgments: Array<{
    articleFixtureId: string
    contentFlags: RealCodexContentFlags
    modelId: string
    providerKind: string
    schemaValid: boolean
    thinking: string
  }>
  model: {
    authMode: string | null
    baseUrl: string | null
    metadataThinking: string | null
    providerKind: string
    remoteModelId: string | null
    secretRef: string | null
    variant: string | null
  }
  visibleProjectionCount: number
}

export type RealCodexTopologyAdapter = {
  inspectEvidence: (fixture: RealCodexProvisionedFixture) => Promise<RealCodexEvidence>
  provisionThroughHttp: (input: {
    articles: RealCodexSeedArticle[]
    contentFlags: RealCodexContentFlags
    model: {displayName: string; remoteModelId: string; thinking: string; variant: string}
    prompt: string
  }) => Promise<RealCodexProvisionedFixture>
  start: (input: {durableRoot: string; inheritedCodexHome: string | null}) => Promise<void>
  startJobThroughHttp: (fixture: RealCodexProvisionedFixture) => Promise<void>
  stop: () => Promise<void>
  waitForTerminal: (input: {
    jobId: string
    stopAdmissionAfterFailure: true
    timeoutMs: number
  }) => Promise<RealCodexTerminalObservation>
}

const fixturesPath = join(import.meta.dir, 'realArticleFixtures.json')
const contentFlags: RealCodexContentFlags = {
  useAbstract: true,
  useFulltext: false,
  useFulltextNoImages: false,
  useTitle: true,
}

export const getRealArticleCanonicalContent = ({abstract, title}: Pick<RealArticleFixture, 'abstract' | 'title'>) => {
  return `title\n${title.normalize('NFC')}\nabstract\n${abstract.normalize('NFC')}\n`
}

export const getRealArticleContentSha256 = (fixture: Pick<RealArticleFixture, 'abstract' | 'title'>) => {
  return createHash('sha256').update(getRealArticleCanonicalContent(fixture), 'utf8').digest('hex')
}

const assertFixture = (fixture: RealArticleFixture) => {
  const expectedHash = getRealArticleContentSha256(fixture)

  if (fixture.contentSha256 !== expectedHash) {
    throw new Error(
      `Real article fixture ${fixture.fixtureId} hash mismatch: expected ${fixture.contentSha256}, got ${expectedHash}`,
    )
  }

  if (
    !fixture.title.trim()
    || !fixture.abstract.trim()
    || !fixture.license.trim()
    || !fixture.licenseEvidenceUrl.trim()
  ) {
    throw new Error(`Real article fixture ${fixture.fixtureId} is missing required redistributable content metadata`)
  }

  return fixture
}

export const loadAndValidateRealArticleFixtures = async () => {
  const value = JSON.parse(await readFile(fixturesPath, 'utf8')) as RealArticleFixture[]

  if (
    value.length !== 3
    || new Set(
      value.map(({fixtureId}) => {
        return fixtureId
      }),
    ).size !== value.length
  ) {
    throw new Error('Real Codex smoke requires exactly three uniquely identified article fixtures')
  }

  return value.map(assertFixture)
}

export const getRealCodexSeedArticles = (fixtures: RealArticleFixture[]): RealCodexSeedArticle[] => {
  return fixtures.map((fixture) => {
    return {
      ...fixture,
      fulltextSentinel: `FORSKA_REAL_CODEX_FULLTEXT_SENTINEL_${fixture.fixtureId}`,
      imageSentinelUrl: `https://invalid.example/FORSKA_REAL_CODEX_IMAGE_SENTINEL_${fixture.fixtureId}.png`,
    }
  })
}

const assertLocalPrerequisites = async (env: Environment, executableOverride?: string) => {
  if (env[realCodexOptInEnvironmentVariable] !== '1') {
    throw new Error(
      `${realCodexOptInEnvironmentVariable}=1 is required before any real-Codex fixture or job is created`,
    )
  }

  const codexExecutable = executableOverride ?? which('codex')

  if (!codexExecutable) {
    throw new Error('Codex CLI executable is required')
  }

  await access(codexExecutable)
  const loginStatus = spawnSync([codexExecutable, 'login', 'status'], {stderr: 'pipe', stdin: 'ignore', stdout: 'pipe'})

  if (loginStatus.exitCode !== 0) {
    const diagnostic = `${loginStatus.stdout.toString()}${loginStatus.stderr.toString()}`.trim()
    throw new Error(diagnostic || 'Codex CLI is not authenticated')
  }

  return {codexHome: env.CODEX_HOME?.trim() || join(homedir(), '.codex')}
}

const createDurableRoot = async (env: Environment) => {
  const baseRoot = env.FORSKA_REAL_CODEX_DURABLE_TEST_ROOT?.trim()

  if (!baseRoot) {
    throw new Error(
      'FORSKA_REAL_CODEX_DURABLE_TEST_ROOT must name a disposable production-valid durable app-data directory',
    )
  }

  await mkdir(baseRoot, {recursive: true})
  const durableRoot = await mkdtemp(join(baseRoot, 'judgment-real-codex-'))

  return {baseRoot, durableRoot}
}

const assertEvidence = ({
  articles,
  evidence,
  fixture,
}: {
  articles: RealCodexSeedArticle[]
  evidence: RealCodexEvidence
  fixture: RealCodexProvisionedFixture
}) => {
  const expectedModel = {
    authMode: 'codex-cli',
    baseUrl: null,
    metadataThinking: realCodexPinnedThinking,
    providerKind: 'codex',
    remoteModelId: realCodexPinnedModel,
    secretRef: null,
    variant: realCodexPinnedThinking,
  }

  if (JSON.stringify(evidence.model) !== JSON.stringify(expectedModel)) {
    throw new Error(`Real Codex model contract mismatch: ${JSON.stringify(evidence.model)}`)
  }

  if (JSON.stringify(evidence.contentFlags) !== JSON.stringify(contentFlags)) {
    throw new Error(`Real Codex project content flags mismatch: ${JSON.stringify(evidence.contentFlags)}`)
  }

  const evidenceByFixtureId = new Map(
    evidence.executionInputs.map((entry) => {
      return [entry.articleFixtureId, entry]
    }),
  )

  articles.map((article) => {
    const input = evidenceByFixtureId.get(article.fixtureId)?.renderedInput

    if (!input?.includes(article.title) || !input.includes(article.abstract)) {
      throw new Error(`Execution input for ${article.fixtureId} omitted its title or abstract`)
    }

    if (input.includes(article.fulltextSentinel) || input.includes(article.imageSentinelUrl)) {
      throw new Error(`Execution input for ${article.fixtureId} leaked excluded full text or image content`)
    }

    return article
  })

  if (evidence.judgments.length !== articles.length) {
    throw new Error(`Expected ${articles.length} canonical judgments, got ${evidence.judgments.length}`)
  }

  if (evidence.visibleProjectionCount !== articles.length) {
    throw new Error(
      `Expected ${articles.length} projected real-Codex judgments, got ${evidence.visibleProjectionCount}`,
    )
  }

  evidence.judgments.map((judgment) => {
    if (
      judgment.modelId !== fixture.modelId
      || judgment.providerKind !== 'codex'
      || judgment.thinking !== realCodexPinnedThinking
      || !judgment.schemaValid
      || JSON.stringify(judgment.contentFlags) !== JSON.stringify(contentFlags)
    ) {
      throw new Error(`Invalid durable real-Codex judgment evidence: ${JSON.stringify(judgment)}`)
    }

    return judgment
  })
}

export const runRealCodexSmoke = async ({
  adapter,
  codexExecutable,
  env = process.env,
}: {
  adapter: RealCodexTopologyAdapter
  codexExecutable?: string
  env?: Environment
}) => {
  const fixtures = await loadAndValidateRealArticleFixtures()
  const {codexHome} = await assertLocalPrerequisites(env, codexExecutable)
  const {durableRoot} = await createDurableRoot(env)
  const articles = getRealCodexSeedArticles(fixtures)
  const maximumLogicalProviderAttempts = articles.length * realCodexMaximumRecoverableAttemptsPerArticle
  const startedAt = Date.now()

  console.log(
    `[judgment-real-codex] opt-in accepted; model=${realCodexPinnedModel} thinking=${realCodexPinnedThinking} articles=${articles.length} maximum_logical_provider_attempts=${maximumLogicalProviderAttempts} timeout_ms=${realCodexOverallTimeoutMs}`,
  )

  try {
    await adapter.start({durableRoot, inheritedCodexHome: codexHome})
    const provisioned = await adapter.provisionThroughHttp({
      articles,
      contentFlags,
      model: {
        displayName: 'GPT-5.6 Luna (real Codex smoke)',
        remoteModelId: realCodexPinnedModel,
        thinking: realCodexPinnedThinking,
        variant: realCodexPinnedThinking,
      },
      prompt: realCodexPrompt,
    })
    await adapter.startJobThroughHttp(provisioned)
    const terminal = await adapter.waitForTerminal({
      jobId: provisioned.jobId,
      stopAdmissionAfterFailure: true,
      timeoutMs: realCodexOverallTimeoutMs,
    })

    if (terminal.status !== 'completed') {
      throw new Error(terminal.error ?? `Real Codex smoke ended with status ${terminal.status}`)
    }

    if (
      terminal.articleCount !== articles.length
      || terminal.logicalDispatchCount > maximumLogicalProviderAttempts
      || terminal.requestAttemptCount > maximumLogicalProviderAttempts
    ) {
      throw new Error(
        `Real Codex cost evidence exceeded the declared bound: ${JSON.stringify({
          articleCount: terminal.articleCount,
          logicalDispatchCount: terminal.logicalDispatchCount,
          maximumLogicalProviderAttempts,
          requestAttemptCount: terminal.requestAttemptCount,
        })}`,
      )
    }

    const evidence = await adapter.inspectEvidence(provisioned)
    assertEvidence({articles, evidence, fixture: provisioned})

    const result = {
      ...terminal,
      elapsedMs: Date.now() - startedAt,
      fixtureContentHashes: fixtures.map(({contentSha256, fixtureId}) => {
        return {contentSha256, fixtureId}
      }),
      model: realCodexPinnedModel,
      thinking: realCodexPinnedThinking,
    }
    console.log(`[judgment-real-codex] ${JSON.stringify(result)}`)

    return result
  } finally {
    try {
      await adapter.stop()
    } finally {
      await rm(durableRoot, {force: true, recursive: true})
    }
  }
}
