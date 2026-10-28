import {Database} from 'bun:sqlite'
import {afterAll, afterEach, beforeAll, expect, mock, setDefaultTimeout, setSystemTime, test} from 'bun:test'
import {Elysia} from 'elysia'

import type {PromptToProcess} from '../cron/judgmentsJobs/judgmentsJobsSendToLLM/getAndUpdateReadyPrompts.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-judgments-jobs-pause-dispatch')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const providerRuntimeModelGuardModulePath = new URL('../providers/providerRuntimeModelGuard.ts', import.meta.url).href
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href
const judgeWorkerId = 'judge-worker-pause'
const staleClaimWindowMs = 120_000

type TestDatabase = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
type OwnerResponse = {body: {data?: {jobIds?: string[]; status?: string}} | string; status: number}
type OwnerClaim = Pick<
  PromptToProcess,
  | 'articleId'
  | 'claimId'
  | 'executionSnapshotHash'
  | 'executionSnapshotId'
  | 'modelId'
  | 'projectId'
  | 'promptId'
  | 'recordId'
  | 'useAbstract'
  | 'useFulltext'
  | 'useFulltextNoImages'
  | 'useMetadata'
  | 'useTitle'
>

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: TestDatabase | null = null
let closeDatabase: (() => Promise<void>) | null = null

const getApp = () => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  return app
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  return database
}

beforeAll(async () => {
  void mock.module(providerRuntimeModelGuardModulePath, () => {
    return {
      assertStoredProviderModelRuntimeMatch: async () => {
        return undefined
      },
      getStoredProviderModelRuntimeMatch: async () => {
        return {message: null, ok: true, reason: null}
      },
    }
  })
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    const getTestReadOnlyDatabase = () => {
      return {
        queryJson: <T>(statement: string) => {
          return getDatabase().queryJson<T>(statement)
        },
      }
    }

    return {
      closeAppReadOnlyDatabaseServices: async () => {
        return undefined
      },
      getApiReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
      getJudgeWorkerReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
    }
  })

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])
  const {judgmentsJobsRoutes} = (await import(
    `./JudgmentsJobsRoutes.ts?pause-dispatch=${Date.now()}`
  )) as typeof import('./JudgmentsJobsRoutes.ts')

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const appDatabase = getAppDatabaseService()

  database = appDatabase
  closeDatabase = () => {
    return appDatabase.close()
  }
  app = new Elysia().use(judgmentsJobsRoutes)
})

afterEach(async () => {
  setSystemTime()
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')

  await getJudgmentJobSqliteService().closeAll()
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
  mock.restore()
})

const createSignal = () => {
  let resolve: () => void = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {promise, resolve}
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const waitFor = async (condition: () => boolean, remainingAttempts = 500): Promise<void> => {
  if (condition() || remainingAttempts <= 0) {
    return
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
  await waitFor(condition, remainingAttempts - 1)
}

const postToOwner = async (path: string, body: unknown): Promise<OwnerResponse> => {
  const response = await getApp().handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const text = await response.text()

  return {body: response.ok ? (JSON.parse(text) as OwnerResponse['body']) : text, status: response.status}
}

const getOwnerResponseStatus = (response: OwnerResponse) => {
  return typeof response.body === 'string' ? response.body : response.body.data?.status
}

const createRunningJobWithClaims = async ({prefix, promptCount}: {prefix: string; promptCount: number}) => {
  const {getJudgmentJobSqliteService} = await import('../cron/judgmentsJobs/judgmentJobSqliteService.ts')
  const sqliteService = getJudgmentJobSqliteService()
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const db = getDatabase()

  await db.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await db.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE,
      '{"discovery":{"contextWindow":{"inputTokens":32768,"outputTokens":null,"totalTokens":32768}}}')
  `)
  await db.run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Pause Dispatch Project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await db.run(`
    INSERT INTO app.judgment_job (id, project_id, status, storage_state)
    VALUES ('${jobId}', '${projectId}', 'running', 'active')
  `)
  await sqliteService.initializeJob(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    Array.from({length: promptCount}, (_value, index) => {
      return {articleId: `${suffix}-article-${index}`, promptId: `${suffix}-prompt`}
    }),
    'server-a',
  )

  const claimResponse = await postToOwner(`/api/judgmentsjobs/${jobId}/claims`, {
    claimedBy: judgeWorkerId,
    limit: promptCount,
  })
  const claims =
    typeof claimResponse.body === 'string'
      ? []
      : ((claimResponse.body.data as {claims?: OwnerClaim[]} | undefined)?.claims ?? [])

  if (claims.length !== promptCount) {
    throw new Error(`Expected ${promptCount} owner claims for ${jobId}, got ${claims.length}`)
  }

  return {claims, connectionId, jobId, sqliteService}
}

const getDispatchPrompt = ({
  claim,
  connectionId,
  jobId,
}: {
  claim: OwnerClaim
  connectionId: string
  jobId: string
}): PromptToProcess => {
  return {
    ...claim,
    fullTextStrategyId: 'fts-none',
    jobId,
    modelBaseUrl: 'http://runtime.test/v1',
    modelMetadataJson: null,
    modelName: 'Qwen/Qwen3.5-122B-A10B',
    modelProvider: 'sglang',
    modelSecretRef: null,
    modelVersion: null,
    modelWorkerUrls: [],
    providerConnectionId: connectionId,
    providerKey: `pause-dispatch:${connectionId}`,
    providerMaxInflightRequests: 1,
    providerPromptBacklogTarget: 8,
    providerUsesFamilyDefault: false,
  }
}

const getSuccessCompletionBody = (prompt: PromptToProcess) => {
  return {
    articleId: prompt.articleId,
    claimId: prompt.claimId,
    executionSnapshotHash: prompt.executionSnapshotHash,
    executionSnapshotId: prompt.executionSnapshotId,
    jobId: prompt.jobId,
    judgment: {answer: 'yes', explanation: 'paid call finished after the pause', quotes: []},
    modelId: prompt.modelId,
    projectId: prompt.projectId,
    promptId: prompt.promptId,
    queueRecordId: prompt.recordId,
    useAbstract: prompt.useAbstract,
    useFulltext: prompt.useFulltext,
    useFulltextNoImages: prompt.useFulltextNoImages,
    useMetadata: prompt.useMetadata,
    useTitle: prompt.useTitle,
  }
}

const getRecordIds = (prompts: PromptToProcess[]) => {
  return prompts.map((prompt) => {
    return prompt.recordId
  })
}

const readQueueStatuses = async (jobId: string, recordIds: string[]) => {
  const {getJudgmentJobSqlitePath} = await import('../cron/judgmentsJobs/judgmentJobPaths.ts')
  const jobDatabase = new Database(getJudgmentJobSqlitePath(jobId), {readonly: true})
  const rows = jobDatabase
    .query(
      `
        SELECT id, status, claim_id AS claimId
        FROM queue_prompt
        WHERE id IN (${recordIds
          .map(() => {
            return '?'
          })
          .join(', ')})
      `,
    )
    .all(...recordIds) as Array<{claimId: string | null; id: string; status: string}>

  jobDatabase.close(false)

  return recordIds.map((recordId) => {
    const row = rows.find((candidate) => {
      return candidate.id === recordId
    })

    return {claimed: Boolean(row?.claimId), status: row?.status ?? 'missing'}
  })
}

const pauseJob = async (jobId: string) => {
  const response = await getApp().handle(
    new Request(`http://localhost/api/judgmentsjobs/${jobId}`, {
      body: JSON.stringify({status: 'paused'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  return response.status
}

test('without the judge heartbeat the owner requeues the claims of a paused job after the stale-claim window', async () => {
  const {claims, jobId, sqliteService} = await createRunningJobWithClaims({
    prefix: 'pause-no-heartbeat',
    promptCount: 2,
  })

  expect(await pauseJob(jobId)).toBe(200)

  setSystemTime(new Date(Date.now() + staleClaimWindowMs))

  expect(
    await sqliteService.requeueAbandonedSentPrompts({
      jobId,
      serverJobId: 'owner-cleanup',
      staleBefore: new Date(Date.now() - 30_000),
    }),
  ).toBe(claims.length)
})

test('pausing a job stops new LLM calls from the judge backlog, returns it to ready and acks in-flight completions', async () => {
  const [{createJudgmentDispatchRuntime}, {getJudgeWorkerClaimReleasePayload}, sendToLLM] = await Promise.all([
    import('../cron/judgmentsJobs/judgmentDispatchRuntime.ts'),
    import('../cron/judgmentsJobs/judgeWorkerCompletionJournal.ts'),
    import('../cron/judgmentsJobs/judgmentsJobsSendToLLM.ts'),
  ])
  const {claims, connectionId, jobId, sqliteService} = await createRunningJobWithClaims({
    prefix: 'pause-dispatch',
    promptCount: 6,
  })
  const prompts = claims.map((claim) => {
    return getDispatchPrompt({claim, connectionId, jobId})
  })
  const inFlightPrompts = prompts.slice(0, 2)
  const backlogPrompts = prompts.slice(2)
  const llmCallReleases = new Map(
    prompts.map((prompt) => {
      return [prompt.recordId, createSignal()] as const
    }),
  )
  const startedLlmCalls: string[] = []
  const completionResponses: OwnerResponse[] = []
  const releaseResponses: OwnerResponse[] = []
  const runtime = createJudgmentDispatchRuntime({
    processPrompt: async ({prompt}) => {
      startedLlmCalls.push(prompt.recordId)
      await llmCallReleases.get(prompt.recordId)?.promise
      completionResponses.push(
        await postToOwner(`/api/judgmentsjobs/${jobId}/completions`, getSuccessCompletionBody(prompt)),
      )
    },
    recoverPrompts: async (releasedPrompts) => {
      const responses = await Promise.all(
        releasedPrompts.map((prompt) => {
          return postToOwner(`/api/judgmentsjobs/${jobId}/completions`, getJudgeWorkerClaimReleasePayload(prompt))
        }),
      )

      releaseResponses.push(...responses)
    },
  })

  expect(await runtime.enqueueClaimedPrompts({label: 'pause-dispatch', prompts})).toEqual({
    acceptedCount: 6,
    rejectedPrompts: [],
  })
  await flush()

  expect(startedLlmCalls).toEqual(getRecordIds(inFlightPrompts))

  expect(await pauseJob(jobId)).toBe(200)

  const runtimeRouteResponse = await getApp().handle(new Request(`http://localhost/api/judgmentsjobs/${jobId}/runtime`))

  expect(await runtimeRouteResponse.json()).toEqual({data: {job: null}, error: null})
  expect(
    await sendToLLM.stopDispatchForNonRunningJobs({
      getDispatchJobStates: runtime.getDispatchJobStates,
      runningJobIds: [],
      stopJobDispatch: runtime.stopJobDispatch,
    }),
  ).toEqual([{jobId, releasedCount: backlogPrompts.length}])

  expect(releaseResponses.map(getOwnerResponseStatus)).toEqual(
    backlogPrompts.map(() => {
      return 'retry'
    }),
  )
  expect(
    releaseResponses.map((response) => {
      return response.status
    }),
  ).toEqual(
    backlogPrompts.map(() => {
      return 200
    }),
  )
  expect(await readQueueStatuses(jobId, getRecordIds(backlogPrompts))).toEqual(
    backlogPrompts.map(() => {
      return {claimed: false, status: 'ready'}
    }),
  )

  setSystemTime(new Date(Date.now() + staleClaimWindowMs))

  const heartbeatJobIds = sendToLLM.getOwnerBackedWorkerHeartbeatJobIds({
    dispatchJobStates: await runtime.getDispatchJobStates(),
    heldJobIds: [],
    runningJobIds: [],
  })
  const heartbeatResponse = await postToOwner('/api/judgmentsjobs-worker-heartbeats', {
    claimedBy: judgeWorkerId,
    jobIds: heartbeatJobIds,
  })

  expect(heartbeatJobIds).toEqual([jobId])
  expect(typeof heartbeatResponse.body === 'string' ? null : heartbeatResponse.body.data?.jobIds).toEqual([jobId])
  expect(
    await sqliteService.requeueAbandonedSentPrompts({
      jobId,
      serverJobId: 'owner-cleanup',
      staleBefore: new Date(Date.now() - 30_000),
    }),
  ).toBe(0)

  inFlightPrompts.forEach((prompt) => {
    llmCallReleases.get(prompt.recordId)?.resolve()
  })
  await waitFor(() => {
    return completionResponses.length === inFlightPrompts.length
  })
  await flush()

  expect(startedLlmCalls).toEqual(getRecordIds(inFlightPrompts))
  expect(
    completionResponses.map((response) => {
      return [response.status, getOwnerResponseStatus(response)]
    }),
  ).toEqual(
    inFlightPrompts.map(() => {
      return [200, 'judged']
    }),
  )
  expect(await runtime.getDispatchPromptRefs()).toEqual([])

  await runtime.shutdown('test-complete')
})
