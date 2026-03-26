import {randomUUID} from 'crypto'

import type {ArticleRecord, JudgmentChunkingStrategy} from '../../db/schemaTypes.ts'
import {getJudgmentJobSqliteService} from '../../server/cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getAppDatabaseService} from '../../server/services/appDatabaseService.ts'
import {escapeSqlString} from '../../server/services/appQueryHelpers.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'
import type {SinglePromptJudgmentResult} from './parseSinglePromptJudgment.ts'

export class JudgmentPersistenceError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'JudgmentPersistenceError'
  }
}

export const storeSinglePromptJudgment = async ({
  article,
  judgmentsJobId,
  promptId,
  queueRecordId,
  modelId,
  projectId,
  judgment,
  chunkingStrategy,
}: {
  article: ArticleRecord
  judgmentsJobId: string
  promptId: string
  queueRecordId: string
  modelId: string
  projectId: string
  judgment: SinglePromptJudgmentResult
  chunkingStrategy: JudgmentChunkingStrategy | null
}): Promise<void> => {
  try {
    // Prepare snapshot context (best-effort, only fetching fields we still store)
    const [projectRow] = await getAppDatabaseService().queryJson<{
      id: string
      useTitle: boolean
      useAbstract: boolean
      useFulltext: boolean
      useFulltextNoImages: boolean
    }>(`
      SELECT
        id,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages
      FROM app.project
      WHERE id = '${escapeSqlString(projectId)}'
      LIMIT 1
    `)

    const [modelRow] = await getAppDatabaseService().queryJson<{modelName: string | null; provider: string | null}>(`
      SELECT
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
        pc.provider_kind AS provider
      FROM app.model m
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE m.id = '${escapeSqlString(modelId)}'
      LIMIT 1
    `)

    const useTitle = projectRow?.useTitle ?? true
    const useAbstract = projectRow?.useAbstract ?? true
    const useFulltext = projectRow?.useFulltext ?? false
    const useFulltextNoImages = projectRow?.useFulltextNoImages ?? false

    const snapshotValues = {
      snapshotProjectId: projectRow?.id ?? null,
      snapshotProjectModelName: modelRow?.modelName ?? null,
    } as const

    const rawAnswer = judgment.answer
    // Serialize array answers to JSON for the text column
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
      const persisted = await sqliteService.recordJudgmentSuccess(judgmentsJobId, {
        answeredOriginal,
        answeredOriginalAsArray: answeredOriginalAsArray ?? [],
        articleId: article.id,
        chunkingStrategy,
        confidenceOriginal: 50,
        createdAt: new Date(),
        explanation: answeredExplanation || null,
        isAnswered: true,
        judgmentId: randomUUID(),
        modelId,
        projectId,
        promptId,
        queuePromptId: queueRecordId,
        quotes: answeredQuotes,
        rawResponseJson: judgment,
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
