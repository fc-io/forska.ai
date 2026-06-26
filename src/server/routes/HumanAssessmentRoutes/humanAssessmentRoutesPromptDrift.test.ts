import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f2-human-assessment-prompt-drift')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let humanAssessmentRoutesPostInit:
  | typeof import('./humanAssessmentRoutesPostInit.ts').humanAssessmentRoutesPostInit
  | null = null
let humanAssessmentRoutesPostSubmit:
  | typeof import('./humanAssessmentRoutesPostSubmit.ts').humanAssessmentRoutesPostSubmit
  | null = null
let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../services/appDatabaseService.ts'),
      import('../../utils/duckdbService.ts'),
      import('../../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const initModule = await import('./humanAssessmentRoutesPostInit.ts')
  const submitModule = await import('./humanAssessmentRoutesPostSubmit.ts')

  database = getAppDatabaseService()
  humanAssessmentRoutesPostInit = initModule.humanAssessmentRoutesPostInit
  humanAssessmentRoutesPostSubmit = submitModule.humanAssessmentRoutesPostSubmit
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('human assessment init resyncs pending prompt rows after project prompt drift', async () => {
  if (!database || !humanAssessmentRoutesPostInit) {
    throw new Error('Test dependencies not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('human-drift-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('human-drift-model', 'human-drift-connection', 'human-drift-model', 'human-drift-model', 'Human Drift Model', 'manual', TRUE);

    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('human-drift-project', 'Human Drift Project', 'human-drift-model', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('human-drift-old-prompt', 'Old prompt', 'Old prompt', 'string', 'human-drift-old-prompt-hash'),
      ('human-drift-current-prompt', 'Current prompt', 'Current prompt', 'string', 'human-drift-current-prompt-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
    VALUES ('human-drift-old-project-prompt', 'human-drift-project', 'human-drift-old-prompt', 1);

    INSERT INTO app.article (id, article_title)
    VALUES ('human-drift-article', 'Human Drift Article');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('human-drift-project-article', 'human-drift-project', 'human-drift-article');

    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at)
    VALUES ('human-drift-project', 'human-drift-article', TRUE, FALSE, current_timestamp, current_timestamp);
  `)

  const firstSet: {status: number} = {status: 200}
  const firstResponse = await humanAssessmentRoutesPostInit({
    body: {projectId: 'human-drift-project'},
    set: firstSet as never,
  })

  expect(firstResponse.data?.judgmentsHuman).toEqual([expect.objectContaining({promptId: 'human-drift-old-prompt'})])

  await database.run(`
    DELETE FROM app.project_prompt
    WHERE id = 'human-drift-old-project-prompt';

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
    VALUES ('human-drift-current-project-prompt', 'human-drift-project', 'human-drift-current-prompt', 1);
  `)

  const secondSet: {status: number} = {status: 200}
  const secondResponse = await humanAssessmentRoutesPostInit({
    body: {projectId: 'human-drift-project'},
    set: secondSet as never,
  })
  const pendingRows = await database.queryJson<{isAnswered: boolean; promptId: string}>(`
    SELECT prompt_id AS promptId, is_answered AS isAnswered
    FROM app.judgment_human
    WHERE project_id = 'human-drift-project'
      AND article_id = 'human-drift-article'
    ORDER BY prompt_id
  `)

  expect(secondResponse.data?.prompts).toEqual([expect.objectContaining({id: 'human-drift-current-prompt'})])
  expect(secondResponse.data?.judgmentsHuman).toEqual([
    expect.objectContaining({promptId: 'human-drift-current-prompt'}),
  ])
  expect(pendingRows).toEqual([{isAnswered: false, promptId: 'human-drift-current-prompt'}])
})

test('human assessment submit rejects when project prompts are added after init', async () => {
  if (!database || !humanAssessmentRoutesPostInit || !humanAssessmentRoutesPostSubmit) {
    throw new Error('Test dependencies not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('human-submit-drift-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('human-submit-drift-model', 'human-submit-drift-connection', 'human-submit-drift-model', 'human-submit-drift-model', 'Human Submit Drift Model', 'manual', TRUE);

    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('human-submit-drift-project', 'Human Submit Drift Project', 'human-submit-drift-model', TRUE, TRUE, FALSE, FALSE);

    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('human-submit-drift-first-prompt', 'First prompt', 'First prompt', 'string', 'human-submit-drift-first-prompt-hash'),
      ('human-submit-drift-added-prompt', 'Added prompt', 'Added prompt', 'string', 'human-submit-drift-added-prompt-hash');

    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
    VALUES ('human-submit-drift-first-project-prompt', 'human-submit-drift-project', 'human-submit-drift-first-prompt', 1);

    INSERT INTO app.article (id, article_title)
    VALUES ('human-submit-drift-article', 'Human Submit Drift Article');

    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('human-submit-drift-project-article', 'human-submit-drift-project', 'human-submit-drift-article');

    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at, article_updated_at)
    VALUES ('human-submit-drift-project', 'human-submit-drift-article', TRUE, FALSE, current_timestamp, current_timestamp);
  `)

  const initSet: {status: number} = {status: 200}
  const initResponse = await humanAssessmentRoutesPostInit({
    body: {projectId: 'human-submit-drift-project'},
    set: initSet as never,
  })
  const [firstJudgment] = initResponse.data?.judgmentsHuman ?? []

  if (!firstJudgment) {
    throw new Error('Expected initial pending human judgment')
  }

  await database.run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order)
    VALUES ('human-submit-drift-added-project-prompt', 'human-submit-drift-project', 'human-submit-drift-added-prompt', 2);
  `)

  const submitSet: {status: number} = {status: 200}
  const submitResponse = await humanAssessmentRoutesPostSubmit({
    body: {answers: [{answer: 'yes', judgmentHumanId: firstJudgment.id}], projectId: 'human-submit-drift-project'},
    set: submitSet as never,
  })
  const pendingRows = await database.queryJson<{isAnswered: boolean; promptId: string}>(`
    SELECT prompt_id AS promptId, is_answered AS isAnswered
    FROM app.judgment_human
    WHERE project_id = 'human-submit-drift-project'
      AND article_id = 'human-submit-drift-article'
    ORDER BY prompt_id
  `)

  expect(submitSet.status).toBe(400)
  expect(submitResponse).toEqual({data: null, error: 'Missing answers for one or more required prompts'})
  expect(pendingRows).toEqual([
    {isAnswered: false, promptId: 'human-submit-drift-added-prompt'},
    {isAnswered: false, promptId: 'human-submit-drift-first-prompt'},
  ])
})
