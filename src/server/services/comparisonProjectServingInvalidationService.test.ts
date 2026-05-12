import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

type InvalidationResult = {markedIds: string[]; staleIds: string[]}

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  const lines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })

  return lines.at(-1) ?? ''
}

const getScript = (body: string) => {
  return `
    const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
    const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
    const {getComparisonProjectServingInvalidationService} = await import('./src/server/services/comparisonProjectServingInvalidationService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const service = getComparisonProjectServingInvalidationService()

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-invalidation', 'sglang', 'Provider Invalidation', TRUE, 'none', 'http://localhost:30001/v1')
    \`)

    await database.run(\`
      INSERT INTO app.model (
        id,
        provider_connection_id,
        name,
        remote_model_id,
        display_name,
        variant,
        source,
        enabled,
        metadata_json
      ) VALUES
        ('model-a', 'provider-invalidation', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-invalidation', 'Model B', 'model-b', 'Model B', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        description,
        model_id,
        human_judgment_mode,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('source-project-a', 'Source Project A', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE),
        ('source-project-out', 'Source Project Out', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE),
        ('summary-human-project', 'Summary Human Project', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE),
        ('summary-human-other', 'Summary Human Other', NULL, 'model-a', 'summary', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES
        ('prompt-a', 'Prompt A', 'Prompt A', NULL, 'prompt-a-hash', TIMESTAMPTZ '2026-04-01T00:00:00.000Z'),
        ('prompt-b', 'Prompt B', 'Prompt B', NULL, 'prompt-b-hash', TIMESTAMPTZ '2026-04-02T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.project_prompt (
        id,
        project_id,
        prompt_id,
        prompt_order,
        enabled,
        criteria_disposition,
        criteria_section_key,
        criteria_section_label
      ) VALUES
        ('source-project-a-prompt-a', 'source-project-a', 'prompt-a', 0, TRUE, 'include', 'eligibility', 'Eligibility'),
        ('source-project-out-prompt-a', 'source-project-out', 'prompt-a', 0, TRUE, 'include', 'eligibility', 'Eligibility')
    \`)

    await database.run(\`
      INSERT INTO app.article (id, article_title)
      VALUES
        ('article-in', 'Article In Scope'),
        ('article-out', 'Article Out Of Scope')
    \`)

    await database.run(\`
      INSERT INTO app.project_article (id, project_id, article_id)
      VALUES
        ('source-project-a-article-in', 'source-project-a', 'article-in'),
        ('source-project-out-article-out', 'source-project-out', 'article-out')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project (
        id,
        name,
        description,
        model_ids,
        compare_with_humans,
        human_judgment_mode,
        summary_source_project_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('cp-llm-match', 'LLM Match', NULL, ['model-a'], FALSE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-llm-wrong-model', 'LLM Wrong Model', NULL, ['model-b'], FALSE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-llm-wrong-prompt', 'LLM Wrong Prompt', NULL, ['model-a'], FALSE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-llm-wrong-content', 'LLM Wrong Content', NULL, ['model-a'], FALSE, 'prompt', NULL, FALSE, FALSE, TRUE, FALSE),
        ('cp-llm-wrong-scope', 'LLM Wrong Scope', NULL, ['model-a'], FALSE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-summary-llm-match', 'Summary LLM Match', NULL, ['model-a'], TRUE, 'summary', 'summary-human-project', TRUE, TRUE, FALSE, FALSE),
        ('cp-human-prompt-match', 'Human Prompt Match', NULL, ['model-a'], TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-human-prompt-wrong-prompt', 'Human Prompt Wrong Prompt', NULL, ['model-a'], TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-human-prompt-wrong-scope', 'Human Prompt Wrong Scope', NULL, ['model-a'], TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE),
        ('cp-human-summary-match', 'Human Summary Match', NULL, ['model-a'], TRUE, 'summary', 'summary-human-project', TRUE, TRUE, FALSE, FALSE),
        ('cp-human-summary-wrong-source', 'Human Summary Wrong Source', NULL, ['model-a'], TRUE, 'summary', 'summary-human-other', TRUE, TRUE, FALSE, FALSE),
        ('cp-human-summary-wrong-scope', 'Human Summary Wrong Scope', NULL, ['model-a'], TRUE, 'summary', 'summary-human-project', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
      VALUES
        ('cp-llm-match-prompt-a', 'cp-llm-match', 'prompt-a', 0),
        ('cp-llm-wrong-model-prompt-a', 'cp-llm-wrong-model', 'prompt-a', 0),
        ('cp-llm-wrong-prompt-prompt-b', 'cp-llm-wrong-prompt', 'prompt-b', 0),
        ('cp-llm-wrong-content-prompt-a', 'cp-llm-wrong-content', 'prompt-a', 0),
        ('cp-llm-wrong-scope-prompt-a', 'cp-llm-wrong-scope', 'prompt-a', 0),
        ('cp-human-prompt-match-prompt-a', 'cp-human-prompt-match', 'prompt-a', 0),
        ('cp-human-prompt-wrong-prompt-prompt-b', 'cp-human-prompt-wrong-prompt', 'prompt-b', 0),
        ('cp-human-prompt-wrong-scope-prompt-a', 'cp-human-prompt-wrong-scope', 'prompt-a', 0)
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
      VALUES
        ('cp-llm-match-source', 'cp-llm-match', 'source-project-a'),
        ('cp-llm-wrong-model-source', 'cp-llm-wrong-model', 'source-project-a'),
        ('cp-llm-wrong-prompt-source', 'cp-llm-wrong-prompt', 'source-project-a'),
        ('cp-llm-wrong-content-source', 'cp-llm-wrong-content', 'source-project-a'),
        ('cp-llm-wrong-scope-source', 'cp-llm-wrong-scope', 'source-project-out'),
        ('cp-summary-llm-match-source', 'cp-summary-llm-match', 'source-project-a'),
        ('cp-human-prompt-match-source', 'cp-human-prompt-match', 'source-project-a'),
        ('cp-human-prompt-wrong-prompt-source', 'cp-human-prompt-wrong-prompt', 'source-project-a'),
        ('cp-human-prompt-wrong-scope-source', 'cp-human-prompt-wrong-scope', 'source-project-out'),
        ('cp-human-summary-match-source', 'cp-human-summary-match', 'source-project-a'),
        ('cp-human-summary-wrong-source-source', 'cp-human-summary-wrong-source', 'source-project-a'),
        ('cp-human-summary-wrong-scope-source', 'cp-human-summary-wrong-scope', 'source-project-out')
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_serving_generation (
        comparison_project_id,
        active_generation,
        generation_updated_at,
        serving_status,
        serving_generation,
        serving_completed_at
      )
      SELECT id, 1, current_timestamp, 'ready', 1, current_timestamp
      FROM app.comparison_project
    \`)

    const getStaleIds = async () => {
      const rows = await database.queryJson(\`
        SELECT comparison_project_id AS comparisonProjectId
        FROM app.comparison_project_serving_generation
        WHERE serving_status = 'stale'
        ORDER BY comparison_project_id ASC
      \`)

      return rows.map((row) => row.comparisonProjectId)
    }

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-comparison-project-serving-invalidation-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_PATH: duckdbPath,
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'Comparison serving invalidation test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
  }
}

test('LLM judgment changes stale comparison projects only when dependencies overlap', () => {
  const result = runScript<InvalidationResult>(`
    const markedIds = await service.markComparisonProjectsServingStaleForLlmJudgments([
      {
        articleId: 'article-in',
        promptId: 'prompt-a',
        modelId: 'model-a',
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      },
    ])
    console.log(JSON.stringify({markedIds, staleIds: await getStaleIds()}))
  `)

  expect(result.markedIds).toEqual([
    'cp-human-prompt-match',
    'cp-human-summary-match',
    'cp-human-summary-wrong-source',
    'cp-llm-match',
    'cp-summary-llm-match',
  ])
  expect(result.staleIds).toEqual([
    'cp-human-prompt-match',
    'cp-human-summary-match',
    'cp-human-summary-wrong-source',
    'cp-llm-match',
    'cp-summary-llm-match',
  ])
})

test('human prompt judgment changes stale prompt-mode comparison projects only', () => {
  const result = runScript<InvalidationResult>(`
    const markedIds = await service.markComparisonProjectsServingStaleForHumanPromptJudgments([
      {articleId: 'article-in', promptId: 'prompt-a'},
    ])
    console.log(JSON.stringify({markedIds, staleIds: await getStaleIds()}))
  `)

  expect(result.markedIds).toEqual(['cp-human-prompt-match'])
  expect(result.staleIds).toEqual(['cp-human-prompt-match'])
})

test('human summary judgment changes stale summary-mode comparison projects only', () => {
  const result = runScript<InvalidationResult>(`
    const markedIds = await service.markComparisonProjectsServingStaleForHumanSummaryJudgments([
      {articleId: 'article-in', projectId: 'summary-human-project'},
    ])
    console.log(JSON.stringify({markedIds, staleIds: await getStaleIds()}))
  `)

  expect(result.markedIds).toEqual(['cp-human-summary-match', 'cp-summary-llm-match'])
  expect(result.staleIds).toEqual(['cp-human-summary-match', 'cp-summary-llm-match'])
})
