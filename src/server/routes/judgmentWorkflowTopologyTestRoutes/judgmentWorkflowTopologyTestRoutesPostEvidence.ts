import {existsSync} from 'node:fs'

import {getJudgmentJobLeasePath, getJudgmentJobSqlitePath} from '../../cron/judgmentsJobs/judgmentJobPaths.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getFixtureIds} from './getFixtureIds.ts'
import {getTopologyVisibleProjectionCount} from './getTopologyVisibleProjectionCount.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

export const judgmentWorkflowTopologyTestRoutesPostEvidence = async ({
  body,
}: {
  body: {fixtureId: string; jobIds?: string[]; token: string}
}) => {
  requireTopologySeedBoundary(body.token)
  const ids = getFixtureIds(body.fixtureId)
  const projectList = ids.projectIds.map(getSqlLiteral).join(', ')
  const judgments = await getAppDatabaseService().queryJson<{
    count: number
    fullTextStrategyId: string
    modelId: string
    projectId: string
    systemPromptVariant: string
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useMetadata: boolean
    useTitle: boolean
  }>(`
        SELECT project_id AS projectId,
               model_id AS modelId,
               system_prompt_variant AS systemPromptVariant,
               full_text_strategy_id AS fullTextStrategyId,
               COUNT(*) AS count,
               BOOL_AND(use_title) AS useTitle,
               BOOL_AND(use_abstract) AS useAbstract,
               BOOL_OR(use_fulltext) AS useFulltext,
               BOOL_OR(use_fulltext_no_images) AS useFulltextNoImages,
               BOOL_OR(use_metadata) AS useMetadata
        FROM app.judgment
        WHERE project_id IN (${projectList})
        GROUP BY project_id, model_id, system_prompt_variant, full_text_strategy_id
        ORDER BY project_id, system_prompt_variant, full_text_strategy_id
      `)
  const [queue] = await getAppDatabaseService().queryJson<{count: number}>(`
        WITH required_dispatch_component(component) AS (
          SELECT *
          FROM (VALUES
            ('projectScope'),
            ('selectedImport'),
            ('display'),
            ('llmStatus'),
            ('queue'),
            ('judgmentInputContent')
          )
        ), dispatch_ready_candidate AS (
          SELECT
            snapshot.project_id,
            snapshot.review_config_hash,
            snapshot.snapshot_id
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id IN (${projectList})
            AND snapshot.snapshot_status = 'candidate'
            AND snapshot.selected_import_snapshot_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM app.review_selected_import_snapshot selected_import
              WHERE selected_import.project_id = snapshot.project_id
                AND selected_import.selected_import_snapshot_id = snapshot.selected_import_snapshot_id
                AND selected_import.status = 'completed'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM required_dispatch_component required
              WHERE NOT EXISTS (
                SELECT 1
                FROM app.review_rebuild_chunk_manifest chunk
                WHERE chunk.project_id = snapshot.project_id
                  AND (chunk.snapshot_id || '') = (snapshot.snapshot_id || '')
                  AND chunk.projection_component = required.component
                  AND chunk.status = 'completed'
              )
              OR EXISTS (
                SELECT 1
                FROM app.review_rebuild_chunk_manifest chunk
                WHERE chunk.project_id = snapshot.project_id
                  AND (chunk.snapshot_id || '') = (snapshot.snapshot_id || '')
                  AND chunk.projection_component = required.component
                  AND chunk.status <> 'completed'
              )
            )
        ), active_scope AS (
          SELECT
            snapshot.project_id,
            snapshot.review_config_hash,
            snapshot.snapshot_id
          FROM app.review_serving_snapshot_manifest snapshot
          WHERE snapshot.project_id IN (${projectList})
            AND snapshot.snapshot_status = 'active'
            AND snapshot.selected_import_snapshot_id IS NOT NULL
        ), eligible_scope AS (
          SELECT * FROM active_scope
          UNION ALL
          SELECT * FROM dispatch_ready_candidate
        )
        SELECT COUNT(*) AS count
        FROM (
          SELECT DISTINCT queue.project_id, queue.review_config_hash, queue.queue_kind, queue.article_id
          FROM mart.review_unassessed_queue_article_rank_serving_v4 queue
          INNER JOIN eligible_scope scope
            ON scope.project_id = queue.project_id
            AND scope.review_config_hash = queue.review_config_hash
            AND scope.snapshot_id = queue.snapshot_id
          WHERE queue.project_id IN (${projectList})
        ) queue
      `)
  const visibleProjectionCount = await getTopologyVisibleProjectionCount(body.fixtureId)
  const appliedBoundaryMigrations = await getAppDatabaseService().queryJson<{name: string}>(`
        SELECT name
        FROM app_schema_migration
        WHERE name IN (
          '0090_comparisonServingAnswerFilterBooleans.sql',
          '0093_judgmentJobMaintenanceIndexes.sql',
          '0224_reviewServingDirtyWorkLifecycleReason.sql',
          '0225_rebuildReviewServingManifestsWithoutIndexes.sql'
        )
        ORDER BY name
      `)
  const [migrationSentinel] = await getAppDatabaseService().queryJson<{
    completionTokens: number
    count: number
    promptTokens: number
    requestAttempts: string | null
    requests: number
    totalTokens: number
  }>(`
        SELECT
          COUNT(*) AS count,
          CAST(COALESCE(MAX(requests), 0) AS INTEGER) AS requests,
          CAST(COALESCE(MAX(total_prompt_tokens), 0) AS INTEGER) AS promptTokens,
          CAST(COALESCE(MAX(total_completion_tokens), 0) AS INTEGER) AS completionTokens,
          CAST(COALESCE(MAX(total_tokens), 0) AS INTEGER) AS totalTokens,
          MAX(request_attempts_json) AS requestAttempts
        FROM app.token_use
        WHERE id = 'judgment-workflow-migration-boundary-v1'
      `)
  const jobEvidence = await Promise.all(
    (body.jobIds ?? []).map(async (jobId) => {
      const sqlitePath = getJudgmentJobSqlitePath(jobId)
      const scanState = await getJudgmentJobSqliteService().getScanState(jobId)
      const health = await getJudgmentJobSqliteService().getHealthSnapshot(jobId)
      const claims = await getJudgmentJobSqliteService().getTopologyClaimRows(jobId)
      const completedClaims = await getJudgmentJobSqliteService().getTopologyCompletedClaimRows(jobId)

      return {
        artifacts: {
          lease: existsSync(getJudgmentJobLeasePath(jobId)),
          shm: existsSync(`${sqlitePath}-shm`),
          sqlite: existsSync(sqlitePath),
          wal: existsSync(`${sqlitePath}-wal`),
        },
        claims,
        completedClaims,
        health,
        jobId,
        scanState,
      }
    }),
  )

  return {
    data: {
      jobEvidence,
      judgments,
      migrationBoundary: {
        appliedMigrations: appliedBoundaryMigrations.map((row) => {
          return row.name
        }),
        sentinel: migrationSentinel ? {...migrationSentinel, count: Number(migrationSentinel.count)} : undefined,
      },
      readyPairCount: Number(queue?.count ?? 0),
      visibleProjectionCount,
    },
    error: null,
  }
}
