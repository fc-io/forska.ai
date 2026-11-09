import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('reproject-human-status-route')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type TestDatabase = {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: TestDatabase | null = null

const projectId = 'reproject-summary-project'
const snapshotId = 'reproject-snapshot'
const projectionIdentity = 'humanStatus:reproject-identity'
const articleIds = ['article-a', 'article-b', 'article-c'] as const

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getApp = () => {
  if (app === null) {
    throw new Error('Test app not initialized')
  }

  return app
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {projectsRoutesPostReprojectHumanStatus}] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('./projectsRoutesPostReprojectHumanStatus.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().post(
    '/api/projects/:id/review-serving/reproject-human-status',
    projectsRoutesPostReprojectHumanStatus,
  )
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

const seedSummaryModeProject = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('reproject-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('reproject-model', 'reproject-connection', 'model', 'model', 'Model', 'manual', TRUE);
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, human_judgment_mode
    )
    VALUES ('${projectId}', 'Reproject summary project', 'reproject-model', TRUE, TRUE, FALSE, FALSE, 'summary');
    INSERT INTO app.prompt (id, original_text) VALUES ('reproject-prompt-1', 'One?'), ('reproject-prompt-2', 'Two?');
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order) VALUES
      ('reproject-project-prompt-1', '${projectId}', 'reproject-prompt-1', 1),
      ('reproject-project-prompt-2', '${projectId}', 'reproject-prompt-2', 2);
    INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${articleId}', '${articleId}', current_timestamp, current_timestamp)`
      })
      .join(', ')};
    INSERT INTO app.judgment_human_summary (id, project_id, article_id, answer, origin) VALUES
      ('${projectId}:article-a:summary', '${projectId}', 'article-a', 'no', 'covidence_import'),
      ('${projectId}:article-b:summary', '${projectId}', 'article-b', 'yes', 'covidence_import'),
      ('${projectId}:article-c:summary', '${projectId}', 'article-c', NULL, 'covidence_import');
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, activated_at
    )
    VALUES (
      '${projectId}', '${snapshotId}', 'active', 'review:reproject', '{}',
      '{"required":[{"baseGeneration":7,"component":"humanStatus","patchWatermark":0,"projectionIdentity":"${projectionIdentity}"}],"optional":[]}'::JSON,
      '["humanStatus"]'::JSON, '[]', '{}', current_timestamp
    );
    INSERT INTO mart.review_article_serving_base_v4 (
      project_id, review_config_hash, snapshot_id, base_generation, patch_watermark, article_id, sort_key,
      activity_sort_at, article_created_at
    )
    VALUES ${articleIds
      .map((articleId) => {
        return `('${projectId}', 'review:reproject', '${snapshotId}', 7, 0, '${articleId}', current_timestamp, current_timestamp, current_timestamp)`
      })
      .join(', ')};
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id, review_config_hash, snapshot_id, article_id, has_human_list_mode, has_both_list_mode,
      human_status, llm_patch_watermark, human_patch_watermark, both_patch_watermark, unassessed_patch_watermark
    )
    VALUES
      ('${projectId}', 'review:reproject', '${snapshotId}', 'article-a', TRUE, TRUE, 'unanswered', 0, 45407, 45407, 0),
      ('${projectId}', 'review:reproject', '${snapshotId}', 'article-b', TRUE, TRUE, 'answered', 0, 0, 0, 0),
      ('${projectId}', 'review:reproject', '${snapshotId}', 'article-c', TRUE, TRUE, 'unanswered', 0, 0, 0, 0);
  `)
}

const postReproject = async (id: string) => {
  return getApp().handle(
    new Request(`http://localhost/api/projects/${id}/review-serving/reproject-human-status`, {method: 'POST'}),
  )
}

test('reproject human status route re-derives summary-mode statuses through the range replacement', async () => {
  await seedSummaryModeProject()

  const response = await postReproject(projectId)
  const body = (await response.json()) as {
    data: {
      answered: number
      humanJudgmentMode: string
      noStatus: number
      rangeCount: number
      rowsUpdated: number
      snapshots: Array<{after: Record<string, number>; baseGenerations: number[]; before: Record<string, number>}>
      unanswered: number
    }
  }
  const states = await getDatabase().queryJson<{articleId: string; humanPatchWatermark: number; humanStatus: string}>(`
    SELECT article_id AS articleId, human_status AS humanStatus, human_patch_watermark AS humanPatchWatermark
    FROM mart.review_article_serving_list_mode_state_v4
    WHERE project_id = '${projectId}'
    ORDER BY article_id
  `)

  expect(response.status).toBe(200)
  expect(body.data).toMatchObject({
    answered: 2,
    humanJudgmentMode: 'summary',
    noStatus: 0,
    rangeCount: 1,
    rowsUpdated: 3,
    unanswered: 1,
  })
  expect(body.data.snapshots).toHaveLength(1)
  expect(body.data.snapshots[0]).toMatchObject({
    after: {answered: 2, noStatus: 0, rows: 3, unanswered: 1},
    baseGenerations: [7],
    before: {answered: 1, noStatus: 0, rows: 3, unanswered: 2},
  })
  expect(
    states.map((state) => {
      return [state.articleId, state.humanStatus, Number(state.humanPatchWatermark)]
    }),
  ).toEqual([
    ['article-a', 'answered', 45407],
    ['article-b', 'answered', 0],
    ['article-c', 'unanswered', 0],
  ])
})

test('reproject human status route returns 404 for an unknown project', async () => {
  const response = await postReproject('missing-project')

  expect(response.status).toBe(404)
})
