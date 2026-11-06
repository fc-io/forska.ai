import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {
  type AppendLlmJudgmentReviewServingDeltaInput,
  appendLlmJudgmentReviewServingDeltas,
} from '../../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../services/projectVisibleJudgmentRule.ts'
import {getJudgmentJobSqliteService, type JudgmentPromptRefusalOutboxRow} from './judgmentJobSqliteService.ts'

type RefusalImportRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type VisibleRefusalDeltaRow = {
  articleId: string
  fullTextStrategyId: string
  modelId: string
  projectId: string
  promptId: string
  queuePromptId: string
  refusedAt: Date | string
  systemPromptVariant: SystemPromptVariant
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}

const judgmentRefusalOutboxDrainLimit = 500

export const getJudgmentRefusalDeltaId = (row: {jobId: string; queuePromptId: string}) => {
  return `judgmentRefusal:${row.jobId}:${row.queuePromptId}`
}

const getRefusalValueSql = (row: JudgmentPromptRefusalOutboxRow) => {
  return `(
    ${getSqlLiteral(row.articleId)},
    ${getSqlLiteral(row.promptId)},
    ${getSqlLiteral(row.modelId)},
    ${getSqlLiteral(row.useTitle)},
    ${getSqlLiteral(row.useAbstract)},
    ${getSqlLiteral(row.useFulltext)},
    ${getSqlLiteral(row.useFulltextNoImages)},
    ${getSqlLiteral(row.useMetadata)},
    ${getSqlLiteral(row.systemPromptVariant)},
    ${getSqlLiteral(row.fullTextStrategyId)},
    ${getSqlLiteral(row.projectId)},
    ${getSqlLiteral(row.jobId)},
    ${getSqlLiteral(row.queuePromptId)},
    ${getSqlLiteral(row.failureCode)},
    ${getSqlLiteral(row.providerKind)},
    ${getSqlLiteral(row.modelName)},
    ${getSqlLiteral(row.reason)},
    ${getTimestampLiteral(new Date(row.refusedAt))}
  )`
}

const insertJudgmentRefusals = async (runner: RefusalImportRunner, rows: readonly JudgmentPromptRefusalOutboxRow[]) => {
  return runner.queryJson<{queuePromptId: string}>(`
    INSERT INTO app.judgment_refusal (
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      use_metadata,
      system_prompt_variant,
      full_text_strategy_id,
      project_id,
      judgment_job_id,
      queue_prompt_id,
      failure_code,
      provider_kind,
      model_name,
      reason,
      refused_at
    ) VALUES ${rows.map(getRefusalValueSql).join(', ')}
    ON CONFLICT DO NOTHING
    RETURNING queue_prompt_id AS queuePromptId
  `)
}

const getVisibleRefusalDeltaRows = async (
  runner: RefusalImportRunner,
  rows: readonly JudgmentPromptRefusalOutboxRow[],
) => {
  return runner.queryJson<VisibleRefusalDeltaRow>(`
    WITH imported_refusal (
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      use_metadata,
      system_prompt_variant,
      full_text_strategy_id,
      queue_prompt_id,
      refused_at
    ) AS (
      VALUES ${rows
        .map((row) => {
          return `(
            ${getSqlLiteral(row.articleId)},
            ${getSqlLiteral(row.promptId)},
            ${getSqlLiteral(row.modelId)},
            ${getSqlLiteral(row.useTitle)},
            ${getSqlLiteral(row.useAbstract)},
            ${getSqlLiteral(row.useFulltext)},
            ${getSqlLiteral(row.useFulltextNoImages)},
            ${getSqlLiteral(row.useMetadata)},
            ${getSqlLiteral(row.systemPromptVariant)},
            ${getSqlLiteral(row.fullTextStrategyId)},
            ${getSqlLiteral(row.queuePromptId)},
            ${getTimestampLiteral(new Date(row.refusedAt))}
          )`
        })
        .join(', ')}
    )
    SELECT DISTINCT
      imported_refusal.article_id AS articleId,
      imported_refusal.prompt_id AS promptId,
      imported_refusal.model_id AS modelId,
      imported_refusal.use_title AS useTitle,
      imported_refusal.use_abstract AS useAbstract,
      imported_refusal.use_fulltext AS useFulltext,
      imported_refusal.use_fulltext_no_images AS useFulltextNoImages,
      imported_refusal.use_metadata AS useMetadata,
      imported_refusal.system_prompt_variant AS systemPromptVariant,
      imported_refusal.full_text_strategy_id AS fullTextStrategyId,
      imported_refusal.queue_prompt_id AS queuePromptId,
      imported_refusal.refused_at AS refusedAt,
      project.id AS projectId
    FROM imported_refusal
    INNER JOIN (
      SELECT project_id, article_id
      FROM app.project_article
      UNION
      SELECT pir.project_id, air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air
        ON air.import_route_id = pir.import_route_id
    ) project_scope
      ON project_scope.article_id = imported_refusal.article_id
    INNER JOIN app.project project
      ON project.id = project_scope.project_id
     AND NOT project.archived
    INNER JOIN app.project_prompt project_prompt
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'imported_refusal',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'project_scope',
      })}
  `)
}

const getRefusalDeltaInput = (jobId: string, row: VisibleRefusalDeltaRow): AppendLlmJudgmentReviewServingDeltaInput => {
  const refusalId = getJudgmentRefusalDeltaId({jobId, queuePromptId: row.queuePromptId})

  return {
    articleId: row.articleId,
    changeKind: 'judgment.llm.updated',
    fullTextStrategyId: row.fullTextStrategyId,
    judgmentId: refusalId,
    modelId: row.modelId,
    projectId: row.projectId,
    promptId: row.promptId,
    sourceMutationKey: `judgmentRefusalImport|${row.projectId}|${refusalId}`,
    sourceOperation: 'insert',
    sourceRowId: refusalId,
    sourceTable: 'app.judgment_refusal',
    sourceUpdatedAt: row.refusedAt,
    systemPromptVariant: row.systemPromptVariant,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useMetadata: row.useMetadata,
    useTitle: row.useTitle,
  }
}

const getInsertedRefusalRows = (
  rows: readonly JudgmentPromptRefusalOutboxRow[],
  inserted: ReadonlyArray<{queuePromptId: string}>,
) => {
  const insertedQueuePromptIds = new Set(
    inserted.map((row) => {
      return row.queuePromptId
    }),
  )

  return rows.filter((row) => {
    return insertedQueuePromptIds.has(row.queuePromptId)
  })
}

export const importJudgmentPromptRefusals = async (
  jobId: string,
  rows: readonly JudgmentPromptRefusalOutboxRow[],
): Promise<number> => {
  return rows.length === 0
    ? 0
    : getAppDatabaseService().transaction(async (runner) => {
        const insertedRows = getInsertedRefusalRows(rows, await insertJudgmentRefusals(runner, rows))
        const deltaRows = insertedRows.length === 0 ? [] : await getVisibleRefusalDeltaRows(runner, insertedRows)

        await appendLlmJudgmentReviewServingDeltas(
          runner,
          deltaRows.map((row) => {
            return getRefusalDeltaInput(jobId, row)
          }),
        )

        return insertedRows.length
      })
}

export const drainJudgmentPromptRefusalOutbox = async (jobId: string): Promise<number> => {
  const sqliteService = getJudgmentJobSqliteService()
  const rows = await sqliteService.getPendingPromptRefusals(jobId, judgmentRefusalOutboxDrainLimit)

  if (rows.length === 0) {
    return 0
  }

  await importJudgmentPromptRefusals(jobId, rows)
  await sqliteService.deletePromptRefusals(
    jobId,
    rows.map((row) => {
      return row.queuePromptId
    }),
  )

  return rows.length
}
