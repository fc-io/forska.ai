import type {JudgmentChunkingStrategy} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../../server/services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../server/services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../server/services/getDuckdbMartRefreshService.ts'
import {getShortIdForPrompt, type ShortIdMapping} from './judgeGetPrompt.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'

const findAnswer = <T>(entries: [string, unknown][], fragment: string): T => {
  const match = entries.find(([key]) => {
    return key.includes(fragment)
  })

  if (!match) {
    throw new Error(`Missing ${fragment} answer`)
  }

  return match[1] as T
}

// Helper that stores a validated judgment via RPC to our server and logs the outcome
export const judgeStoreJudgment = async (
  articleId: string,
  articleTitle: string,
  judgment: Record<string, unknown>,
  modelId: string,
  promptIds: string[] | undefined,
  projectId: string | undefined,
  shortIdMapping: ShortIdMapping,
  chunkingStrategy: JudgmentChunkingStrategy | null = null,
): Promise<void> => {
  try {
    if (!modelId || !promptIds || promptIds.length === 0) {
      console.error('Warning: No modelId/promptIds provided, judgment not stored to database')
      return
    }
    // Prepare snapshot context (best-effort)
    const [projectRow] =
      projectId && projectId.length > 0
        ? await getAppDatabaseService().queryJson<{
            id: string
            useTitle: boolean
            useAbstract: boolean
            useFulltext: boolean
          }>(`
            SELECT id, use_title AS useTitle, use_abstract AS useAbstract, use_fulltext AS useFulltext
            FROM app.project
            WHERE id = '${escapeSqlString(projectId)}'
            LIMIT 1
          `)
        : [null]
    const [modelRow] = await getAppDatabaseService().queryJson<{modelName: string | null; provider: string | null}>(`
      SELECT
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
        pc.provider_kind AS provider
      FROM app.model m
      LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
      WHERE m.id = '${escapeSqlString(modelId)}'
      LIMIT 1
    `)
    const snapshotValues = {
      snapshotProjectId: projectRow?.id ?? null,
      snapshotProjectModelName: modelRow?.modelName ?? null,
    } as const
    // Store judgment for each prompt
    const storePromises = promptIds.map(async (promptId) => {
      // Use short ID to find the answers in the judgment object
      const shortId = getShortIdForPrompt(promptId, shortIdMapping)
      const answers = Object.entries(judgment).filter(([key]) => {
        return key.includes(shortId)
      })
      const answeredOriginal = findAnswer<string>(answers, '---question')
      const answeredExplanation = findAnswer<string>(answers, '---explanation')
      const answeredQuotes = findAnswer<string[]>(answers, '---quotes')
      // console.log('answeredOriginal', typeof answeredOriginal)
      // console.log(answeredOriginal)
      const answeredOriginalAsArray = judgeStoreJudgmentGetStringAsArrayOfStrings(answeredOriginal)
      // console.log('answeredOriginalAsArray', typeof answeredOriginalAsArray)
      // console.log(answeredOriginalAsArray)
      // ('test^^^a7aa21e8-d4e6-4e60-b39e-732085c56b00---explanation')
      // "test^^^a7aa21e8-d4e6-4e60-b39e-732085c56b00---quotes"
      const existing = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment
        WHERE article_id = '${escapeSqlString(articleId)}'
          AND model_id = '${escapeSqlString(modelId)}'
          AND prompt_id = '${escapeSqlString(promptId)}'
        LIMIT 1
      `)

      const existingRow = existing[0]
      if (existingRow) {
        const existingId = existingRow.id
        const [updated] = await getAppDatabaseService().queryJson<{id: string}>(`
          UPDATE app.judgment
          SET is_answered = TRUE,
              answered_original = ${getSqlLiteral(answeredOriginal)},
              answered_original_as_array = ${getSqlLiteral(answeredOriginalAsArray)},
              confidence_original = 50,
              explanation = ${getSqlLiteral(answeredExplanation || null)},
              quotes = ${getSqlLiteral(answeredQuotes)},
              chunking_strategy = ${getSqlLiteral(chunkingStrategy)},
              updated_at = current_timestamp
          WHERE id = '${escapeSqlString(existingId)}'
          RETURNING id
        `)
        return updated
      }

      const [inserted] = await getAppDatabaseService().queryJson<{id: string}>(`
        INSERT INTO app.judgment (
          id,
          article_id,
          model_id,
          prompt_id,
          is_answered,
          answered_original,
          answered_original_as_array,
          confidence_original,
          explanation,
          quotes,
          chunking_strategy,
          snapshot_project_id,
          snapshot_project_model_name
        )
        VALUES (
          '${escapeSqlString(crypto.randomUUID())}',
          '${escapeSqlString(articleId)}',
          '${escapeSqlString(modelId)}',
          '${escapeSqlString(promptId)}',
          TRUE,
          ${getSqlLiteral(answeredOriginal)},
          ${getSqlLiteral(answeredOriginalAsArray)},
          50,
          ${getSqlLiteral(answeredExplanation || null)},
          ${getSqlLiteral(answeredQuotes)},
          ${getSqlLiteral(chunkingStrategy)},
          ${getSqlLiteral(snapshotValues.snapshotProjectId)},
          ${getSqlLiteral(snapshotValues.snapshotProjectModelName)}
        )
        RETURNING id
      `)
      return inserted
    })
    // why is this here?
    const results = await Promise.allSettled(storePromises)
    const successfulResults = results.filter((result): result is PromiseFulfilledResult<{id: string} | undefined> => {
      return result.status === 'fulfilled'
    })

    const failedResults = results.filter((r): r is PromiseRejectedResult => {
      return r.status === 'rejected'
    })

    if (successfulResults.length > 0) {
      await getDuckdbMartRefreshService().queueJudgmentArticleRefresh(articleId, 'judgeStoreJudgment')
    }

    if (failedResults.length > 0) {
      console.error(
        `${articleId} | Failed to store ${failedResults.length} judgment(s) for article ${articleTitle}`,
        failedResults[0]?.reason,
      )
    }
  } catch (error) {
    console.error(
      `${articleId} | Failed to store judgment for article ${articleTitle}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}
