import {existsSync} from 'node:fs'

import {Elysia, t} from 'elysia'

import {getJudgmentJobLeasePath, getJudgmentJobSqlitePath} from '../cron/judgmentsJobs/judgmentJobPaths.ts'
import {getJudgmentJobSqliteService} from '../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {judgmentsJobsCleanupStale} from '../cron/judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {appendProjectScopeArticleReviewServingDeltas} from '../reviewServing/projectScopeReviewServingDeltaService.ts'
import {
  appendProjectReviewConfigReviewServingDeltas,
  appendPromptConfigReviewServingDeltas,
} from '../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {requestReviewServingV4Rebuilds} from '../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {getCurrentServerRole} from '../utils/serverRuntimeRole.ts'

const seedTokenEnvKey = 'FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN'

const requireTopologySeedBoundary = (token: string) => {
  const configuredToken = String(process.env[seedTokenEnvKey] ?? '')

  if (
    process.env.NODE_ENV !== 'test'
    || getCurrentServerRole() !== 'maintenance-worker'
    || configuredToken.length === 0
    || token !== configuredToken
  ) {
    throw new Error('Judgment topology seed boundary is unavailable')
  }
}

const getFixtureIds = (fixtureId: string) => {
  return {
    articleIds: [`${fixtureId}-article-a`, `${fixtureId}-article-b`],
    connectionId: `${fixtureId}-connection`,
    modelId: `${fixtureId}-model`,
    projectIds: [`${fixtureId}-project-a`, `${fixtureId}-project-b`],
    promptIds: [`${fixtureId}-prompt-a`, `${fixtureId}-prompt-b`],
  }
}

const seedTopologyFixture = async ({
  createPausedJob,
  fixtureId,
  providerBaseUrl,
  singlePromptProjectA,
}: {
  createPausedJob?: boolean
  fixtureId: string
  providerBaseUrl: string
  singlePromptProjectA?: boolean
}) => {
  const ids = getFixtureIds(fixtureId)
  const [articleA, articleB] = ids.articleIds
  const [projectA, projectB] = ids.projectIds
  const [promptA, promptB] = ids.promptIds
  const pausedJobId = createPausedJob ? `${fixtureId}-paused-job` : null
  const sql = (value: unknown) => {
    return getSqlLiteral(value)
  }

  await getAppDatabaseService().transaction(async (tx) => {
    await tx.run(`
      INSERT INTO app.provider_connection (
        id, provider_kind, label, enabled, auth_mode, base_url, config_json, max_inflight_requests
      )
      VALUES (
        ${sql(ids.connectionId)}, 'llamacpp', 'Topology deterministic provider', TRUE, 'none',
        ${sql(providerBaseUrl)}, json_object('workerUrlMode', 'manual'), 1
      );
      INSERT INTO app.model (
        id, provider_connection_id, name, remote_model_id, display_name, source, enabled
      ) VALUES (
        ${sql(ids.modelId)}, ${sql(ids.connectionId)}, 'topology-deterministic', 'topology-deterministic',
        'Topology deterministic', 'manual', TRUE
      );
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
      VALUES
        (${sql(projectA)}, 'Topology project A', ${sql(ids.modelId)}, TRUE, TRUE, FALSE, FALSE),
        (${sql(projectB)}, 'Topology project B', ${sql(ids.modelId)}, TRUE, TRUE, FALSE, FALSE);
      INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at, article_updated_at)
      VALUES
        (${sql(articleA)}, ${sql(`external-${articleA}`)}, 'Topology article A', 'Deterministic abstract A', current_timestamp, current_timestamp),
        (${sql(articleB)}, ${sql(`external-${articleB}`)}, 'Topology article B', 'Deterministic abstract B', current_timestamp, current_timestamp);
      UPDATE app.article
      SET full_text = ${sql(`FULLTEXT_SENTINEL_${fixtureId}`)},
          full_text_assets = ${sql(JSON.stringify([{src: `IMAGE_SENTINEL_${fixtureId}`}]))}
      WHERE id IN (${sql(articleA)}, ${sql(articleB)});
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES
        (${sql(promptA)}, 'Does this article satisfy criterion A?', ${sql(`${promptA}-hash`)}),
        (${sql(promptB)}, 'Does this article satisfy criterion B?', ${sql(`${promptB}-hash`)});
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        (${sql(`${projectA}-article-a`)}, ${sql(projectA)}, ${sql(articleA)}),
        (${sql(`${projectB}-article-b`)}, ${sql(projectB)}, ${sql(articleB)});
      INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
      VALUES
        (${sql(`${projectA}-prompt-a`)}, ${sql(projectA)}, ${sql(promptA)}, 1, TRUE),
        (${sql(`${projectA}-prompt-b`)}, ${sql(projectA)}, ${sql(promptB)}, 2, TRUE),
        (${sql(`${projectB}-prompt-a`)}, ${sql(projectB)}, ${sql(promptA)}, 1, TRUE),
        (${sql(`${projectB}-prompt-b`)}, ${sql(projectB)}, ${sql(promptB)}, 2, TRUE);
    `)
    if (singlePromptProjectA) {
      await tx.run(`
        DELETE FROM app.project_prompt
        WHERE project_id = ${sql(projectA)} AND prompt_id = ${sql(promptB)}
      `)
    }
    await appendProjectScopeArticleReviewServingDeltas(tx, [
      {
        articleId: articleA,
        changeKind: 'projectScope.article.added',
        projectArticleId: `${projectA}-article-a`,
        projectId: projectA,
        sourceMutationKey: `${fixtureId}:scope-a`,
        sourceOperation: 'insert',
      },
      {
        articleId: articleB,
        changeKind: 'projectScope.article.added',
        projectArticleId: `${projectB}-article-b`,
        projectId: projectB,
        sourceMutationKey: `${fixtureId}:scope-b`,
        sourceOperation: 'insert',
      },
    ])
    await appendProjectReviewConfigReviewServingDeltas(
      tx,
      ids.projectIds.map((projectId) => {
        return {
          changedReviewConfigFields: [
            'modelId',
            'promptMembership',
            'useAbstract',
            'useFulltext',
            'useFulltextNoImages',
            'useTitle',
          ] as const,
          projectId,
          sourceMutationKey: `${fixtureId}:project-config:${projectId}`,
          sourceOperation: 'insert' as const,
        }
      }),
    )
    await appendPromptConfigReviewServingDeltas(
      tx,
      ids.projectIds.flatMap((projectId) => {
        return ids.promptIds.map((promptId) => {
          return {
            changedPromptConfigFields: ['enabled', 'promptOrder', 'promptText'] as const,
            projectId,
            promptId,
            sourceMutationKey: `${fixtureId}:prompt-config:${projectId}:${promptId}`,
            sourceOperation: 'insert' as const,
          }
        })
      }),
    )
    if (pausedJobId) {
      await tx.run(`
        INSERT INTO app.judgment_job (id, project_id, status, storage_state)
        VALUES (${sql(pausedJobId)}, ${sql(projectA)}, 'paused', 'active')
      `)
    }
  })
  await requestReviewServingV4Rebuilds(
    ids.projectIds.map((projectId) => {
      return {projectId, reason: 'missingReviewServingSnapshot' as const}
    }),
  )

  return {...ids, pausedJobId}
}

export const judgmentWorkflowTopologyTestRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/test/judgment-workflow-topology/cleanup-stale',
    async ({body}) => {
      requireTopologySeedBoundary(body.token)
      await judgmentsJobsCleanupStale()
      const jobIds = body.jobIds ?? []
      const storageStates =
        jobIds.length === 0
          ? []
          : await getAppDatabaseService().queryJson<{jobId: string; storageState: string}>(`
              SELECT id AS jobId, storage_state AS storageState
              FROM app.judgment_job
              WHERE id IN (${jobIds.map(getSqlLiteral).join(', ')})
            `)
      const storageStateByJobId = new Map(
        storageStates.map((state) => {
          return [state.jobId, state.storageState]
        }),
      )
      const jobs = jobIds.map((jobId) => {
        const sqlitePath = getJudgmentJobSqlitePath(jobId)

        return {
          artifacts: {
            lease: existsSync(getJudgmentJobLeasePath(jobId)),
            shm: existsSync(`${sqlitePath}-shm`),
            sqlite: existsSync(sqlitePath),
            wal: existsSync(`${sqlitePath}-wal`),
          },
          jobId,
          storageState: storageStateByJobId.get(jobId) ?? null,
        }
      })

      return {data: {jobs, ok: true}, error: null}
    },
    {body: t.Object({jobIds: t.Optional(t.Array(t.String())), token: t.String()})},
  )
  .post(
    '/api/test/judgment-workflow-topology/claims',
    async ({body}) => {
      requireTopologySeedBoundary(body.token)

      return {data: {claims: await getJudgmentJobSqliteService().getTopologyClaimRows(body.jobId)}, error: null}
    },
    {body: t.Object({jobId: t.String(), token: t.String()})},
  )
  .post(
    '/api/test/judgment-workflow-topology/seed',
    async ({body}) => {
      requireTopologySeedBoundary(body.token)
      const fixture = await seedTopologyFixture(body)

      return {data: {fixture}, error: null}
    },
    {
      body: t.Object({
        createPausedJob: t.Optional(t.Boolean()),
        fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}),
        providerBaseUrl: t.String(),
        singlePromptProjectA: t.Optional(t.Boolean()),
        token: t.String(),
      }),
    },
  )
  .post(
    '/api/test/judgment-workflow-topology/evidence',
    async ({body}) => {
      requireTopologySeedBoundary(body.token)
      const ids = getFixtureIds(body.fixtureId)
      const projectList = ids.projectIds.map(getSqlLiteral).join(', ')
      const judgments = await getAppDatabaseService().queryJson<{
        count: number
        modelId: string
        projectId: string
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }>(`
        SELECT project_id AS projectId,
               model_id AS modelId,
               COUNT(*) AS count,
               BOOL_AND(use_title) AS useTitle,
               BOOL_AND(use_abstract) AS useAbstract,
               BOOL_OR(use_fulltext) AS useFulltext,
               BOOL_OR(use_fulltext_no_images) AS useFulltextNoImages
        FROM app.judgment
        WHERE project_id IN (${projectList})
        GROUP BY project_id, model_id
        ORDER BY project_id
      `)
      const [queue] = await getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM mart.review_unassessed_queue_article_rank_serving_v4
        WHERE project_id IN (${projectList})
      `)
      const [projection] = await getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM mart.review_article_judgment_detail_serving_v4
        WHERE project_id IN (${projectList})
          AND payload_kind = 'llm'
      `)
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

          return {
            artifacts: {
              lease: existsSync(getJudgmentJobLeasePath(jobId)),
              shm: existsSync(`${sqlitePath}-shm`),
              sqlite: existsSync(sqlitePath),
              wal: existsSync(`${sqlitePath}-wal`),
            },
            claims,
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
          visibleProjectionCount: Number(projection?.count ?? 0),
        },
        error: null,
      }
    },
    {
      body: t.Object({
        fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}),
        jobIds: t.Optional(t.Array(t.String())),
        token: t.String(),
      }),
    },
  )
  .post(
    '/api/test/judgment-workflow-real-codex/evidence',
    async ({body}) => {
      requireTopologySeedBoundary(body.token)
      const judgments = await getAppDatabaseService().queryJson<{
        answeredOriginal: string | null
        articleId: string
        confidenceOriginal: string | null
        explanation: string | null
        isAnswered: boolean | null
        modelId: string
        projectId: string
        promptId: string
        quotes: unknown
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useTitle: boolean
      }>(`
        SELECT article_id AS articleId,
               model_id AS modelId,
               prompt_id AS promptId,
               project_id AS projectId,
               is_answered AS isAnswered,
               answered_original AS answeredOriginal,
               confidence_original AS confidenceOriginal,
               explanation,
               quotes,
               use_title AS useTitle,
               use_abstract AS useAbstract,
               use_fulltext AS useFulltext,
               use_fulltext_no_images AS useFulltextNoImages
        FROM app.judgment
        WHERE project_id = ${getSqlLiteral(body.projectId)}
          AND model_id = ${getSqlLiteral(body.modelId)}
          AND prompt_id = ${getSqlLiteral(body.promptId)}
        ORDER BY article_id
      `)
      const [projection] = await getAppDatabaseService().queryJson<{count: number}>(`
        SELECT COUNT(*) AS count
        FROM mart.review_article_judgment_detail_serving_v4
        WHERE project_id = ${getSqlLiteral(body.projectId)}
          AND prompt_id = ${getSqlLiteral(body.promptId)}
          AND payload_kind = 'llm'
      `)

      return {data: {judgments, visibleProjectionCount: Number(projection?.count ?? 0)}, error: null}
    },
    {body: t.Object({modelId: t.String(), projectId: t.String(), promptId: t.String(), token: t.String()})},
  )
