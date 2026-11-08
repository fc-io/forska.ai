import {Database} from 'bun:sqlite'
import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {getJudgmentJobSqlitePath} from './judgmentJobPaths.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('judgment-job-sqlite-failed-closeouts')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type SqliteModule = typeof import('./judgmentJobSqliteService.ts')
type QueueClaim = Awaited<
  ReturnType<ReturnType<SqliteModule['getJudgmentJobSqliteService']>['claimReadyPrompts']>
>[number]
type FailureImportModule = typeof import('./judgmentPromptFailureImport.ts')

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let sqliteModule: SqliteModule | null = null
let failureImportModule: FailureImportModule | null = null

type SixteenPromptIds = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
]

type QueueRow = {
  claimId: string | null
  executionSnapshotHash: string | null
  executionSnapshotId: string | null
  extraRetryCount: number
  id: string
  judgedAt: string | null
  preparedClaimId: string | null
  promptId: string
  readyInsertSeq: number
  sentAt: string | null
  skipReason: string | null
  status: string
  terminalKind: string | null
}

const getSqliteModule = () => {
  if (sqliteModule === null) {
    throw new Error('SQLite service not initialized')
  }

  return sqliteModule
}

const getFailureImportModule = () => {
  if (failureImportModule === null) {
    throw new Error('Failure import not initialized')
  }

  return failureImportModule
}

const query = async <T>(statement: string) => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  return queryDatabase<T>(statement)
}

const run = async (statement: string) => {
  if (!runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(statement)
}

const createJobFixture = async (prefix: string, promptCount: number) => {
  const service = getSqliteModule().getJudgmentJobSqliteService()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const connectionId = `${prefix}-connection-${suffix}`
  const modelId = `${prefix}-model-${suffix}`
  const projectId = `${prefix}-project-${suffix}`
  const jobId = `${prefix}-job-${suffix}`
  const articleId = `${jobId}-article`
  const promptIds = Array.from({length: promptCount}, (_, index) => {
    return `${jobId}-prompt-${String(index).padStart(2, '0')}`
  })

  await run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'claude-code', 'Claude Code', TRUE, 'none', 'claude-code://cli')
  `)
  await run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'claude-opus-5-5', 'claude-opus-5-5', 'Opus 5.5', 'manual', TRUE)
  `)
  await run(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata,
      system_prompt_variant, full_text_strategy_id
    )
    VALUES ('${projectId}', '${prefix} fixture', '${modelId}', TRUE, TRUE, FALSE, FALSE, TRUE, 'screening_v5', NULL)
  `)
  await run(`INSERT INTO app.judgment_job (id, project_id, status) VALUES ('${jobId}', '${projectId}', 'running')`)
  await run(
    `INSERT INTO app.article (id, article_id, article_title) VALUES ('${articleId}', '${articleId}-x', 'Failing')`,
  )
  await run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${jobId}-project-article', '${projectId}', '${articleId}')
  `)
  await run(`
    INSERT INTO app.prompt (id, original_text) VALUES ${promptIds
      .map((promptId) => {
        return `('${promptId}', 'Prompt ${promptId}')`
      })
      .join(', ')}
  `)
  await run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled) VALUES ${promptIds
      .map((promptId, index) => {
        return `('${promptId}-project-prompt', '${projectId}', '${promptId}', ${index + 1}, TRUE)`
      })
      .join(', ')}
  `)
  await service.initializeJob(jobId)

  return {articleId, jobId, modelId, projectId, promptIds, service}
}

const getFailedRequestAttemptsJson = (input: {
  articleId: string
  claimId: string
  errorCodes: readonly (string | null)[]
  jobId: string
  promptId: string
  queueRecordId: string
}) => {
  return JSON.stringify(
    input.errorCodes.map((errorCode, index) => {
      return {
        articleId: input.articleId,
        claimId: input.claimId,
        closeoutKind: 'completion_ack',
        error: errorCode === null ? null : `Claude Code request failed: subtype=error_max_turns attempt=${index + 1}`,
        errorCode,
        finishedAt: `2026-10-27T19:40:0${index}.000Z`,
        jobId: input.jobId,
        outcome: 'failure',
        promptId: input.promptId,
        providerKey: 'provider-1',
        queueRecordId: input.queueRecordId,
        requestAttemptId: `${input.claimId}-attempt-${index}`,
        startedAt: `2026-10-27T19:39:5${index}.000Z`,
      }
    }),
  )
}

const claimAll = async (service: ReturnType<SqliteModule['getJudgmentJobSqliteService']>, jobId: string) => {
  const claims = await service.claimReadyPrompts(jobId, 'server-failed-closeouts', 100)

  return new Map(
    claims.map((claim) => {
      return [claim.promptId, claim]
    }),
  )
}

const getQueueRows = (jobId: string): QueueRow[] => {
  const database = new Database(getJudgmentJobSqlitePath(jobId), {readonly: true})

  try {
    return database
      .query(
        `
          SELECT
            id,
            prompt_id AS promptId,
            status,
            terminal_kind AS terminalKind,
            skip_reason AS skipReason,
            judged_at AS judgedAt,
            sent_at AS sentAt,
            claim_id AS claimId,
            execution_snapshot_id AS executionSnapshotId,
            execution_snapshot_hash AS executionSnapshotHash,
            prepared_claim_id AS preparedClaimId,
            extra_retry_count AS extraRetryCount,
            ready_insert_seq AS readyInsertSeq
          FROM queue_prompt
          ORDER BY prompt_id
        `,
      )
      .all() as QueueRow[]
  } finally {
    database.close(false)
  }
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    loadedSqliteModule,
    loadedFailureImportModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
    import('./judgmentPromptFailureImport.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  sqliteModule = loadedSqliteModule
  failureImportModule = loadedFailureImportModule
})

afterAll(async () => {
  await sqliteModule?.getJudgmentJobSqliteService().closeAll()
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('failure evidence names the last failed attempt and says so when no attempt failed', () => {
  const {getPromptFailureEvidence, promptFailureWithoutErrorCode, promptFailureWithoutFailedRequestCode} =
    getSqliteModule()
  const attempts = (errorCodes: (string | null)[]) => {
    return getFailedRequestAttemptsJson({
      articleId: 'article-1',
      claimId: 'claim-1',
      errorCodes,
      jobId: 'job-1',
      promptId: 'prompt-1',
      queueRecordId: 'queue-1',
    })
  }

  expect(getPromptFailureEvidence(attempts(['first_code', 'claude_code_request_failed']))).toEqual({
    attemptCount: 2,
    failedAt: '2026-10-27T19:40:01.000Z',
    failureCode: 'claude_code_request_failed',
    reason: 'Claude Code request failed: subtype=error_max_turns attempt=2',
  })
  expect(getPromptFailureEvidence(attempts([null]))).toEqual({
    attemptCount: 1,
    failedAt: '2026-10-27T19:40:00.000Z',
    failureCode: promptFailureWithoutErrorCode,
    reason: `The model call failed (${promptFailureWithoutErrorCode})`,
  })
  expect(getPromptFailureEvidence('[]')).toMatchObject({
    attemptCount: 0,
    failureCode: promptFailureWithoutFailedRequestCode,
    reason: 'The judge closed this prompt as failed without recording a failed model call',
  })
  expect(getPromptFailureEvidence(null)).toMatchObject({failureCode: promptFailureWithoutFailedRequestCode})
})

test('a resume re-offers only failed closeouts and leaves every other terminal and live row untouched', async () => {
  const {articleId, jobId, promptIds, service} = await createJobFixture('reopen', 16)
  const [
    closedFailed,
    judgedFailed,
    closedRequestFailure,
    closedArticleMissing,
    closedPromptMissing,
    closedExhausted,
    refused,
    noFulltext,
    conversionFailed,
    fulltextTooLarge,
    figureTooLarge,
    alreadyJudged,
    judgedSuccess,
    stillClaimed,
    oddSkippedOwnerFailed,
    oddCompletedOwnerFailed,
  ] = promptIds as SixteenPromptIds

  await service.addReadyPrompts(
    jobId,
    promptIds.map((promptId) => {
      return {articleId, promptId}
    }),
    'server-failed-closeouts',
  )

  const claims = await claimAll(service, jobId)
  const getClaim = (promptId: string | undefined) => {
    const claim = claims.get(promptId ?? '')

    if (!claim) {
      throw new Error(`Prompt ${promptId} was not claimed`)
    }

    return claim
  }
  const getFailedAck = (promptId: string | undefined) => {
    const claim = getClaim(promptId)

    return {
      claimId: claim.claimId,
      queuePromptId: claim.recordId,
      requestAttemptsJson: getFailedRequestAttemptsJson({
        articleId,
        claimId: claim.claimId,
        errorCodes: ['claude_code_request_failed', 'claude_code_request_failed', 'claude_code_request_failed'],
        jobId,
        promptId: claim.promptId,
        queueRecordId: claim.recordId,
      }),
      status: 'failed' as const,
    }
  }

  expect(claims.size).toBe(16)

  await service.markPromptAsClosed(
    jobId,
    getClaim(closedFailed).recordId,
    'ownerCompletionFailed',
    getFailedAck(closedFailed),
  )
  await service.markPromptAsJudged(jobId, getClaim(judgedFailed).recordId, getFailedAck(judgedFailed))
  await service.markPromptAsClosed(jobId, getClaim(closedRequestFailure).recordId, 'requestFailure')
  await service.markPromptAsClosed(jobId, getClaim(closedArticleMissing).recordId, 'articleMissing')
  await service.markPromptAsClosed(jobId, getClaim(closedPromptMissing).recordId, 'promptMissing')
  await service.markPromptAsClosed(jobId, getClaim(closedExhausted).recordId, 'recoverableRequestFailureExhausted')
  await service.markPromptAsRefused(jobId, getClaim(refused).recordId, {
    failureCode: 'claude_code_content_refusal',
    modelName: 'claude-opus-5-5',
    providerKind: 'claude-code',
    reason: 'safeguards flagged this message',
    refusedAt: '2026-11-06T06:59:13.635Z',
  })
  await service.markPromptAsSkipped(jobId, getClaim(noFulltext).recordId, 'no_fulltext')
  await service.markPromptAsSkipped(jobId, getClaim(conversionFailed).recordId, 'conversion_failed')
  await service.markPromptAsSkipped(jobId, getClaim(fulltextTooLarge).recordId, 'fulltext_too_large')
  await service.markPromptAsSkipped(jobId, getClaim(figureTooLarge).recordId, 'fulltext_figure_too_large')
  await service.markPromptAsNoRequestSuccess(jobId, getClaim(alreadyJudged).recordId, 'alreadyJudged')
  await service.markPromptAsJudged(jobId, getClaim(judgedSuccess).recordId)
  await service.markPromptAsSkipped(jobId, getClaim(oddSkippedOwnerFailed).recordId, 'no_fulltext')
  await service.markPromptAsNoRequestSuccess(jobId, getClaim(oddCompletedOwnerFailed).recordId, 'alreadyJudged')

  const writableDatabase = new Database(getJudgmentJobSqlitePath(jobId))

  writableDatabase.exec('PRAGMA busy_timeout = 5000')
  writableDatabase
    .query(`UPDATE queue_prompt SET skip_reason = 'ownerCompletionFailed' WHERE id IN (?, ?)`)
    .run(getClaim(oddSkippedOwnerFailed).recordId, getClaim(oddCompletedOwnerFailed).recordId)
  writableDatabase.close(false)

  const before = getQueueRows(jobId)
  const maxReadyInsertSeqBefore = Math.max(
    ...before.map((row) => {
      return row.readyInsertSeq
    }),
  )

  expect(
    before.map((row) => {
      return [row.promptId, row.status, row.terminalKind, row.skipReason]
    }),
  ).toEqual([
    [closedFailed, 'judged', 'closed', 'ownerCompletionFailed'],
    [judgedFailed, 'judged', 'failed', 'ownerCompletionFailed'],
    [closedRequestFailure, 'judged', 'closed', 'requestFailure'],
    [closedArticleMissing, 'judged', 'closed', 'articleMissing'],
    [closedPromptMissing, 'judged', 'closed', 'promptMissing'],
    [closedExhausted, 'judged', 'closed', 'recoverableRequestFailureExhausted'],
    [refused, 'judged', 'skipped', 'provider_refusal'],
    [noFulltext, 'judged', 'skipped', 'no_fulltext'],
    [conversionFailed, 'judged', 'skipped', 'conversion_failed'],
    [fulltextTooLarge, 'judged', 'skipped', 'fulltext_too_large'],
    [figureTooLarge, 'judged', 'skipped', 'fulltext_figure_too_large'],
    [alreadyJudged, 'judged', 'completed', 'alreadyJudged'],
    [judgedSuccess, 'judged', null, null],
    [stillClaimed, 'claimed', null, null],
    [oddSkippedOwnerFailed, 'judged', 'skipped', 'ownerCompletionFailed'],
    [oddCompletedOwnerFailed, 'judged', 'completed', 'ownerCompletionFailed'],
  ])

  expect(await service.reopenFailedCloseoutsForResume(jobId)).toBe(2)

  const after = getQueueRows(jobId)
  const reopenedIds = new Set([getClaim(closedFailed).recordId, getClaim(judgedFailed).recordId])
  const reopenedRows = after.filter((row) => {
    return reopenedIds.has(row.id)
  })

  expect(
    reopenedRows.map((row) => {
      return {...row, readyInsertSeq: row.readyInsertSeq > maxReadyInsertSeqBefore}
    }),
  ).toEqual(
    [closedFailed, judgedFailed].map((promptId) => {
      return {
        claimId: null,
        executionSnapshotHash: null,
        executionSnapshotId: null,
        extraRetryCount: 1,
        id: getClaim(promptId).recordId,
        judgedAt: null,
        preparedClaimId: null,
        promptId: promptId ?? '',
        readyInsertSeq: true,
        sentAt: null,
        skipReason: null,
        status: 'ready',
        terminalKind: null,
      }
    }),
  )
  expect(
    after.filter((row) => {
      return !reopenedIds.has(row.id)
    }),
  ).toEqual(
    before.filter((row) => {
      return !reopenedIds.has(row.id)
    }),
  )
  expect(await service.reopenFailedCloseoutsForResume(jobId)).toBe(0)
  expect(
    (
      await service.filterOutLocallyJudgedPrompts(
        jobId,
        [closedFailed, refused].map((promptId) => {
          return {articleId, promptId: promptId ?? ''}
        }),
      )
    ).map((entry) => {
      return entry.promptId
    }),
  ).toEqual([closedFailed])

  const reclaimed = await claimAll(service, jobId)

  expect([...reclaimed.keys()].toSorted()).toEqual([closedFailed, judgedFailed])
})

test('a prompt that fails again after a re-offer closes again and the next resume re-offers it once more', async () => {
  const {articleId, jobId, promptIds, service} = await createJobFixture('refail', 1)
  const [promptId = ''] = promptIds
  const failClaim = async () => {
    const claim = (await claimAll(service, jobId)).get(promptId)

    if (!claim) {
      throw new Error('Prompt was not claimed')
    }

    await service.markPromptAsClosed(jobId, claim.recordId, 'ownerCompletionFailed', {
      claimId: claim.claimId,
      queuePromptId: claim.recordId,
      requestAttemptsJson: getFailedRequestAttemptsJson({
        articleId,
        claimId: claim.claimId,
        errorCodes: ['claude_code_request_failed'],
        jobId,
        promptId,
        queueRecordId: claim.recordId,
      }),
      status: 'failed',
    })
  }

  await service.addReadyPrompts(jobId, [{articleId, promptId}], 'server-failed-closeouts')
  await failClaim()
  expect(await service.reopenFailedCloseoutsForResume(jobId)).toBe(1)
  await failClaim()

  expect(getQueueRows(jobId)).toMatchObject([
    {extraRetryCount: 1, skipReason: 'ownerCompletionFailed', status: 'judged', terminalKind: 'closed'},
  ])
  expect(await service.reopenFailedCloseoutsForResume(jobId)).toBe(1)
  expect(getQueueRows(jobId)).toMatchObject([
    {extraRetryCount: 2, skipReason: null, status: 'ready', terminalKind: null},
  ])
  expect(await service.getPendingPromptFailures(jobId, 10)).toHaveLength(2)
})

test('failed closeouts drain into app.judgment_prompt_failure, count repeat failures and append an LLM delta', async () => {
  const {articleId, jobId, modelId, projectId, promptIds, service} = await createJobFixture('failure-drain', 3)
  const [failedPrompt = '', judgedFailedPrompt = '', quietPrompt = ''] = promptIds
  const {drainJudgmentPromptFailureOutbox, importJudgmentPromptFailures} = getFailureImportModule()
  const openClaims = new Map<string, QueueClaim>()
  const takeClaim = async (promptId: string) => {
    if (!openClaims.has(promptId)) {
      ;(await claimAll(service, jobId)).forEach((claim, claimedPromptId) => {
        openClaims.set(claimedPromptId, claim)
      })
    }

    const claim = openClaims.get(promptId)

    openClaims.delete(promptId)

    if (!claim) {
      throw new Error(`Prompt ${promptId} was not claimed`)
    }

    return claim
  }
  const closeFailed = async (promptId: string, errorCode: string, via: 'closed' | 'judged') => {
    const claim = await takeClaim(promptId)

    const ack = {
      claimId: claim.claimId,
      queuePromptId: claim.recordId,
      requestAttemptsJson: getFailedRequestAttemptsJson({
        articleId,
        claimId: claim.claimId,
        errorCodes: ['claude_code_request_failed', errorCode],
        jobId,
        promptId,
        queueRecordId: claim.recordId,
      }),
      status: 'failed' as const,
    }

    await (via === 'closed'
      ? service.markPromptAsClosed(jobId, claim.recordId, 'ownerCompletionFailed', ack)
      : service.markPromptAsJudged(jobId, claim.recordId, ack))

    return claim
  }

  await service.addReadyPrompts(
    jobId,
    promptIds.map((promptId) => {
      return {articleId, promptId}
    }),
    'server-failed-closeouts',
  )

  const firstClaim = await closeFailed(failedPrompt, 'claude_code_request_failed', 'closed')
  const judgedClaim = await closeFailed(judgedFailedPrompt, 'claude_code_request_failed', 'judged')
  const quietClaim = await takeClaim(quietPrompt)

  await service.markPromptAsClosed(jobId, quietClaim.recordId, 'requestFailure')

  const jobInfo = await service.getJobInfo(jobId)
  const pending = await service.getPendingPromptFailures(jobId, 10)

  expect(
    pending
      .map((row) => {
        return row.claimId
      })
      .toSorted(),
  ).toEqual([firstClaim.claimId, judgedClaim.claimId].toSorted())
  expect(
    pending.find((row) => {
      return row.claimId === firstClaim.claimId
    }),
  ).toEqual({
    articleId,
    attemptCount: 2,
    claimId: firstClaim.claimId,
    failedAt: '2026-10-27T19:40:01.000Z',
    failureCode: 'claude_code_request_failed',
    fullTextStrategyId: 'fts-none',
    jobId,
    modelId,
    modelName: jobInfo?.modelName ?? null,
    projectId,
    promptId: failedPrompt,
    providerKind: jobInfo?.modelProvider ?? null,
    queuePromptId: firstClaim.recordId,
    reason: 'Claude Code request failed: subtype=error_max_turns attempt=2',
    systemPromptVariant: 'screening_v5',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useMetadata: true,
    useTitle: true,
  })

  expect(await service.reopenFailedCloseoutsForResume(jobId)).toBe(2)

  const secondClaim = await closeFailed(failedPrompt, 'claude_code_timeout', 'closed')

  expect(await drainJudgmentPromptFailureOutbox(jobId)).toBe(3)
  expect(await service.getPendingPromptFailures(jobId, 10)).toEqual([])
  expect(await drainJudgmentPromptFailureOutbox(jobId)).toBe(0)

  const getFailureRows = () => {
    return query<Record<string, unknown>>(`
      SELECT
        prompt_id AS promptId,
        failure_code AS failureCode,
        last_claim_id AS lastClaimId,
        attempt_count AS attemptCount,
        failure_count AS failureCount,
        judgment_job_id AS jobId,
        use_metadata AS useMetadata,
        system_prompt_variant AS systemPromptVariant,
        full_text_strategy_id AS fullTextStrategyId,
        strftime(first_failed_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S') AS firstFailedAt,
        strftime(last_failed_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S') AS lastFailedAt
      FROM app.judgment_prompt_failure
      WHERE article_id = '${articleId}'
      ORDER BY prompt_id
    `)
  }
  const expectedFailedPromptRow = {
    attemptCount: 2,
    failureCode: 'claude_code_timeout',
    failureCount: 2,
    firstFailedAt: '2026-10-27T19:40:01',
    fullTextStrategyId: 'fts-none',
    jobId,
    lastClaimId: secondClaim.claimId,
    lastFailedAt: '2026-10-27T19:40:01',
    promptId: failedPrompt,
    systemPromptVariant: 'screening_v5',
    useMetadata: true,
  }
  const expectedJudgedFailedPromptRow = {
    attemptCount: 2,
    failureCode: 'claude_code_request_failed',
    failureCount: 1,
    firstFailedAt: '2026-10-27T19:40:01',
    fullTextStrategyId: 'fts-none',
    jobId,
    lastClaimId: judgedClaim.claimId,
    lastFailedAt: '2026-10-27T19:40:01',
    promptId: judgedFailedPrompt,
    systemPromptVariant: 'screening_v5',
    useMetadata: true,
  }
  const expectedRows = [expectedFailedPromptRow, expectedJudgedFailedPromptRow]

  expect(await getFailureRows()).toEqual(expectedRows)

  expect(await service.reopenFailedCloseoutsForResume(jobId)).toBe(1)

  const thirdClaim = await closeFailed(failedPrompt, 'claude_code_request_failed', 'closed')
  const thirdBatch = await service.getPendingPromptFailures(jobId, 10)

  expect(await drainJudgmentPromptFailureOutbox(jobId)).toBe(1)
  await importJudgmentPromptFailures(jobId, thirdBatch)

  expect(await getFailureRows()).toEqual([
    {
      ...expectedFailedPromptRow,
      failureCode: 'claude_code_request_failed',
      failureCount: 3,
      lastClaimId: thirdClaim.claimId,
    },
    expectedJudgedFailedPromptRow,
  ])
  expect(
    await query<{count: number}>(
      `SELECT CAST(COUNT(*) AS INTEGER) AS count FROM app.judgment WHERE article_id = '${articleId}'`,
    ),
  ).toEqual([{count: 0}])
  expect(
    await query<{changeKind: string; projectId: string; promptId: string; sourcePartition: string}>(`
      SELECT DISTINCT
        change_kind AS changeKind,
        project_id AS projectId,
        prompt_id AS promptId,
        source_partition AS sourcePartition
      FROM app.review_change_delta
      WHERE source_table = 'app.judgment_prompt_failure' AND article_id = '${articleId}'
      ORDER BY prompt_id
    `),
  ).toEqual(
    [failedPrompt, judgedFailedPrompt].map((promptId) => {
      return {changeKind: 'judgment.llm.updated', projectId, promptId, sourcePartition: `llmJudgment:${articleId}`}
    }),
  )
})
