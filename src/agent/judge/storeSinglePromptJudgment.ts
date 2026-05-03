import {randomUUID} from 'crypto'

import type {ArticleRecord, JudgmentChunkingStrategy} from '../../db/schemaTypes.ts'
import {
  enqueueJudgeWorkerCompletion,
  shouldUseJudgeWorkerOwnerHandoff,
} from '../../server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteService} from '../../server/cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {
  type JudgmentRequestAttemptJsonEntry,
  stringifyRequestAttempts,
  withDurableCloseoutRef,
} from '../../server/cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'
import {
  compactClosedOutRequestAttemptManifestEntries,
  recordRequestAttemptsEnteringPersistence,
} from '../../server/cron/judgmentsJobs/judgmentRequestAttemptManifestStore.ts'
import {getAppDatabaseService} from '../../server/services/appDatabaseService.ts'
import {escapeSqlString} from '../../server/services/appQueryHelpers.ts'
import type {ContentSettings} from './judgeGetPrompt.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'
import type {SinglePromptJudgmentResult} from './parseSinglePromptJudgment.ts'

export class JudgmentPersistenceError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'JudgmentPersistenceError'
  }
}

const enqueueOwnerBackedCompletion = async ({
  article,
  claimIdentity,
  contentSettings,
  judgmentsJobId,
  promptId,
  queueRecordId,
  modelId,
  projectId,
  snapshotProjectModelName: _snapshotProjectModelName,
  judgment,
  chunkingStrategy,
  requestAttempts = [],
}: {
  article: ArticleRecord
  claimIdentity?: {claimId: string; executionSnapshotHash: string; executionSnapshotId: string}
  contentSettings: ContentSettings
  judgmentsJobId: string
  promptId: string
  queueRecordId: string
  modelId: string
  projectId: string
  snapshotProjectModelName?: string | null
  judgment: SinglePromptJudgmentResult
  chunkingStrategy: JudgmentChunkingStrategy | null
  requestAttempts?: JudgmentRequestAttemptJsonEntry[]
}): Promise<void> => {
  if (!claimIdentity) {
    throw new JudgmentPersistenceError(`Missing owner-backed claim identity for ${judgmentsJobId}:${queueRecordId}`)
  }

  const rawAnswer = judgment.answer
  const answeredOriginal = Array.isArray(rawAnswer) ? JSON.stringify(rawAnswer) : rawAnswer
  const answeredOriginalAsArray = judgeStoreJudgmentGetStringAsArrayOfStrings(rawAnswer) ?? []
  const judgmentId = randomUUID()
  const completionRequestAttempts = withDurableCloseoutRef({
    closeoutKind: 'completion_outbox',
    ref: {claimId: claimIdentity.claimId, jobId: judgmentsJobId, queueRecordId},
    requestAttempts,
  })

  await recordRequestAttemptsEnteringPersistence(requestAttempts)
  await enqueueJudgeWorkerCompletion({
    answeredOriginal,
    answeredOriginalAsArray,
    articleId: article.id,
    chunkingStrategy,
    claimId: claimIdentity.claimId,
    confidenceOriginal: 50,
    executionSnapshotHash: claimIdentity.executionSnapshotHash,
    executionSnapshotId: claimIdentity.executionSnapshotId,
    explanation: judgment.explanation || null,
    isAnswered: true,
    jobId: judgmentsJobId,
    judgment,
    judgmentId,
    modelId,
    projectId,
    promptId,
    queueRecordId,
    quotes: judgment.quotes,
    rawResponseJson: judgment,
    requestAttempts: completionRequestAttempts,
    status: 'judged',
    useAbstract: contentSettings.useAbstract,
    useFulltext: contentSettings.useFulltext,
    useFulltextNoImages: contentSettings.useFulltextNoImages,
    useTitle: contentSettings.useTitle,
  })
  await compactClosedOutRequestAttemptManifestEntries(completionRequestAttempts)
}

export const storeSinglePromptJudgment = async ({
  article,
  claimIdentity,
  contentSettings = {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
  judgmentsJobId,
  promptId,
  queueRecordId,
  modelId,
  projectId,
  snapshotProjectModelName = null,
  judgment,
  chunkingStrategy,
  requestAttempts = [],
}: {
  article: ArticleRecord
  claimIdentity?: {claimId: string; executionSnapshotHash: string; executionSnapshotId: string}
  contentSettings?: ContentSettings
  judgmentsJobId: string
  promptId: string
  queueRecordId: string
  modelId: string
  projectId: string
  snapshotProjectModelName?: string | null
  judgment: SinglePromptJudgmentResult
  chunkingStrategy: JudgmentChunkingStrategy | null
  requestAttempts?: JudgmentRequestAttemptJsonEntry[]
}): Promise<void> => {
  try {
    if (shouldUseJudgeWorkerOwnerHandoff()) {
      await enqueueOwnerBackedCompletion({
        article,
        claimIdentity,
        contentSettings,
        judgmentsJobId,
        promptId,
        queueRecordId,
        modelId,
        projectId,
        snapshotProjectModelName,
        judgment,
        chunkingStrategy,
        requestAttempts,
      })
      return
    }

    const snapshotValues = {snapshotProjectId: projectId, snapshotProjectModelName} as const
    const useTitle = contentSettings.useTitle
    const useAbstract = contentSettings.useAbstract
    const useFulltext = contentSettings.useFulltext
    const useFulltextNoImages = contentSettings.useFulltextNoImages

    const rawAnswer = judgment.answer
    const answeredOriginal = Array.isArray(rawAnswer) ? JSON.stringify(rawAnswer) : rawAnswer
    const answeredOriginalAsArray = judgeStoreJudgmentGetStringAsArrayOfStrings(rawAnswer)
    const answeredExplanation = judgment.explanation
    const answeredQuotes = judgment.quotes

    // Check if judgment already exists (must match full unique constraint including content config)
    const existing = await getAppDatabaseService().queryJson<{id: string; createdAt: string}>(`
      SELECT id, created_at AS createdAt
      FROM app.judgment
      WHERE article_id = '${escapeSqlString(article.id)}'
        AND model_id = '${escapeSqlString(modelId)}'
        AND prompt_id = '${escapeSqlString(promptId)}'
        AND use_title = ${useTitle ? 'TRUE' : 'FALSE'}
        AND use_abstract = ${useAbstract ? 'TRUE' : 'FALSE'}
        AND use_fulltext = ${useFulltext ? 'TRUE' : 'FALSE'}
        AND use_fulltext_no_images = ${useFulltextNoImages ? 'TRUE' : 'FALSE'}
        AND deleted_at IS NULL
      LIMIT 1
    `)

    const existingId = existing[0]?.id ?? null
    const existingCreatedAt = existing[0]?.createdAt ?? null

    if (existingId) {
      // Immutable judgments: if it already exists, do not update.
      // To re-judge, the user must delete the existing judgment first.
      console.error(
        `${article.id} | Judgment already exists: promptId=${promptId}, modelId=${modelId}, `
          + `content=[T:${useTitle},A:${useAbstract},F:${useFulltext},FNI:${useFulltextNoImages}], `
          + `projectId=${projectId}, existingId=${existingId}, createdAt=${existingCreatedAt ?? 'unknown'}`,
      )
      return
    }

    const sqliteService = getJudgmentJobSqliteService()

    if (!sqliteService.hasJob(judgmentsJobId)) {
      throw new JudgmentPersistenceError(`Missing SQLite job state for ${judgmentsJobId}`)
    }

    try {
      const judgmentId = randomUUID()
      const localRequestAttempts = withDurableCloseoutRef({
        closeoutKind: 'judgment_outbox',
        ref: {id: judgmentId, jobId: judgmentsJobId, queueRecordId},
        requestAttempts,
      })
      await recordRequestAttemptsEnteringPersistence(requestAttempts)
      const persisted = await sqliteService.recordJudgmentSuccess(judgmentsJobId, {
        answeredOriginal,
        answeredOriginalAsArray: answeredOriginalAsArray ?? [],
        articleId: article.id,
        claimId: claimIdentity?.claimId,
        chunkingStrategy,
        confidenceOriginal: 50,
        createdAt: new Date(),
        explanation: answeredExplanation || null,
        executionSnapshotHash: claimIdentity?.executionSnapshotHash,
        executionSnapshotId: claimIdentity?.executionSnapshotId,
        isAnswered: true,
        judgmentId,
        modelId,
        projectId,
        promptId,
        queuePromptId: queueRecordId,
        quotes: answeredQuotes,
        rawResponseJson: judgment,
        requestAttemptsJson: stringifyRequestAttempts(localRequestAttempts),
        snapshotProjectId: snapshotValues.snapshotProjectId,
        snapshotProjectModelName: snapshotValues.snapshotProjectModelName,
        updatedAt: new Date(),
        useAbstract,
        useFulltext,
        useFulltextNoImages,
        useTitle,
      })

      if (persisted === null) {
        throw new Error('SQLite judgment job database is unavailable')
      }

      await compactClosedOutRequestAttemptManifestEntries(localRequestAttempts)
    } catch (error) {
      throw new JudgmentPersistenceError(`Failed to persist SQLite judgment for ${article.id}:${promptId}`, {
        cause: error,
      })
    }
  } catch (error) {
    console.error(
      `${article.id} | Failed to store judgment for prompt ${promptId}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
    throw error
  }
}
