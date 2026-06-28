import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

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
    const {getComparisonProjectServingGenerationService} = await import('./src/server/services/comparisonProjectServingGenerationService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const service = getComparisonProjectServingGenerationService()
    const comparisonProjectId = 'comparison-serving-project'

    const insertComparisonServingRows = async (generation, articleId = 'article-' + generation) => {
      await database.run(\`
        INSERT INTO mart.comparison_article_serving (
          comparison_project_id,
          generation,
          article_id,
          article_created_at,
          article_updated_at,
          article_title,
          row_sort_created_at,
          row_sort_title,
          row_sort_article_id,
          answered_prompt_count,
          answered_column_count,
          answered_llm_column_count,
          answered_human_column_count,
          required_column_count,
          required_llm_column_count,
          required_human_column_count,
          has_all_llm_columns,
          has_all_human_columns,
          has_multiple_answers,
          is_fully_answered,
          passes_row_filter_multiple_answers,
          passes_row_filter_fully_answered,
          passes_row_filter_all,
          has_human_vs_llm_difference,
          has_llm_vs_llm_difference,
          has_any_disagreement,
          passes_difference_filter_human_vs_llm,
          passes_difference_filter_llm_vs_llm,
          passes_difference_filter_any_disagreement,
          passes_difference_filter_all,
          has_conflict
        ) VALUES (
          '\${comparisonProjectId}',
          \${generation},
          '\${articleId}',
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
          TIMESTAMPTZ '2026-04-01T01:00:00.000Z',
          'Article \${articleId}',
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
          'Article \${articleId}',
          '\${articleId}',
          1,
          1,
          1,
          0,
          1,
          1,
          0,
          TRUE,
          FALSE,
          FALSE,
          TRUE,
          FALSE,
          TRUE,
          TRUE,
          FALSE,
          FALSE,
          FALSE,
          TRUE,
          TRUE,
          TRUE,
          TRUE,
          FALSE
        )
      \`)
      await database.run(\`
        INSERT INTO mart.comparison_cell_serving (
          comparison_project_id,
          generation,
          article_id,
          column_id,
          column_order,
          kind,
          prompt_id,
          model_id,
          content_key,
          display_answer,
          normalized_answers,
          source_created_at,
          source_updated_at
        ) VALUES (
          '\${comparisonProjectId}',
          \${generation},
          '\${articleId}',
          'llm:model-1:1100:prompt-1',
          0,
          'llm',
          'prompt-1',
          'model-1',
          '1100',
          'yes',
          ['yes'],
          TIMESTAMPTZ '2026-04-02T00:00:00.000Z',
          TIMESTAMPTZ '2026-04-02T01:00:00.000Z'
        )
      \`)
      await database.run(\`
        INSERT INTO mart.comparison_article_identifier_serving (
          comparison_project_id,
          generation,
          article_id,
          source_identifier_id,
          kind,
          normalized_value,
          source,
          is_primary
        ) VALUES (
          '\${comparisonProjectId}',
          \${generation},
          '\${articleId}',
          'identifier-\${articleId}',
          'doi',
          '10.1000/\${articleId}',
          'test',
          TRUE
        )
      \`)
      await database.run(\`
        INSERT INTO mart.comparison_filter_member (
          comparison_project_id,
          generation,
          row_filter,
          difference_filter,
          article_id,
          ordinal,
          article_created_at,
          article_title
        ) VALUES (
          '\${comparisonProjectId}',
          \${generation},
          'all',
          'all',
          '\${articleId}',
          \${generation},
          TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
          'Article \${articleId}'
        )
      \`)
      await database.run(\`
        INSERT INTO mart.comparison_filter_stats (
          comparison_project_id,
          generation,
          row_filter,
          difference_filter,
          total_count
        ) VALUES (
          '\${comparisonProjectId}',
          \${generation},
          'all',
          'all',
          1
        )
      \`)
    }

    const getGenerationRows = async () => {
      return database.queryJson(\`
        SELECT 'article' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
        FROM mart.comparison_article_serving
        WHERE comparison_project_id = '\${comparisonProjectId}'
        GROUP BY generation
        UNION ALL
        SELECT 'cell' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
        FROM mart.comparison_cell_serving
        WHERE comparison_project_id = '\${comparisonProjectId}'
        GROUP BY generation
        UNION ALL
        SELECT 'identifier' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
        FROM mart.comparison_article_identifier_serving
        WHERE comparison_project_id = '\${comparisonProjectId}'
        GROUP BY generation
        UNION ALL
        SELECT 'member' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
        FROM mart.comparison_filter_member
        WHERE comparison_project_id = '\${comparisonProjectId}'
        GROUP BY generation
        UNION ALL
        SELECT 'stats' AS tableName, CAST(generation AS VARCHAR) AS generation, CAST(COUNT(*) AS VARCHAR) AS rowCount
        FROM mart.comparison_filter_stats
        WHERE comparison_project_id = '\${comparisonProjectId}'
        GROUP BY generation
        ORDER BY tableName ASC, generation ASC
      \`)
    }

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-comparison-project-serving-generation-${Date.now()}-${Math.random()
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
        runResult.stderr.toString() || runResult.stdout.toString() || 'Comparison serving generation test failed',
      )
    }

    return JSON.parse(getLastJsonLine(runResult.stdout.toString())) as T
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
    removeFileIfExists('/tmp/duckdb-temp')
  }
}

test('missing comparison serving generation reads as null and staging stays inactive', () => {
  const result = runScript<{
    activeAfterStaging: number | null
    activeBeforeStaging: number | null
    generationRow: {activeGeneration: string} | null
    stagedGeneration: number
  }>(`
    const activeBeforeStaging = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)
    const stagedGeneration = await service.createInactiveComparisonProjectServingGeneration(comparisonProjectId)
    const activeAfterStaging = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)
    const [generationRow = null] = await database.queryJson(\`
      SELECT CAST(active_generation AS VARCHAR) AS activeGeneration
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = '\${comparisonProjectId}'
    \`)

    console.log(JSON.stringify({activeAfterStaging, activeBeforeStaging, generationRow, stagedGeneration}))
    await database.close()
  `)

  expect(result.activeBeforeStaging).toBeNull()
  expect(result.stagedGeneration).toBe(1)
  expect(result.activeAfterStaging).toBeNull()
  expect(result.generationRow).toEqual({activeGeneration: '0'})
})

test('comparison serving promotion activates only the staged next generation', () => {
  const result = runScript<{
    activeAfterPromotion: number | null
    activeAfterStalePromotion: number | null
    promoted: boolean
    skippedPromotion: boolean
    stagedGeneration: number
    stalePromoted: boolean
  }>(`
    const stagedGeneration = await service.createInactiveComparisonProjectServingGeneration(comparisonProjectId)
    const skippedPromotion = await service.promoteComparisonProjectServingGeneration(comparisonProjectId, stagedGeneration + 1)
    const promoted = await service.promoteComparisonProjectServingGeneration(comparisonProjectId, stagedGeneration)
    const activeAfterPromotion = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)
    const stalePromoted = await service.promoteComparisonProjectServingGeneration(comparisonProjectId, stagedGeneration)
    const activeAfterStalePromotion = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)

    console.log(JSON.stringify({
      activeAfterPromotion,
      activeAfterStalePromotion,
      promoted,
      skippedPromotion,
      stagedGeneration,
      stalePromoted,
    }))
    await database.close()
  `)

  expect(result.stagedGeneration).toBe(1)
  expect(result.skippedPromotion).toBe(false)
  expect(result.promoted).toBe(true)
  expect(result.activeAfterPromotion).toBe(1)
  expect(result.stalePromoted).toBe(false)
  expect(result.activeAfterStalePromotion).toBe(1)
})

test('comparison serving cleanup removes old generations without deleting active rows', () => {
  const result = runScript<{
    activeGeneration: number | null
    cleanupResult: {deletedRowCount: number}
    rowsAfterCleanup: Array<{generation: string; rowCount: string; tableName: string}>
    rowsBeforeCleanup: Array<{generation: string; rowCount: string; tableName: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation)
      VALUES ('\${comparisonProjectId}', 2)
    \`)
    await insertComparisonServingRows(1)
    await insertComparisonServingRows(2)

    const rowsBeforeCleanup = await getGenerationRows()
    const cleanupResult = await service.cleanupOldComparisonProjectServingGenerations(comparisonProjectId)
    const rowsAfterCleanup = await getGenerationRows()
    const activeGeneration = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)

    console.log(JSON.stringify({activeGeneration, cleanupResult, rowsAfterCleanup, rowsBeforeCleanup}))
    await database.close()
  `)

  expect(result.activeGeneration).toBe(2)
  expect(result.cleanupResult.deletedRowCount).toBe(5)
  expect(result.rowsBeforeCleanup).toEqual([
    {generation: '1', rowCount: '1', tableName: 'article'},
    {generation: '2', rowCount: '1', tableName: 'article'},
    {generation: '1', rowCount: '1', tableName: 'cell'},
    {generation: '2', rowCount: '1', tableName: 'cell'},
    {generation: '1', rowCount: '1', tableName: 'identifier'},
    {generation: '2', rowCount: '1', tableName: 'identifier'},
    {generation: '1', rowCount: '1', tableName: 'member'},
    {generation: '2', rowCount: '1', tableName: 'member'},
    {generation: '1', rowCount: '1', tableName: 'stats'},
    {generation: '2', rowCount: '1', tableName: 'stats'},
  ])
  expect(result.rowsAfterCleanup).toEqual([
    {generation: '2', rowCount: '1', tableName: 'article'},
    {generation: '2', rowCount: '1', tableName: 'cell'},
    {generation: '2', rowCount: '1', tableName: 'identifier'},
    {generation: '2', rowCount: '1', tableName: 'member'},
    {generation: '2', rowCount: '1', tableName: 'stats'},
  ])
})

test('comparison serving explicit cleanup refuses the active generation', () => {
  const result = runScript<{
    activeCleanupResult: {deletedRowCount: number}
    stagedCleanupResult: {deletedRowCount: number}
    rowsAfterCleanup: Array<{generation: string; rowCount: string; tableName: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation)
      VALUES ('\${comparisonProjectId}', 1)
    \`)
    await insertComparisonServingRows(1)
    await insertComparisonServingRows(2)

    const activeCleanupResult = await service.cleanupComparisonProjectServingGeneration(comparisonProjectId, 1)
    const stagedCleanupResult = await service.cleanupComparisonProjectServingGeneration(comparisonProjectId, 2)
    const rowsAfterCleanup = await getGenerationRows()

    console.log(JSON.stringify({activeCleanupResult, rowsAfterCleanup, stagedCleanupResult}))
    await database.close()
  `)

  expect(result.activeCleanupResult.deletedRowCount).toBe(0)
  expect(result.stagedCleanupResult.deletedRowCount).toBe(5)
  expect(result.rowsAfterCleanup).toEqual([
    {generation: '1', rowCount: '1', tableName: 'article'},
    {generation: '1', rowCount: '1', tableName: 'cell'},
    {generation: '1', rowCount: '1', tableName: 'identifier'},
    {generation: '1', rowCount: '1', tableName: 'member'},
    {generation: '1', rowCount: '1', tableName: 'stats'},
  ])
})

test('comparison serving full cleanup removes mart rows and the generation status row', () => {
  const result = runScript<{
    activeAfterCleanup: number | null
    cleanupResult: {deletedRowCount: number}
    generationRowsAfterCleanup: Array<{comparisonProjectId: string}>
    rowsAfterCleanup: Array<{generation: string; rowCount: string; tableName: string}>
    rowsBeforeCleanup: Array<{generation: string; rowCount: string; tableName: string}>
  }>(`
    await database.run(\`
      INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation)
      VALUES ('\${comparisonProjectId}', 1)
    \`)
    await insertComparisonServingRows(1)
    await insertComparisonServingRows(2)

    const rowsBeforeCleanup = await getGenerationRows()
    const cleanupResult = await service.cleanupComparisonProjectServing(comparisonProjectId)
    const rowsAfterCleanup = await getGenerationRows()
    const activeAfterCleanup = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)
    const generationRowsAfterCleanup = await database.queryJson(\`
      SELECT comparison_project_id AS comparisonProjectId
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = '\${comparisonProjectId}'
    \`)

    console.log(JSON.stringify({
      activeAfterCleanup,
      cleanupResult,
      generationRowsAfterCleanup,
      rowsAfterCleanup,
      rowsBeforeCleanup,
    }))
    await database.close()
  `)

  expect(result.cleanupResult.deletedRowCount).toBe(11)
  expect(result.activeAfterCleanup).toBeNull()
  expect(result.generationRowsAfterCleanup).toEqual([])
  expect(result.rowsBeforeCleanup).toEqual([
    {generation: '1', rowCount: '1', tableName: 'article'},
    {generation: '2', rowCount: '1', tableName: 'article'},
    {generation: '1', rowCount: '1', tableName: 'cell'},
    {generation: '2', rowCount: '1', tableName: 'cell'},
    {generation: '1', rowCount: '1', tableName: 'identifier'},
    {generation: '2', rowCount: '1', tableName: 'identifier'},
    {generation: '1', rowCount: '1', tableName: 'member'},
    {generation: '2', rowCount: '1', tableName: 'member'},
    {generation: '1', rowCount: '1', tableName: 'stats'},
    {generation: '2', rowCount: '1', tableName: 'stats'},
  ])
  expect(result.rowsAfterCleanup).toEqual([])
})

test('failed comparison serving rebuild path preserves the last active generation', () => {
  const result = runScript<{
    activeAfterCleanup: number | null
    activeAfterFailure: number | null
    cleanupResult: {deletedRowCount: number}
    failureText: string
    rowsAfterCleanup: Array<{generation: string; rowCount: string; tableName: string}>
    rowsAfterFailure: Array<{generation: string; rowCount: string; tableName: string}>
    stagedGeneration: number
  }>(`
    await database.run(\`
      INSERT INTO app.comparison_project_serving_generation (comparison_project_id, active_generation)
      VALUES ('\${comparisonProjectId}', 1)
    \`)
    await insertComparisonServingRows(1)

    let stagedGeneration = null
    let failureText = ''

    try {
      stagedGeneration = await service.createInactiveComparisonProjectServingGeneration(comparisonProjectId)
      await insertComparisonServingRows(stagedGeneration)
      throw new Error('simulated comparison serving rebuild failure')
    } catch (error) {
      failureText = error instanceof Error ? error.message : String(error)
    }

    const activeAfterFailure = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)
    const rowsAfterFailure = await getGenerationRows()
    const cleanupResult = await service.cleanupComparisonProjectServingGeneration(comparisonProjectId, stagedGeneration)
    const activeAfterCleanup = await service.getActiveComparisonProjectServingGeneration(comparisonProjectId)
    const rowsAfterCleanup = await getGenerationRows()

    console.log(JSON.stringify({
      activeAfterCleanup,
      activeAfterFailure,
      cleanupResult,
      failureText,
      rowsAfterCleanup,
      rowsAfterFailure,
      stagedGeneration,
    }))
    await database.close()
  `)

  expect(result.stagedGeneration).toBe(2)
  expect(result.failureText).toContain('simulated comparison serving rebuild failure')
  expect(result.activeAfterFailure).toBe(1)
  expect(result.activeAfterCleanup).toBe(1)
  expect(result.cleanupResult.deletedRowCount).toBe(5)
  expect(result.rowsAfterFailure).toEqual([
    {generation: '1', rowCount: '1', tableName: 'article'},
    {generation: '2', rowCount: '1', tableName: 'article'},
    {generation: '1', rowCount: '1', tableName: 'cell'},
    {generation: '2', rowCount: '1', tableName: 'cell'},
    {generation: '1', rowCount: '1', tableName: 'identifier'},
    {generation: '2', rowCount: '1', tableName: 'identifier'},
    {generation: '1', rowCount: '1', tableName: 'member'},
    {generation: '2', rowCount: '1', tableName: 'member'},
    {generation: '1', rowCount: '1', tableName: 'stats'},
    {generation: '2', rowCount: '1', tableName: 'stats'},
  ])
  expect(result.rowsAfterCleanup).toEqual([
    {generation: '1', rowCount: '1', tableName: 'article'},
    {generation: '1', rowCount: '1', tableName: 'cell'},
    {generation: '1', rowCount: '1', tableName: 'identifier'},
    {generation: '1', rowCount: '1', tableName: 'member'},
    {generation: '1', rowCount: '1', tableName: 'stats'},
  ])
})
