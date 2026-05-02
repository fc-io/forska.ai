import {afterAll, beforeAll, expect, mock, test} from 'bun:test'

import * as realReadOnlyDatabaseModule from '../../../services/appReadOnlyDatabaseService.ts'
import {createTempRuntimeRoot} from '../../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-get-and-update-ready-prompts')
const tempDbPath = tempRuntimeRoot.duckdbPath
const appReadOnlyDatabaseServiceModulePath = new URL('../../../services/appReadOnlyDatabaseService.ts', import.meta.url)
  .pathname
const judgeWorkerCompletionJournalModulePath = new URL('../judgeWorkerCompletionJournal.ts', import.meta.url).pathname

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let getAndUpdateReadyPrompts:
  | ((
      serverJobId: string,
      jobId: string,
      limit: number,
      requestRuntime: {
        providerConnectionId: string | null
        providerMaxInflightRequests: number | null
        providerUsesFamilyDefault: boolean
      },
    ) => Promise<
      Array<{
        articleId: string
        modelBaseUrl: string
        modelId: string
        providerConnectionId: string | null
        providerMaxInflightRequests: number | null
        providerUsesFamilyDefault: boolean
        projectId: string
        promptId: string
        recordId: string
      }>
    >)
  | null = null

beforeAll(async () => {
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    return realReadOnlyDatabaseModule
  })
  void mock.module(judgeWorkerCompletionJournalModulePath, () => {
    return {
      claimOwnerJudgmentJobPrompts: async () => {
        return []
      },
      getOwnerBackedJudgmentJobInfo: async () => {
        return null
      },
      recordAcceptedJudgeWorkerClaims: async () => {
        return undefined
      },
      shouldUseJudgeWorkerOwnerHandoff: () => {
        return false
      },
    }
  })

  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    readyPromptsModule,
  ] = await Promise.all([
    import('../../../../db/migrateDuckdb.ts'),
    import('../../../services/appDatabaseService.ts'),
    import('../../../utils/duckdbService.ts'),
    import('../../../utils/serverRuntimeRole.ts'),
    import('./getAndUpdateReadyPrompts.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  getAndUpdateReadyPrompts = readyPromptsModule.getAndUpdateReadyPrompts
})

afterAll(async () => {
  const {getJudgmentJobSqliteService} = await import('../judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('claims ready rows from the per-job SQLite queue', async () => {
  if (!getAndUpdateReadyPrompts || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const previousServerRole = process.env.SERVER_ROLE
  const {getJudgmentJobSqliteService} = await import('../judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const connectionId = `connection-${Date.now()}`
  const modelId = `model-${Date.now()}`
  const projectId = `project-${Date.now()}`
  const jobId = `job-${Date.now()}`
  const firstArticleId = `article-first-${Date.now()}`
  const secondArticleId = `article-second-${Date.now()}`
  const firstPromptId = `prompt-first-${Date.now()}`
  const secondPromptId = `prompt-second-${Date.now()}`

  process.env.SERVER_ROLE = 'dev-single'

  try {
    await runDatabase(`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
      VALUES (
        '${connectionId}',
        'sglang',
        'SGLang',
        TRUE,
        'none',
        'http://localhost:30001/v1',
        '{"manualWorkerUrls":[],"workerUrlMode":"manual"}'
      )
    `)
    await runDatabase(`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
    `)
    await runDatabase(`
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES ('${projectId}', 'Ready Prompt Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
    `)
    await runDatabase(`
      INSERT INTO app.judgment_job (id, project_id, status)
      VALUES ('${jobId}', '${projectId}', 'running')
    `)

    await sqliteService.initializeJob(jobId)
    await sqliteService.releaseOwnedLease(jobId)
    await sqliteService.addReadyPrompts(
      jobId,
      [
        {articleId: firstArticleId, promptId: firstPromptId},
        {articleId: secondArticleId, promptId: secondPromptId},
      ],
      'server-job-queued',
    )
    await sqliteService.releaseOwnedLease(jobId)

    const prompts = await getAndUpdateReadyPrompts('server-job-claim', jobId, 2, {
      providerConnectionId: connectionId,
      providerMaxInflightRequests: 3,
      providerUsesFamilyDefault: false,
    })

    expect(prompts).toHaveLength(2)
    expect(
      prompts.map((prompt) => {
        return {articleId: prompt.articleId, promptId: prompt.promptId}
      }),
    ).toEqual([
      {articleId: firstArticleId, promptId: firstPromptId},
      {articleId: secondArticleId, promptId: secondPromptId},
    ])
    expect(
      prompts.every((prompt) => {
        return (
          prompt.modelId === modelId
          && prompt.projectId === projectId
          && prompt.modelBaseUrl === 'http://localhost:30001/v1'
          && prompt.providerConnectionId === connectionId
          && prompt.providerMaxInflightRequests === 3
          && prompt.providerUsesFamilyDefault === false
        )
      }),
    ).toBe(true)
    expect(await sqliteService.getInFlightCount(jobId)).toBe(2)
    expect(await sqliteService.getReadyCount(jobId)).toBe(0)
    await sqliteService.closeAll()
  } finally {
    if (previousServerRole === undefined) {
      delete process.env.SERVER_ROLE
    } else {
      process.env.SERVER_ROLE = previousServerRole
    }
  }
})

test('owner-backed codex prompts bypass runtime autodetect', async () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const readyPromptsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts')
        const judgeWorkerCompletionJournalModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts')
        const providerRuntimeMatchResolverModulePath = getModulePath('./src/server/providers/providerRuntimeMatchResolver.ts')
        let acceptedClaimCount = 0
        let runtimeMatchCalls = 0

        void mock.module(judgeWorkerCompletionJournalModulePath, () => {
          return {
            claimOwnerJudgmentJobPrompts: async () => [{
              articleId: 'article-codex',
              claimId: 'claim-codex',
              executionSnapshotHash: 'snapshot-hash-codex',
              executionSnapshotId: 'snapshot-codex',
              jobId: 'job-codex',
              modelBaseUrl: 'unused',
              modelId: 'model-unused',
              modelMetadataJson: null,
              modelName: 'unused',
              modelProvider: 'codex',
              modelSecretRef: null,
              modelVersion: null,
              modelWorkerUrls: [],
              projectId: 'project-unused',
              promptId: 'prompt-codex',
              providerConnectionId: null,
              providerMaxInflightRequests: null,
              providerUsesFamilyDefault: true,
              recordId: 'record-codex',
              useAbstract: true,
              useFulltext: false,
              useFulltextNoImages: false,
              useTitle: true,
            }],
            getOwnerBackedJudgmentJobInfo: async () => ({
              modelBaseUrl: null,
              modelId: 'model-codex',
              modelMetadataJson: {provider: 'codex'},
              modelName: 'gpt-5.5',
              modelProvider: 'codex',
              modelSecretRef: null,
              modelVersion: 'xhigh',
              projectId: 'project-codex',
              providerConfigJson: {},
              resolvedRuntime: {modelBaseUrl: 'codex://app-server', modelProvider: 'codex', modelWorkerUrls: []},
              runtimeMatchReason: 'manual-provider',
              runtimeMatchStatus: 'matched',
              runtimeResolutionMode: 'manual',
              useAbstract: true,
              useFulltext: false,
              useFulltextNoImages: false,
              useTitle: true,
            }),
            recordAcceptedJudgeWorkerClaims: async (prompts) => {
              acceptedClaimCount += prompts.length
            },
            shouldUseJudgeWorkerOwnerHandoff: () => true,
          }
        })
        void mock.module(providerRuntimeMatchResolverModulePath, () => {
          return {
            resolveProviderConnectionRuntimeMatch: async () => {
              runtimeMatchCalls += 1
              throw new Error('runtime autodetect should not run for codex')
            },
          }
        })

        const {getAndUpdateReadyPrompts, getReadyPromptRuntime} = await import(readyPromptsModulePath + '?codex-owner-backed=' + Date.now())
        const runtime = await getReadyPromptRuntime('job-codex')
        const prompts = await getAndUpdateReadyPrompts('server-job-codex', 'job-codex', 1, {
          providerConnectionId: 'connection-codex',
          providerMaxInflightRequests: 20,
          providerUsesFamilyDefault: false,
        })

        console.log(JSON.stringify({acceptedClaimCount, prompts, runtime, runtimeMatchCalls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, SERVER_ROLE: 'judge-worker'}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'owner-backed codex test failed')
  }

  const result = JSON.parse(runScript.stdout.toString()) as {
    acceptedClaimCount: number
    prompts: Array<{modelBaseUrl: string; modelId: string; providerConnectionId: string | null}>
    runtime: {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]}
    runtimeMatchCalls: number
  }

  expect(result.runtime).toEqual({modelBaseUrl: 'codex://app-server', modelProvider: 'codex', modelWorkerUrls: []})
  expect(result.prompts).toHaveLength(1)
  expect(result.prompts[0]).toMatchObject({
    modelBaseUrl: 'codex://app-server',
    modelId: 'model-codex',
    providerConnectionId: 'connection-codex',
  })
  expect(result.acceptedClaimCount).toBe(1)
  expect(result.runtimeMatchCalls).toBe(0)
})

test('owner-backed non-Codex prompts use owner-provided runtime without autodetect', async () => {
  const runScript = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const getModulePath = (relativePath) => {
          return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
        }

        const readyPromptsModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts')
        const judgeWorkerCompletionJournalModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts')
        const providerRuntimeMatchResolverModulePath = getModulePath('./src/server/providers/providerRuntimeMatchResolver.ts')
        const providerRuntimeDetectorModulePath = getModulePath('./src/server/providers/providerRuntimeDetector.ts')
        const providerConnectionRepositoryModulePath = getModulePath('./src/server/providers/providerConnectionRepository.ts')
        const ownerRuntime = {
          modelBaseUrl: 'http://owner-sglang:30000/v1',
          modelProvider: 'sglang',
          modelWorkerUrls: ['http://owner-sglang-worker:30001'],
        }
        let acceptedClaimCount = 0
        let listProviderConnectionCalls = 0
        let runtimeMatchCalls = 0
        let runtimeSummaryCalls = 0

        void mock.module(judgeWorkerCompletionJournalModulePath, () => {
          return {
            claimOwnerJudgmentJobPrompts: async () => [{
              articleId: 'article-sglang',
              claimId: 'claim-sglang',
              executionSnapshotHash: 'snapshot-hash-sglang',
              executionSnapshotId: 'snapshot-sglang',
              jobId: 'job-sglang',
              modelBaseUrl: 'unused',
              modelId: 'model-unused',
              modelMetadataJson: null,
              modelName: 'unused',
              modelProvider: 'sglang',
              modelSecretRef: null,
              modelVersion: null,
              modelWorkerUrls: [],
              projectId: 'project-unused',
              promptId: 'prompt-sglang',
              providerConnectionId: null,
              providerMaxInflightRequests: null,
              providerUsesFamilyDefault: true,
              recordId: 'record-sglang',
              useAbstract: true,
              useFulltext: true,
              useFulltextNoImages: false,
              useTitle: true,
            }],
            getOwnerBackedJudgmentJobInfo: async () => ({
              modelBaseUrl: 'http://saved-sglang:30000/v1',
              modelId: 'model-sglang',
              modelMetadataJson: {provider: 'sglang'},
              modelName: 'Qwen/Qwen3.5-35B-A3B',
              modelProvider: 'sglang',
              modelSecretRef: null,
              modelVersion: null,
              projectId: 'project-sglang',
              providerConfigJson: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
              resolvedRuntime: ownerRuntime,
              runtimeMatchReason: 'runtime-auto-detect',
              runtimeMatchStatus: 'matched',
              runtimeResolutionMode: 'auto-detect',
              useAbstract: true,
              useFulltext: true,
              useFulltextNoImages: false,
              useTitle: true,
            }),
            recordAcceptedJudgeWorkerClaims: async (prompts) => {
              acceptedClaimCount += prompts.length
            },
            shouldUseJudgeWorkerOwnerHandoff: () => true,
          }
        })
        void mock.module(providerRuntimeMatchResolverModulePath, () => {
          return {
            resolveProviderConnectionRuntimeMatch: async () => {
              runtimeMatchCalls += 1
              throw new Error('runtime autodetect should not run for owner-backed non-Codex jobs')
            },
          }
        })
        void mock.module(providerRuntimeDetectorModulePath, () => {
          return {
            getDetectedProviderRuntimeSummaries: async () => {
              runtimeSummaryCalls += 1
              throw new Error('runtime summaries should not be read for owner-backed non-Codex jobs')
            },
            getDetectedProviderRuntimeSummary: async () => {
              runtimeSummaryCalls += 1
              throw new Error('runtime summary should not be read for owner-backed non-Codex jobs')
            },
          }
        })
        void mock.module(providerConnectionRepositoryModulePath, () => {
          return {
            listProviderConnections: async () => {
              listProviderConnectionCalls += 1
              throw new Error('provider connections should not be listed for owner-backed non-Codex jobs')
            },
          }
        })

        const {getAndUpdateReadyPrompts, getReadyPromptRuntime} = await import(readyPromptsModulePath + '?sglang-owner-backed=' + Date.now())
        const runtime = await getReadyPromptRuntime('job-sglang')
        const prompts = await getAndUpdateReadyPrompts('server-job-sglang', 'job-sglang', 1, {
          providerConnectionId: 'connection-sglang',
          providerMaxInflightRequests: 8,
          providerUsesFamilyDefault: false,
        })

        console.log(JSON.stringify({acceptedClaimCount, listProviderConnectionCalls, prompts, runtime, runtimeMatchCalls, runtimeSummaryCalls}))
      `,
    ],
    {cwd: process.cwd(), env: {...process.env, SERVER_ROLE: 'judge-worker'}},
  )

  if (runScript.exitCode !== 0) {
    throw new Error(runScript.stderr.toString() || runScript.stdout.toString() || 'owner-backed non-Codex test failed')
  }

  const result = JSON.parse(runScript.stdout.toString()) as {
    acceptedClaimCount: number
    listProviderConnectionCalls: number
    prompts: Array<{
      modelBaseUrl: string
      modelId: string
      modelProvider: string
      modelWorkerUrls: string[]
      providerConnectionId: string | null
    }>
    runtime: {modelBaseUrl: string; modelProvider: string; modelWorkerUrls: string[]}
    runtimeMatchCalls: number
    runtimeSummaryCalls: number
  }

  expect(result.runtime).toEqual({
    modelBaseUrl: 'http://owner-sglang:30000/v1',
    modelProvider: 'sglang',
    modelWorkerUrls: ['http://owner-sglang-worker:30001'],
  })
  expect(result.prompts).toHaveLength(1)
  expect(result.prompts[0]).toMatchObject({
    modelBaseUrl: 'http://owner-sglang:30000/v1',
    modelId: 'model-sglang',
    modelProvider: 'sglang',
    modelWorkerUrls: ['http://owner-sglang-worker:30001'],
    providerConnectionId: 'connection-sglang',
  })
  expect(result.acceptedClaimCount).toBe(1)
  expect(result.listProviderConnectionCalls).toBe(0)
  expect(result.runtimeMatchCalls).toBe(0)
  expect(result.runtimeSummaryCalls).toBe(0)
})
