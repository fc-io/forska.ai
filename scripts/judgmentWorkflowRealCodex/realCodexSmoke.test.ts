import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, test} from 'bun:test'

import {
  getRealArticleCanonicalContent,
  getRealArticleContentSha256,
  getRealCodexSeedArticles,
  loadAndValidateRealArticleFixtures,
  type RealArticleFixture,
  type RealCodexEvidence,
  realCodexOptInEnvironmentVariable,
  realCodexPinnedModel,
  realCodexPinnedThinking,
  type RealCodexProvisionedFixture,
  type RealCodexTopologyAdapter,
  runRealCodexSmoke,
} from './realCodexSmoke.ts'
import {createRealCodexTopologyAdapter} from './realCodexTopologyAdapter.ts'

const roots: string[] = []

const getError = async (promise: Promise<unknown>) => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => {
      return rm(root, {force: true, recursive: true})
    }),
  )
})

const getProvisionedFixture = (): RealCodexProvisionedFixture => {
  return {
    jobId: 'job-real-codex',
    modelId: 'model-real-codex',
    projectId: 'project-real-codex',
    promptId: 'prompt-real-codex',
    providerConnectionId: 'connection-real-codex',
  }
}

const getEvidence = async (): Promise<RealCodexEvidence> => {
  const fixtures = await loadAndValidateRealArticleFixtures()

  return {
    contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
    executionInputs: fixtures.map((fixture) => {
      return {articleFixtureId: fixture.fixtureId, renderedInput: `${fixture.title}\n${fixture.abstract}`}
    }),
    judgments: fixtures.map((fixture) => {
      return {
        articleFixtureId: fixture.fixtureId,
        contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        modelId: 'model-real-codex',
        providerKind: 'codex',
        schemaValid: true,
        thinking: realCodexPinnedThinking,
      }
    }),
    model: {
      authMode: 'codex-cli',
      baseUrl: null,
      metadataThinking: realCodexPinnedThinking,
      providerKind: 'codex',
      remoteModelId: realCodexPinnedModel,
      secretRef: null,
      variant: realCodexPinnedThinking,
    },
    visibleProjectionCount: fixtures.length,
  }
}

const getAdapter = (updates?: Partial<RealCodexTopologyAdapter>) => {
  const adapter: RealCodexTopologyAdapter = {
    inspectEvidence: getEvidence,
    provisionThroughHttp: async () => {
      return getProvisionedFixture()
    },
    start: async () => {
      return undefined
    },
    startJobThroughHttp: async () => {
      return undefined
    },
    stop: async () => {
      return undefined
    },
    waitForTerminal: async () => {
      return {
        articleCount: 3,
        elapsedMs: 10,
        error: null,
        inputTokens: 1_000,
        logicalDispatchCount: 3,
        outputTokens: 100,
        requestAttemptCount: 3,
        status: 'completed',
      }
    },
    ...updates,
  }

  return adapter
}

test('committed fixtures have stable canonical hashes and redistribution evidence', async () => {
  const fixtures = await loadAndValidateRealArticleFixtures()

  expect(fixtures).toHaveLength(3)
  expect(fixtures.map(getRealArticleContentSha256)).toEqual(
    fixtures.map(({contentSha256}) => {
      return contentSha256
    }),
  )
  expect(getRealArticleCanonicalContent(fixtures[0] as RealArticleFixture)).toStartWith('title\n')
  expect(
    fixtures.every(({licenseEvidenceUrl}) => {
      return licenseEvidenceUrl.startsWith('https://journals.plos.org/')
    }),
  ).toBe(true)
})

test('in-repo topology adapter refuses provisioning before the production stack starts', async () => {
  const adapter = createRealCodexTopologyAdapter()
  const articles = getRealCodexSeedArticles(await loadAndValidateRealArticleFixtures())
  const error = await getError(
    adapter.provisionThroughHttp({
      articles,
      contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
      model: {
        displayName: 'GPT-5.6 Luna',
        remoteModelId: realCodexPinnedModel,
        thinking: realCodexPinnedThinking,
        variant: realCodexPinnedThinking,
      },
      prompt: 'Test prompt',
    }),
  )

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('topology is not running')
})

test('seed articles add unique excluded-content sentinels outside canonical fixture hashes', async () => {
  const fixtures = await loadAndValidateRealArticleFixtures()
  const articles = getRealCodexSeedArticles(fixtures)

  expect(
    new Set(
      articles.map(({fulltextSentinel}) => {
        return fulltextSentinel
      }),
    ).size,
  ).toBe(3)
  expect(
    new Set(
      articles.map(({imageSentinelUrl}) => {
        return imageSentinelUrl
      }),
    ).size,
  ).toBe(3)
  expect(
    articles.every((article) => {
      const canonical = getRealArticleCanonicalContent(article)
      return !canonical.includes(article.fulltextSentinel) && !canonical.includes(article.imageSentinelUrl)
    }),
  ).toBe(true)
})

test('runner refuses missing opt-in before starting topology', async () => {
  let startCalls = 0
  const adapter = getAdapter({
    start: async () => {
      startCalls += 1
    },
  })

  const error = await getError(runRealCodexSmoke({adapter, env: {}}))
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain(`${realCodexOptInEnvironmentVariable}=1 is required`)
  expect(startCalls).toBe(0)
})

test('runner preserves the terminal provider diagnostic and always stops the adapter', async () => {
  const baseRoot = await mkdtemp(join(tmpdir(), 'forska-real-codex-test-'))
  roots.push(baseRoot)
  let stopCalls = 0
  const fakeCodex = join(baseRoot, 'codex')
  await writeFile(fakeCodex, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  const originalPath = process.env.PATH
  process.env.PATH = `${baseRoot}:${originalPath}`

  try {
    const error = await getError(
      runRealCodexSmoke({
        adapter: getAdapter({
          stop: async () => {
            stopCalls += 1
          },
          waitForTerminal: async () => {
            return {
              articleCount: 1,
              elapsedMs: 20,
              error: 'model gpt-5.6-luna is unavailable for this Codex account',
              inputTokens: null,
              logicalDispatchCount: 1,
              outputTokens: null,
              requestAttemptCount: 1,
              status: 'failed',
            }
          },
        }),
        codexExecutable: fakeCodex,
        env: {
          CODEX_HOME: join(baseRoot, 'codex-home'),
          FORSKA_REAL_CODEX_DURABLE_TEST_ROOT: baseRoot,
          [realCodexOptInEnvironmentVariable]: '1',
        },
      }),
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('model gpt-5.6-luna is unavailable for this Codex account')
    expect(stopCalls).toBe(1)
    expect((await readFile(fakeCodex, 'utf8')).includes('exit 0')).toBe(true)
  } finally {
    process.env.PATH = originalPath
  }
})

test('runner rejects evidence containing the full-text sentinel and tears down', async () => {
  const baseRoot = await mkdtemp(join(tmpdir(), 'forska-real-codex-evidence-test-'))
  roots.push(baseRoot)
  const fakeCodex = join(baseRoot, 'codex')
  await writeFile(fakeCodex, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  const originalPath = process.env.PATH
  process.env.PATH = `${baseRoot}:${originalPath}`
  let stopCalls = 0

  try {
    const fixtures = await loadAndValidateRealArticleFixtures()
    const evidence = await getEvidence()
    const [fixture] = fixtures
    const [executionInput] = evidence.executionInputs

    if (!fixture || !executionInput) {
      throw new Error('Expected committed real-Codex fixture evidence')
    }

    executionInput.renderedInput += `\nFORSKA_REAL_CODEX_FULLTEXT_SENTINEL_${fixture.fixtureId}`

    const error = await getError(
      runRealCodexSmoke({
        adapter: getAdapter({
          inspectEvidence: async () => {
            return evidence
          },
          stop: async () => {
            stopCalls += 1
          },
        }),
        codexExecutable: fakeCodex,
        env: {
          CODEX_HOME: join(baseRoot, 'codex-home'),
          FORSKA_REAL_CODEX_DURABLE_TEST_ROOT: baseRoot,
          [realCodexOptInEnvironmentVariable]: '1',
        },
      }),
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('leaked excluded full text or image content')
    expect(stopCalls).toBe(1)
  } finally {
    process.env.PATH = originalPath
  }
})
