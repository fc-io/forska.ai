import {appendProjectScopeArticleReviewServingDeltas} from '../../reviewServing/projectScopeReviewServingDeltaService.ts'
import {
  appendProjectReviewConfigReviewServingDeltas,
  appendPromptConfigReviewServingDeltas,
} from '../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {requestReviewServingV4Rebuilds} from '../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getFixtureIds} from './getFixtureIds.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

const topologyModelMetadata = {
  capabilityOverrides: {
    contextWindow: {inputTokens: 32_768, totalTokens: 32_768},
    updatedAt: '2026-10-17T00:00:00.000Z',
  },
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
        id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json
      ) VALUES (
        ${sql(ids.modelId)}, ${sql(ids.connectionId)}, 'topology-deterministic', 'topology-deterministic',
        'Topology deterministic', 'manual', TRUE, ${sql(JSON.stringify(topologyModelMetadata))}
      );
      INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata)
      VALUES
        (${sql(projectA)}, 'Topology project A', ${sql(ids.modelId)}, TRUE, TRUE, FALSE, FALSE, FALSE),
        (${sql(projectB)}, 'Topology project B', ${sql(ids.modelId)}, TRUE, TRUE, FALSE, FALSE, FALSE);
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
            'fullTextStrategyId',
            'modelId',
            'promptMembership',
            'systemPromptVariant',
            'useAbstract',
            'useFulltext',
            'useFulltextNoImages',
            'useMetadata',
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

export const judgmentWorkflowTopologyTestRoutesPostSeed = async ({
  body,
}: {
  body: {
    createPausedJob?: boolean
    fixtureId: string
    providerBaseUrl: string
    singlePromptProjectA?: boolean
    token: string
  }
}) => {
  requireTopologySeedBoundary(body.token)
  const fixture = await seedTopologyFixture(body)

  return {data: {fixture}, error: null}
}
