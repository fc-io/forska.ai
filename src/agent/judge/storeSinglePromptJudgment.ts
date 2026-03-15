import {randomUUID} from 'crypto'

import {articles, judgments} from '../../db/schema.ts'
import {getAppDatabaseService} from '../../server/services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../server/services/appQueryHelpers.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'
import type {SinglePromptJudgmentResult} from './parseSinglePromptJudgment.ts'

/**
 * Stores a judgment for a single prompt.
 * Simplified version of judgeStoreJudgment for single-prompt processing.
 */
export const storeSinglePromptJudgment = async ({
  article,
  promptId,
  modelId,
  projectId,
  judgment,
  chunkingStrategy,
}: {
  article: typeof articles.$inferSelect
  promptId: string
  modelId: string
  projectId: string
  judgment: SinglePromptJudgmentResult
  chunkingStrategy: (typeof judgments.$inferInsert)['chunkingStrategy']
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
      SELECT model_name AS modelName, provider
      FROM app.model
      WHERE id = '${escapeSqlString(modelId)}'
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

    const id = randomUUID()
    const createdAt = new Date()

    await getAppDatabaseService().run(`
      INSERT INTO app.judgment (
        id,
        created_at,
        updated_at,
        article_id,
        model_id,
        prompt_id,
        project_id,
        is_answered,
        answered_original,
        answered_original_as_array,
        confidence_original,
        explanation,
        quotes,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        chunking_strategy,
        snapshot_project_id,
        snapshot_project_model_name
      )
      VALUES (
        '${escapeSqlString(id)}',
        ${getSqlLiteral(createdAt)},
        ${getSqlLiteral(createdAt)},
        '${escapeSqlString(article.id)}',
        '${escapeSqlString(modelId)}',
        '${escapeSqlString(promptId)}',
        '${escapeSqlString(projectId)}',
        TRUE,
        ${getSqlLiteral(answeredOriginal)},
        ${getSqlLiteral(answeredOriginalAsArray)},
        50,
        ${getSqlLiteral(answeredExplanation || null)},
        ${getSqlLiteral(answeredQuotes)},
        ${useTitle ? 'TRUE' : 'FALSE'},
        ${useAbstract ? 'TRUE' : 'FALSE'},
        ${useFulltext ? 'TRUE' : 'FALSE'},
        ${useFulltextNoImages ? 'TRUE' : 'FALSE'},
        ${getSqlLiteral(chunkingStrategy)},
        ${getSqlLiteral(snapshotValues.snapshotProjectId)},
        ${getSqlLiteral(snapshotValues.snapshotProjectModelName)}
      )
    `)
  } catch (error) {
    console.error(
      `${article.id} | Failed to store judgment for prompt ${promptId}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
    throw error
  }
}
