import {Elysia, t} from 'elysia'

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

  if (getCurrentServerRole() !== 'maintenance-worker' || configuredToken.length === 0 || token !== configuredToken) {
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
}: {
  createPausedJob?: boolean
  fixtureId: string
  providerBaseUrl: string
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
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
      VALUES (${sql(ids.connectionId)}, 'llamacpp', 'Topology deterministic provider', TRUE, 'none', ${sql(providerBaseUrl)}, json_object('workerUrlMode', 'manual'));
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

      return {data: {judgments, readyPairCount: Number(queue?.count ?? 0)}, error: null}
    },
    {body: t.Object({fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}), token: t.String()})},
  )
