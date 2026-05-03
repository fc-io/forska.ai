import type {JudgmentChunkingStrategy} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../../server/services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../server/services/appQueryHelpers.ts'
import {getProjectMartDirtyRefreshStateService} from '../../server/services/projectMartDirtyRefreshStateService.ts'
import {getShortIdForPrompt, type ShortIdMapping} from './judgeGetPrompt.ts'
import {judgeStoreJudgmentGetStringAsArrayOfStrings} from './judgeStoreJudgment/judgeStoreJudgmentGetStringAsArrayOfStrings.ts'

type JudgmentStoreRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

const findAnswer = <T>(entries: [string, unknown][], fragment: string): T => {
  const match = entries.find(([key]) => {
    return key.includes(fragment)
  })

  if (!match) {
    throw new Error(`Missing ${fragment} answer`)
  }

  return match[1] as T
}

const storeJudgmentForPrompt = async ({
  articleId,
  chunkingStrategy,
  judgment,
  modelId,
  promptId,
  runner,
  shortIdMapping,
  snapshotProjectId,
  snapshotProjectModelName,
}: {
  articleId: string
  chunkingStrategy: JudgmentChunkingStrategy | null
  judgment: Record<string, unknown>
  modelId: string
  promptId: string
  runner: JudgmentStoreRunner
  shortIdMapping: ShortIdMapping
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
}) => {
  const shortId = getShortIdForPrompt(promptId, shortIdMapping)
  const answers = Object.entries(judgment).filter(([key]) => {
    return key.includes(shortId)
  })
  const answeredOriginal = findAnswer<string>(answers, '---question')
  const answeredExplanation = findAnswer<string>(answers, '---explanation')
  const answeredQuotes = findAnswer<string[]>(answers, '---quotes')
  const answeredOriginalAsArray = judgeStoreJudgmentGetStringAsArrayOfStrings(answeredOriginal)
  const existing = await runner.queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment
    WHERE article_id = ${getSqlLiteral(articleId)}
      AND model_id = ${getSqlLiteral(modelId)}
      AND prompt_id = ${getSqlLiteral(promptId)}
    LIMIT 1
  `)
  const existingId = existing[0]?.id ?? null

  return existingId
    ? (
        await runner.queryJson<{id: string}>(`
          UPDATE app.judgment
          SET is_answered = TRUE,
              answered_original = ${getSqlLiteral(answeredOriginal)},
              answered_original_as_array = ${getSqlLiteral(answeredOriginalAsArray)},
              confidence_original = 50,
              explanation = ${getSqlLiteral(answeredExplanation || null)},
              quotes = ${getSqlLiteral(answeredQuotes)},
              chunking_strategy = ${getSqlLiteral(chunkingStrategy)},
              updated_at = current_timestamp
          WHERE id = ${getSqlLiteral(existingId)}
          RETURNING id
        `)
      )[0]
    : (
        await runner.queryJson<{id: string}>(`
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
            ${getSqlLiteral(crypto.randomUUID())},
            ${getSqlLiteral(articleId)},
            ${getSqlLiteral(modelId)},
            ${getSqlLiteral(promptId)},
            TRUE,
            ${getSqlLiteral(answeredOriginal)},
            ${getSqlLiteral(answeredOriginalAsArray)},
            50,
            ${getSqlLiteral(answeredExplanation || null)},
            ${getSqlLiteral(answeredQuotes)},
            ${getSqlLiteral(chunkingStrategy)},
            ${getSqlLiteral(snapshotProjectId)},
            ${getSqlLiteral(snapshotProjectModelName)}
          )
          RETURNING id
        `)
      )[0]
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
    await getAppDatabaseService().transaction(async (runner) => {
      const results = await promptIds.reduce<Promise<Array<{id: string} | undefined>>>(async (promise, promptId) => {
        const currentResults = await promise
        const stored = await storeJudgmentForPrompt({
          articleId,
          chunkingStrategy,
          judgment,
          modelId,
          promptId,
          runner,
          shortIdMapping,
          snapshotProjectId: snapshotValues.snapshotProjectId,
          snapshotProjectModelName: snapshotValues.snapshotProjectModelName,
        })

        return [...currentResults, stored]
      }, Promise.resolve([]))
      const successfulResults = results.filter((result): result is {id: string} => {
        return result !== undefined
      })

      if (successfulResults.length > 0) {
        await getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({
          articleIds: [articleId],
          reason: 'judgeStoreJudgment',
          runner,
        })
      }
    })
  } catch (error) {
    console.error(
      `${articleId} | Failed to store judgment for article ${articleTitle}`,
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}
