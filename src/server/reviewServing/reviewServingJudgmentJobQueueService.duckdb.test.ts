import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-judgment-job-queue-human-answered')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

type QueueServiceModule = typeof import('./reviewServingJudgmentJobQueueService.ts')

let database: ReturnType<typeof getAppDatabaseService> | null = null
let queueService: QueueServiceModule | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getQueueService = () => {
  if (queueService === null) {
    throw new Error('Queue service not initialized')
  }

  return queueService
}

const articleIds = ['article-a', 'article-b', 'article-c'] as const
const promptIds = ['prompt-1', 'prompt-2'] as const
const seedTimestamp = "TIMESTAMPTZ '2026-09-20T10:00:00Z'"

const getId = (projectId: string, value: string) => {
  return `${projectId}-${value}`
}

const seedProject = async (input: {humanJudgmentMode: 'prompt' | 'summary'; projectId: string}) => {
  const {projectId} = input

  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, human_judgment_mode)
    VALUES ('${projectId}', '${projectId}', 'model-human-first', TRUE, TRUE, FALSE, FALSE, '${input.humanJudgmentMode}');

    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${getId(projectId, 'job')}', '${projectId}', 'running');
  `)

  await getDatabase().run(`
    INSERT INTO app.prompt (id, original_text)
    VALUES ${promptIds
      .map((promptId) => {
        return `('${getId(projectId, promptId)}', '${promptId}?')`
      })
      .join(', ')};

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
    VALUES ${promptIds
      .map((promptId, index) => {
        return `('${getId(projectId, `project-${promptId}`)}', '${projectId}', '${getId(projectId, promptId)}', ${index + 1})`
      })
      .join(', ')};

    INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${getId(projectId, articleId)}', '${articleId}', ${seedTimestamp}, ${seedTimestamp})`
      })
      .join(', ')};

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${getId(projectId, `project-${articleId}`)}', '${projectId}', '${getId(projectId, articleId)}')`
      })
      .join(', ')};

    INSERT INTO mart.project_scope_article (
      project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at
    ) VALUES ${articleIds
      .map((articleId) => {
        return `('${projectId}', '${getId(projectId, articleId)}', TRUE, FALSE, ${seedTimestamp}, ${seedTimestamp})`
      })
      .join(', ')};
  `)
}

const seedActiveServingSnapshot = async (projectId: string) => {
  const {getCurrentReviewServingReviewConfigHash} = await import('./reviewServingReviewConfig.ts')
  const reviewConfigHash = await getCurrentReviewServingReviewConfigHash(projectId, getDatabase())
  const snapshotId = getId(projectId, 'snapshot')
  const componentState = {
    optional: [],
    required: [{baseGeneration: 1, component: 'projectScope', patchWatermark: 0, projectionIdentity: 'scope-1'}],
  }

  if (reviewConfigHash === null) {
    throw new Error('Expected review config hash')
  }

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id,
      snapshot_id,
      snapshot_status,
      review_config_hash,
      selected_import_snapshot_id,
      composed_identity_json,
      component_state_json,
      required_components_json,
      optional_components_json,
      source_watermarks_json,
      activated_at
    ) VALUES (
      '${projectId}',
      '${snapshotId}',
      'active',
      '${reviewConfigHash}',
      '${getId(projectId, 'selected-import')}',
      '{}',
      '${JSON.stringify(componentState)}'::JSON,
      '["projectScope"]'::JSON,
      '[]',
      '{}',
      current_timestamp
    )
  `)

  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_base_v4 (
      project_id, review_config_hash, snapshot_id, base_generation, patch_watermark, article_id, sort_key,
      activity_sort_at, article_created_at
    ) VALUES ${articleIds
      .map((articleId) => {
        return `('${projectId}', '${reviewConfigHash}', '${snapshotId}', 1, 0, '${getId(projectId, articleId)}', ${seedTimestamp}, ${seedTimestamp}, ${seedTimestamp})`
      })
      .join(', ')}
  `)
}

const insertHumanAnswer = async (input: {
  articleId: string
  isAnswered: boolean
  projectId: string
  promptId: string
  rowProjectId?: string
}) => {
  const rowProjectId = input.rowProjectId ?? input.projectId

  await getDatabase().run(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES (
      '${getId(rowProjectId, `human-${input.articleId}-${input.promptId}`)}',
      '${rowProjectId}',
      '${getId(input.projectId, input.articleId)}',
      '${getId(input.projectId, input.promptId)}',
      ${input.isAnswered ? 'TRUE' : 'FALSE'},
      ${input.isAnswered ? "'yes'" : 'NULL'}
    )
  `)
}

const insertHumanSummary = async (input: {answer: string | null; articleId: string; projectId: string}) => {
  await getDatabase().run(`
    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin)
    VALUES (
      '${getId(input.projectId, `summary-${input.articleId}`)}',
      '${input.projectId}',
      '${getId(input.projectId, input.articleId)}',
      ${input.answer === null ? 'NULL' : `'${input.answer}'`},
      'manual_override'
    )
  `)
}

const insertAnsweredLlmJudgment = async (input: {articleId: string; projectId: string; promptId: string}) => {
  await getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, project_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      delete_generation, is_answered, answered_original, created_at, updated_at
    ) VALUES (
      '${getId(input.projectId, `judgment-${input.articleId}-${input.promptId}`)}',
      '${getId(input.projectId, input.articleId)}',
      '${getId(input.projectId, input.promptId)}',
      '${input.projectId}',
      'model-human-first', TRUE, TRUE, FALSE, FALSE, 0, TRUE, 'yes', current_timestamp, current_timestamp
    )
  `)
}

const getPairs = async (input: {humanAnsweredMode: 'prompt' | 'summary' | null; projectId: string}) => {
  const result = await getQueueService().getJudgmentJobUnassessedPairsFromServing({
    cursor: null,
    humanAnsweredMode: input.humanAnsweredMode,
    jobId: getId(input.projectId, 'job'),
    numberOfPromptsToGet: 100,
    projectId: input.projectId,
  })

  return result.promptEntries.map((entry) => {
    return `${entry.articleId.replace(`${input.projectId}-`, '')}:${entry.promptId.replace(`${input.projectId}-`, '')}`
  })
}

// article-a/prompt-2 is human answered, article-b/prompt-1 is human answered but already LLM judged,
// article-c/prompt-1 has only a pending human row, and article-c/prompt-2 is answered in another project.
const seedPromptModeHumanAnswers = async (projectId: string) => {
  await insertHumanAnswer({articleId: 'article-a', isAnswered: true, projectId, promptId: 'prompt-2'})
  await insertHumanAnswer({articleId: 'article-b', isAnswered: true, projectId, promptId: 'prompt-1'})
  await insertAnsweredLlmJudgment({articleId: 'article-b', projectId, promptId: 'prompt-1'})
  await insertHumanAnswer({articleId: 'article-c', isAnswered: false, projectId, promptId: 'prompt-1'})
  await insertHumanAnswer({
    articleId: 'article-c',
    isAnswered: true,
    projectId,
    promptId: 'prompt-2',
    rowProjectId: `${projectId}-other`,
  })
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('connection-human-first', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('model-human-first', 'connection-human-first', 'model-human-first', 'model-human-first', 'Model', 'manual', TRUE);
  `)
  queueService = await import('./reviewServingJudgmentJobQueueService.ts')
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('serving refill returns only unassessed pairs with an answered human row in the same project', async () => {
  const projectId = 'project-serving-prompt'

  await seedProject({humanJudgmentMode: 'prompt', projectId})
  await seedActiveServingSnapshot(projectId)
  await seedPromptModeHumanAnswers(projectId)

  expect(await getPairs({humanAnsweredMode: 'prompt', projectId})).toEqual(['article-a:prompt-2'])
  expect(await getPairs({humanAnsweredMode: null, projectId})).toEqual([
    'article-c:prompt-2',
    'article-c:prompt-1',
    'article-b:prompt-2',
    'article-a:prompt-2',
    'article-a:prompt-1',
  ])
})

test('current project table refill applies the same human-answered filter when no serving scope exists', async () => {
  const projectId = 'project-fallback-prompt'

  await seedProject({humanJudgmentMode: 'prompt', projectId})
  await seedPromptModeHumanAnswers(projectId)

  expect(await getPairs({humanAnsweredMode: 'prompt', projectId})).toEqual(['article-a:prompt-2'])
  expect(await getPairs({humanAnsweredMode: null, projectId})).toHaveLength(5)
})

test('summary-mode serving refill returns every unassessed prompt of articles with a non-blank human summary', async () => {
  const projectId = 'project-serving-summary'

  await seedProject({humanJudgmentMode: 'summary', projectId})
  await seedActiveServingSnapshot(projectId)
  await insertHumanSummary({answer: 'yes', articleId: 'article-a', projectId})
  await insertHumanSummary({answer: null, articleId: 'article-b', projectId})
  await insertAnsweredLlmJudgment({articleId: 'article-a', projectId, promptId: 'prompt-1'})

  expect(await getPairs({humanAnsweredMode: 'summary', projectId})).toEqual(['article-a:prompt-2'])
})
