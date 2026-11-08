import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {
  type AppendLlmJudgmentReviewServingDeltaInput,
  appendLlmJudgmentReviewServingDeltas,
} from '../../reviewServing/llmJudgmentReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral, getTimestampLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectVisibleJudgmentScopeSql} from '../../services/projectVisibleJudgmentRule.ts'
import {getJudgmentJobSqliteService, type JudgmentPromptFailureOutboxRow} from './judgmentJobSqliteService.ts'

type FailureImportRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

// One row per judgment identity: DuckDB's ON CONFLICT DO UPDATE cannot touch the same row twice in one
// statement, so failures of the same identity in one batch fold into a single upsert.
type GroupedPromptFailure = JudgmentPromptFailureOutboxRow & {failureCount: number; firstFailedAt: string}

type VisibleFailureDeltaRow = {
  articleId: string
  claimId: string
  failedAt: Date | string
  fullTextStrategyId: string
  modelId: string
  projectId: string
  promptId: string
  systemPromptVariant: SystemPromptVariant
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}

const judgmentPromptFailureOutboxDrainLimit = 500

export const getJudgmentPromptFailureDeltaId = (row: {claimId: string; jobId: string}) => {
  return `judgmentPromptFailure:${row.jobId}:${row.claimId}`
}

const getFailureIdentityKey = (row: JudgmentPromptFailureOutboxRow) => {
  return JSON.stringify([
    row.articleId,
    row.promptId,
    row.modelId,
    row.useTitle,
    row.useAbstract,
    row.useFulltext,
    row.useFulltextNoImages,
    row.useMetadata,
    row.systemPromptVariant,
    row.fullTextStrategyId,
  ])
}

const getLaterFailure = (left: GroupedPromptFailure, right: JudgmentPromptFailureOutboxRow) => {
  return right.failedAt >= left.failedAt ? right : left
}

export const groupJudgmentPromptFailures = (
  rows: readonly JudgmentPromptFailureOutboxRow[],
): GroupedPromptFailure[] => {
  return [
    ...rows
      .reduce((groups, row) => {
        const key = getFailureIdentityKey(row)
        const current = groups.get(key)

        return groups.set(
          key,
          current
            ? {
                ...getLaterFailure(current, row),
                failureCount: current.failureCount + 1,
                firstFailedAt: row.failedAt < current.firstFailedAt ? row.failedAt : current.firstFailedAt,
              }
            : {...row, failureCount: 1, firstFailedAt: row.failedAt},
        )
      }, new Map<string, GroupedPromptFailure>())
      .values(),
  ]
}

const getFailureValueSql = (row: GroupedPromptFailure) => {
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
    ${getSqlLiteral(row.claimId)},
    ${getSqlLiteral(row.failureCode)},
    ${getSqlLiteral(row.reason)},
    ${getSqlLiteral(row.providerKind)},
    ${getSqlLiteral(row.modelName)},
    ${getSqlLiteral(row.attemptCount)},
    ${getSqlLiteral(row.failureCount)},
    ${getTimestampLiteral(new Date(row.firstFailedAt))},
    ${getTimestampLiteral(new Date(row.failedAt))}
  )`
}

// Latest failure wins for the code, reason and provenance; the count accumulates and the first failure time
// stays. A batch re-imported after a crash between the DuckDB commit and the outbox delete carries the same last
// claim and does not count twice. Rows are never deleted: a later judgment or refusal for the identity takes
// precedence when projected.
const upsertJudgmentPromptFailures = async (runner: FailureImportRunner, rows: readonly GroupedPromptFailure[]) => {
  await runner.run(`
    INSERT INTO app.judgment_prompt_failure (
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
      last_claim_id,
      failure_code,
      reason,
      provider_kind,
      model_name,
      attempt_count,
      failure_count,
      first_failed_at,
      last_failed_at
    ) VALUES ${rows.map(getFailureValueSql).join(', ')}
    ON CONFLICT DO UPDATE SET
      project_id = EXCLUDED.project_id,
      judgment_job_id = EXCLUDED.judgment_job_id,
      queue_prompt_id = EXCLUDED.queue_prompt_id,
      last_claim_id = EXCLUDED.last_claim_id,
      failure_code = EXCLUDED.failure_code,
      reason = EXCLUDED.reason,
      provider_kind = EXCLUDED.provider_kind,
      model_name = EXCLUDED.model_name,
      attempt_count = EXCLUDED.attempt_count,
      failure_count = CASE
        WHEN last_claim_id = EXCLUDED.last_claim_id THEN failure_count
        ELSE failure_count + EXCLUDED.failure_count
      END,
      first_failed_at = LEAST(first_failed_at, EXCLUDED.first_failed_at),
      last_failed_at = GREATEST(last_failed_at, EXCLUDED.last_failed_at),
      updated_at = now()
  `)
}

const getVisibleFailureDeltaRows = async (runner: FailureImportRunner, rows: readonly GroupedPromptFailure[]) => {
  return runner.queryJson<VisibleFailureDeltaRow>(`
    WITH imported_failure (
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
      claim_id,
      failed_at
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
            ${getSqlLiteral(row.claimId)},
            ${getTimestampLiteral(new Date(row.failedAt))}
          )`
        })
        .join(', ')}
    )
    SELECT DISTINCT
      imported_failure.article_id AS articleId,
      imported_failure.prompt_id AS promptId,
      imported_failure.model_id AS modelId,
      imported_failure.use_title AS useTitle,
      imported_failure.use_abstract AS useAbstract,
      imported_failure.use_fulltext AS useFulltext,
      imported_failure.use_fulltext_no_images AS useFulltextNoImages,
      imported_failure.use_metadata AS useMetadata,
      imported_failure.system_prompt_variant AS systemPromptVariant,
      imported_failure.full_text_strategy_id AS fullTextStrategyId,
      imported_failure.claim_id AS claimId,
      imported_failure.failed_at AS failedAt,
      project.id AS projectId
    FROM imported_failure
    INNER JOIN (
      SELECT project_id, article_id
      FROM app.project_article
      UNION
      SELECT pir.project_id, air.article_id
      FROM app.project_import_route pir
      INNER JOIN app.article_import_route air
        ON air.import_route_id = pir.import_route_id
    ) project_scope
      ON project_scope.article_id = imported_failure.article_id
    INNER JOIN app.project project
      ON project.id = project_scope.project_id
     AND NOT project.archived
    INNER JOIN app.project_prompt project_prompt
      ON ${getProjectVisibleJudgmentScopeSql({
        judgmentAlias: 'imported_failure',
        projectAlias: 'project',
        projectPromptAlias: 'project_prompt',
        projectScopeAlias: 'project_scope',
      })}
  `)
}

const getFailureDeltaInput = (jobId: string, row: VisibleFailureDeltaRow): AppendLlmJudgmentReviewServingDeltaInput => {
  const failureId = getJudgmentPromptFailureDeltaId({claimId: row.claimId, jobId})

  return {
    articleId: row.articleId,
    changeKind: 'judgment.llm.updated',
    fullTextStrategyId: row.fullTextStrategyId,
    judgmentId: failureId,
    modelId: row.modelId,
    projectId: row.projectId,
    promptId: row.promptId,
    sourceMutationKey: `judgmentPromptFailureImport|${row.projectId}|${failureId}`,
    sourceOperation: 'insert',
    sourceRowId: failureId,
    sourceTable: 'app.judgment_prompt_failure',
    sourceUpdatedAt: row.failedAt,
    systemPromptVariant: row.systemPromptVariant,
    useAbstract: row.useAbstract,
    useFulltext: row.useFulltext,
    useFulltextNoImages: row.useFulltextNoImages,
    useMetadata: row.useMetadata,
    useTitle: row.useTitle,
  }
}

export const importJudgmentPromptFailures = async (
  jobId: string,
  rows: readonly JudgmentPromptFailureOutboxRow[],
): Promise<number> => {
  const groupedRows = groupJudgmentPromptFailures(rows)

  return groupedRows.length === 0
    ? 0
    : getAppDatabaseService().transaction(async (runner) => {
        await upsertJudgmentPromptFailures(runner, groupedRows)

        const deltaRows = await getVisibleFailureDeltaRows(runner, groupedRows)

        await appendLlmJudgmentReviewServingDeltas(
          runner,
          deltaRows.map((row) => {
            return getFailureDeltaInput(jobId, row)
          }),
        )

        return groupedRows.length
      })
}

export const drainJudgmentPromptFailureOutbox = async (jobId: string): Promise<number> => {
  const sqliteService = getJudgmentJobSqliteService()
  const rows = await sqliteService.getPendingPromptFailures(jobId, judgmentPromptFailureOutboxDrainLimit)

  if (rows.length === 0) {
    return 0
  }

  await importJudgmentPromptFailures(jobId, rows)
  await sqliteService.deletePromptFailures(
    jobId,
    rows.map((row) => {
      return row.claimId
    }),
  )

  return rows.length
}
