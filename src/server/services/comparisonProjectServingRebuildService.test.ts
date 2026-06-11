import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

import {comparisonProjectDifferenceFilters} from '../../utils/comparisonProjectDifferenceFilter.ts'
import {comparisonProjectRowFilters} from '../../utils/comparisonProjectRowFilter.ts'
import {getComparisonProjectServingRebuildService} from './comparisonProjectServingRebuildService.ts'

type GenerationRow = {generation: string; rowCount: string; tableName: string}

type StatusRow = {
  activeGeneration: string
  servingError: string | null
  servingGeneration: string | null
  servingStatus: string
}

type RebuildBoundaryEvent = {activeTransaction: boolean; kind: string}

const comparisonProjectServingPhaseNames = [
  'cleanup',
  'prompt_cells',
  'promoting',
  'queued',
  'ready',
  'rollups',
  'summary_cells',
]

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getComparisonProjectServingPhaseEventKind = (statement: string) => {
  const phase = comparisonProjectServingPhaseNames.find((phaseName) => {
    return statement.includes(`serving_phase = '${phaseName}'`)
  })

  return phase ? `status:${phase}` : null
}

const getComparisonProjectServingBoundaryQueryEventKind = (statement: string) => {
  const phaseKind = getComparisonProjectServingPhaseEventKind(statement)

  if (phaseKind) {
    return phaseKind
  }

  if (statement.includes('(SELECT COUNT(*) FROM mart.comparison_article_serving')) {
    return 'counts'
  }

  if (statement.includes('FROM app.comparison_project_serving_generation')) {
    return 'status-read'
  }

  return 'query'
}

const getComparisonProjectServingBoundaryQueryRows = <T>(statement: string) => {
  if (statement.includes('RETURNING CAST(serving_generation AS INTEGER) AS generation')) {
    return [{generation: 1}] as T[]
  }

  if (statement.includes('RETURNING comparison_project_id AS comparisonProjectId')) {
    return [{comparisonProjectId: 'comparison-boundary-project'}] as T[]
  }

  if (statement.includes('(SELECT COUNT(*) FROM mart.comparison_article_serving')) {
    return [{stagedArticleCount: 2, stagedCellCount: 4, stagedFilterMemberCount: 6, stagedFilterStatsCount: 8}] as T[]
  }

  if (statement.includes('SELECT') && statement.includes('CAST(active_generation AS INTEGER) AS activeGeneration')) {
    return [
      {
        activeGeneration: 1,
        generationUpdatedAt: new Date('2026-06-11T00:00:00.000Z'),
        servingCompletedAt: new Date('2026-06-11T00:00:00.000Z'),
        servingError: null,
        servingFailedAt: null,
        servingGeneration: 1,
        servingLastProgressedAt: new Date('2026-06-11T00:00:00.000Z'),
        servingPhase: 'ready',
        servingPhaseStartedAt: new Date('2026-06-11T00:00:00.000Z'),
        servingStartedAt: new Date('2026-06-11T00:00:00.000Z'),
        servingStagedArticleCount: 2,
        servingStagedCellCount: 4,
        servingStagedFilterMemberCount: 6,
        servingStagedFilterStatsCount: 8,
        servingStatus: 'ready',
      },
    ] as T[]
  }

  return [] as T[]
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
    const {getComparisonProjectServingCellBuilder} = await import('./src/server/services/comparisonProjectServingCellBuilder.ts')
    const {getComparisonProjectServingGenerationService} = await import('./src/server/services/comparisonProjectServingGenerationService.ts')
    const {getComparisonProjectServingRebuildService} = await import('./src/server/services/comparisonProjectServingRebuildService.ts')
    const {getDuckdbBackgroundRuntimeDiagnostics} = await import('./src/server/utils/duckdbService.ts')

    await migrateDuckdb()

    const database = getAppDatabaseService()
    const service = getComparisonProjectServingRebuildService()
    const comparisonProjectId = '9fd6f6e9-5191-4d3e-a688-d1f86088d93c'

    await database.run(\`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES ('provider-rebuild', 'sglang', 'Provider Rebuild', TRUE, 'none', 'http://localhost:30001/v1')
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
        ('model-a', 'provider-rebuild', 'Model A', 'model-a', 'Model A', 'manual', 'manual', TRUE, '{}'::JSON),
        ('model-b', 'provider-rebuild', 'Model B', 'model-b', 'Model B', 'manual', 'manual', TRUE, '{}'::JSON)
    \`)

    await database.run(\`
      INSERT INTO app.project (
        id,
        name,
        description,
        model_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images
      ) VALUES
        ('source-project', 'Source Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE),
        ('human-project', 'Human Project', NULL, 'model-a', TRUE, TRUE, FALSE, FALSE)
    \`)

    await database.run(\`
      INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, created_at)
      VALUES ('prompt-a', 'Prompt A', 'Prompt A', NULL, 'prompt-a-hash', TIMESTAMPTZ '2026-04-01T00:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.article (
        id,
        article_id,
        article_title,
        article_summary,
        article_created_at,
        article_updated_at
      ) VALUES
        ('article-alpha', 'external-alpha', 'Alpha Article', 'Alpha Summary', TIMESTAMPTZ '2026-04-03T00:00:00.000Z', TIMESTAMPTZ '2026-04-03T01:00:00.000Z'),
        ('article-beta', 'external-beta', 'Beta Article', 'Beta Summary', TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z')
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
      ) VALUES (
        '\${comparisonProjectId}',
        'Comparison Serving Rebuild',
        NULL,
        ['model-a', 'model-b'],
        TRUE,
        'prompt',
        NULL,
        TRUE,
        TRUE,
        FALSE,
        FALSE
      )
    \`)

    await database.run(\`
      INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
      VALUES ('comparison-prompt-a', '\${comparisonProjectId}', 'prompt-a', 0)
    \`)

    await database.run(\`
      INSERT INTO app.judgment (
        id,
        article_id,
        prompt_id,
        model_id,
        project_id,
        is_answered,
        answered_original,
        answered_original_as_array,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        created_at,
        updated_at
      ) VALUES
        ('judgment-alpha-a', 'article-alpha', 'prompt-a', 'model-a', 'source-project', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('judgment-alpha-b', 'article-alpha', 'prompt-a', 'model-b', 'source-project', TRUE, 'no', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-04T00:00:00.000Z', TIMESTAMPTZ '2026-04-04T01:00:00.000Z'),
        ('judgment-beta-a', 'article-beta', 'prompt-a', 'model-a', 'source-project', TRUE, 'yes', NULL, TRUE, TRUE, FALSE, FALSE, TIMESTAMPTZ '2026-04-05T00:00:00.000Z', TIMESTAMPTZ '2026-04-05T01:00:00.000Z')
    \`)

    await database.run(\`
      INSERT INTO app.judgment_human (
        id,
        project_id,
        article_id,
        prompt_id,
        is_answered,
        answer,
        created_at,
        updated_at
      ) VALUES ('human-alpha', 'human-project', 'article-alpha', 'prompt-a', TRUE, 'yes', TIMESTAMPTZ '2026-04-06T00:00:00.000Z', TIMESTAMPTZ '2026-04-06T00:00:00.000Z')
    \`)

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

    const getStatusRow = async () => {
      const [row = null] = await database.queryJson(\`
        SELECT
          CAST(active_generation AS VARCHAR) AS activeGeneration,
          serving_status AS servingStatus,
          CAST(serving_generation AS VARCHAR) AS servingGeneration,
          serving_error AS servingError
        FROM app.comparison_project_serving_generation
        WHERE comparison_project_id = '\${comparisonProjectId}'
        LIMIT 1
      \`)

      return row
    }

    ${body}
  `
}

const runScript = <T>(body: string) => {
  const duckdbPath = `/tmp/f1-comparison-project-serving-rebuild-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.duckdb`
  const runResult = globalThis.Bun.spawnSync(['bun', '-e', getScript(body)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_SERVER_PORT: '3001',
      DUCKDB_MEMORY_LIMIT: '1GB',
      DUCKDB_PATH: duckdbPath,
      DUCKDB_TEMP_DIRECTORY: '/tmp/duckdb-temp',
      SERVER_ROLE: 'dev-single',
      VITE_PORT: '3000',
    },
  })

  try {
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'Comparison serving rebuild test failed',
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

const getRowsByTable = (rows: GenerationRow[]) => {
  return rows.reduce<Record<string, GenerationRow>>((rowMap, row) => {
    return {...rowMap, [row.tableName]: row}
  }, {})
}

test('comparison serving rebuild invokes bulk phases outside transactions and keeps status transitions transactional', async () => {
  const events: RebuildBoundaryEvent[] = []
  let transactionDepth = 0
  const recordEvent = (kind: string) => {
    events.push({activeTransaction: transactionDepth > 0, kind})
  }
  const queryJson = async <T>(statement: string): Promise<T[]> => {
    recordEvent(getComparisonProjectServingBoundaryQueryEventKind(statement))

    return getComparisonProjectServingBoundaryQueryRows<T>(statement)
  }
  const run = async (statement: string) => {
    recordEvent(statement)
  }
  const database = {
    queryJson,
    run,
    transaction: async <T>(operation: (runner: {queryJson: typeof queryJson; run: typeof run}) => Promise<T>) => {
      recordEvent('transaction:start')
      transactionDepth += 1

      try {
        return await operation({queryJson, run})
      } finally {
        transactionDepth -= 1
        recordEvent('transaction:end')
      }
    },
  }
  const getBulkPhase = (phase: string) => {
    return async (_params: {comparisonProjectId: string; generation: number}, runner?: {run: typeof run}) => {
      const phaseRunner = runner ?? database

      recordEvent(`bulk:${phase}`)
      await phaseRunner.run(`bulk-run:${phase}`)
    }
  }
  const service = getComparisonProjectServingRebuildService()

  await service.rebuildComparisonProjectServing('comparison-boundary-project', {
    cellBuilder: {
      insertPromptModeComparisonProjectCells: getBulkPhase('prompt_cells'),
      insertSummaryModeComparisonProjectCells: getBulkPhase('summary_cells'),
    },
    database,
    generationService: {
      cleanupComparisonProjectServingGeneration: async (_comparisonProjectId, _generation, dependencies) => {
        const generationDependencies = dependencies ?? database

        recordEvent('generation:cleanup-staged')

        return generationDependencies.transaction(async () => {
          return {deletedRowCount: 0, tables: []}
        })
      },
      cleanupOldComparisonProjectServingGenerations: async (_comparisonProjectId, dependencies) => {
        const generationDependencies = dependencies ?? database

        recordEvent('generation:cleanup-old')

        return generationDependencies.transaction(async () => {
          return {deletedRowCount: 0, tables: []}
        })
      },
      createInactiveComparisonProjectServingGeneration: async () => {
        recordEvent('generation:create-inactive')

        return 1
      },
      promoteComparisonProjectServingGeneration: async (_comparisonProjectId, _generation, dependencies) => {
        const generationDependencies = dependencies ?? database

        recordEvent('generation:promote')

        return generationDependencies.transaction(async () => {
          return true
        })
      },
    },
    rollupBuilder: {insertComparisonProjectServingRollups: getBulkPhase('rollups')},
  })

  const mutationAndBulkEvents = events
    .filter((event) => {
      return event.kind.startsWith('status:') || event.kind.startsWith('bulk:')
    })
    .map((event) => {
      return event.kind
    })
  const transactionalEvents = events.filter((event) => {
    return event.kind.startsWith('status:') || event.kind.startsWith('generation:')
  })
  const bulkEvents = events.filter((event) => {
    return event.kind.startsWith('bulk:') || event.kind.startsWith('bulk-run:')
  })

  expect(mutationAndBulkEvents).toEqual([
    'status:queued',
    'status:prompt_cells',
    'bulk:prompt_cells',
    'status:prompt_cells',
    'status:summary_cells',
    'bulk:summary_cells',
    'status:summary_cells',
    'status:rollups',
    'bulk:rollups',
    'status:rollups',
    'status:promoting',
    'status:cleanup',
    'status:ready',
  ])
  expect(
    transactionalEvents.every((event) => {
      return event.activeTransaction
    }),
  ).toBe(true)
  expect(
    bulkEvents.every((event) => {
      return !event.activeTransaction
    }),
  ).toBe(true)
})

test('comparison serving rebuild stages builds promotes and records ready status', () => {
  const result = runScript<{
    diagnosticsAfter: {
      effective: {memoryLimit: string | null; tempDirectory: string | null}
      queues: {
        background: {queueDepth: number; tasksCompleted: number; tasksStarted: number}
        main: {queueDepth: number; tasksCompleted: number; tasksStarted: number}
      }
      tempSpill: {available: boolean; tempDirectory: string | null; totalBytes: number | null}
    }
    diagnosticsBefore: {
      queues: {
        background: {tasksCompleted: number; tasksStarted: number}
        main: {tasksCompleted: number; tasksStarted: number}
      }
    }
    rebuildResult: {cleanupResult: {deletedRowCount: number}; generation: number; status: {servingStatus: string}}
    rows: GenerationRow[]
    statusRow: StatusRow
  }>(`
    const diagnosticsBefore = await getDuckdbBackgroundRuntimeDiagnostics()
    const rebuildResult = await service.rebuildComparisonProjectServing(comparisonProjectId)
    const rows = await getGenerationRows()
    const statusRow = await getStatusRow()
    const diagnosticsAfter = await getDuckdbBackgroundRuntimeDiagnostics()

    console.log(JSON.stringify({diagnosticsAfter, diagnosticsBefore, rebuildResult, rows, statusRow}))
    await database.close()
  `)
  const rowsByTable = getRowsByTable(result.rows)

  expect(result.diagnosticsAfter.effective.memoryLimit).not.toBeNull()
  expect(result.diagnosticsAfter.effective.tempDirectory).toBe('/tmp/duckdb-temp')
  expect(result.diagnosticsAfter.tempSpill.available).toBe(true)
  expect(result.diagnosticsAfter.tempSpill.tempDirectory).toBe('/tmp/duckdb-temp')
  expect(result.diagnosticsAfter.tempSpill.totalBytes).not.toBeNull()
  expect(
    result.diagnosticsAfter.queues.background.tasksStarted + result.diagnosticsAfter.queues.main.tasksStarted,
  ).toBeGreaterThan(
    result.diagnosticsBefore.queues.background.tasksStarted + result.diagnosticsBefore.queues.main.tasksStarted,
  )
  expect(
    result.diagnosticsAfter.queues.background.tasksCompleted + result.diagnosticsAfter.queues.main.tasksCompleted,
  ).toBeGreaterThan(
    result.diagnosticsBefore.queues.background.tasksCompleted + result.diagnosticsBefore.queues.main.tasksCompleted,
  )
  expect(result.diagnosticsAfter.queues.background.queueDepth).toBe(0)
  expect(result.diagnosticsAfter.queues.main.queueDepth).toBe(0)
  expect(result.rebuildResult.generation).toBe(1)
  expect(result.rebuildResult.cleanupResult.deletedRowCount).toBe(0)
  expect(result.rebuildResult.status.servingStatus).toBe('ready')
  expect(result.statusRow).toEqual({
    activeGeneration: '1',
    servingError: null,
    servingGeneration: '1',
    servingStatus: 'ready',
  })
  expect(rowsByTable.article?.rowCount).toBe('2')
  expect(rowsByTable.cell?.rowCount).toBe('4')
  expect(Number(rowsByTable.member?.rowCount ?? 0)).toBe(0)
  expect(rowsByTable.stats?.rowCount).toBe(
    String(comparisonProjectRowFilters.length * comparisonProjectDifferenceFilters.length),
  )
})

test('comparison serving rebuild skips duplicate concurrent claims for one project', () => {
  const result = runScript<{
    firstRebuildResult: {generation: number; status: {servingStatus: string}}
    promptBuildCount: number
    promptGenerations: number[]
    promoteCount: number
    promotedGenerations: number[]
    rows: GenerationRow[]
    secondRebuildResult: {generation: number | null; skipped?: boolean; status: {servingStatus: string}}
    statusRow: StatusRow
  }>(`
    const realCellBuilder = getComparisonProjectServingCellBuilder()
    const realGenerationService = getComparisonProjectServingGenerationService()
    const promptGenerations = []
    const promotedGenerations = []
    let firstPromptBuildStartedResolve = () => {}
    let promptBuildReleaseResolve = () => {}
    let promptBuildCount = 0
    let promoteCount = 0
    const firstPromptBuildStarted = new Promise((resolve) => {
      firstPromptBuildStartedResolve = resolve
    })
    const promptBuildRelease = new Promise((resolve) => {
      promptBuildReleaseResolve = resolve
    })
    const rebuildOverrides = {
      cellBuilder: {
        insertPromptModeComparisonProjectCells: async (params, runner) => {
          promptBuildCount += 1
          promptGenerations.push(params.generation)

          if (promptBuildCount === 1) {
            firstPromptBuildStartedResolve()
            await promptBuildRelease
          }

          return realCellBuilder.insertPromptModeComparisonProjectCells(params, runner)
        },
        insertSummaryModeComparisonProjectCells: realCellBuilder.insertSummaryModeComparisonProjectCells,
      },
      generationService: {
        ...realGenerationService,
        promoteComparisonProjectServingGeneration: async (...args) => {
          promoteCount += 1
          promotedGenerations.push(args[1])

          return realGenerationService.promoteComparisonProjectServingGeneration(...args)
        },
      },
    }
    const firstRebuildPromise = service.rebuildComparisonProjectServing(comparisonProjectId, rebuildOverrides)

    await firstPromptBuildStarted

    const secondRebuildPromise = service.rebuildComparisonProjectServing(comparisonProjectId, rebuildOverrides)

    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    promptBuildReleaseResolve()

    const [firstRebuildResult, secondRebuildResult] = await Promise.all([
      firstRebuildPromise,
      secondRebuildPromise,
    ])
    const rows = await getGenerationRows()
    const statusRow = await getStatusRow()

    console.log(JSON.stringify({
      firstRebuildResult,
      promptBuildCount,
      promptGenerations,
      promoteCount,
      promotedGenerations,
      rows,
      secondRebuildResult,
      statusRow,
    }))
    await database.close()
  `)

  expect(result.firstRebuildResult.generation).toBe(1)
  expect(result.firstRebuildResult.status.servingStatus).toBe('ready')
  expect(result.secondRebuildResult.generation).toBe(1)
  expect(result.secondRebuildResult.skipped).toBe(true)
  expect(result.promptBuildCount).toBe(1)
  expect(result.promptGenerations).toEqual([1])
  expect(result.promoteCount).toBe(1)
  expect(result.promotedGenerations).toEqual([1])
  expect(result.statusRow.activeGeneration).toBe('1')
  expect(result.statusRow.servingGeneration).toBe('1')
  expect(result.statusRow.servingStatus).toBe('ready')
  expect(
    result.rows.every((row) => {
      return row.generation === '1'
    }),
  ).toBe(true)
})

test('comparison serving rebuild reclaims expired refreshing status with a newer generation', () => {
  const result = runScript<{
    rebuildResult: {generation: number; status: {servingStatus: string}}
    rows: GenerationRow[]
    statusRow: StatusRow
  }>(`
    await service.rebuildComparisonProjectServing(comparisonProjectId)
    await database.run(\`
      UPDATE app.comparison_project_serving_generation
      SET
        serving_status = 'refreshing',
        serving_generation = 2,
        serving_started_at = TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
        serving_phase = 'prompt_cells',
        serving_phase_started_at = TIMESTAMPTZ '2026-04-01T00:00:00.000Z',
        serving_last_progressed_at = TIMESTAMPTZ '2026-04-01T00:00:00.000Z'
      WHERE comparison_project_id = '\${comparisonProjectId}'
    \`)

    const rebuildResult = await service.rebuildComparisonProjectServing(comparisonProjectId)
    const rows = await getGenerationRows()
    const statusRow = await getStatusRow()

    console.log(JSON.stringify({rebuildResult, rows, statusRow}))
    await database.close()
  `)

  expect(result.rebuildResult.generation).toBe(3)
  expect(result.rebuildResult.status.servingStatus).toBe('ready')
  expect(result.statusRow.activeGeneration).toBe('3')
  expect(result.statusRow.servingGeneration).toBe('3')
  expect(result.statusRow.servingStatus).toBe('ready')
  expect(
    result.rows.every((row) => {
      return row.generation === '3'
    }),
  ).toBe(true)
})

test('comparison serving rebuild failure records error and preserves the active generation', () => {
  const result = runScript<{failureText: string; rows: GenerationRow[]; statusRow: StatusRow}>(`
    await service.rebuildComparisonProjectServing(comparisonProjectId)

    const realCellBuilder = getComparisonProjectServingCellBuilder()
    let failureText = ''

    try {
      await service.rebuildComparisonProjectServing(comparisonProjectId, {
        cellBuilder: {
          insertPromptModeComparisonProjectCells: async (params, runner) => {
            await runner.run(\`
              INSERT INTO mart.comparison_cell_serving (
                comparison_project_id,
                generation,
                article_id,
                column_id,
                column_order,
                kind,
                prompt_id,
                model_id,
                source_project_id,
                content_key,
                display_answer,
                normalized_answers,
                source_created_at,
                source_updated_at
              ) VALUES (
                '\${comparisonProjectId}',
                \${params.generation},
                'article-alpha',
                'llm:model-a:1100:prompt-a',
                0,
                'llm',
                'prompt-a',
                'model-a',
                NULL,
                '1100',
                'partial',
                ['partial'],
                TIMESTAMPTZ '2026-04-08T00:00:00.000Z',
                TIMESTAMPTZ '2026-04-08T00:00:00.000Z'
              )
            \`)
            throw new Error('simulated comparison serving rebuild failure')
          },
          insertSummaryModeComparisonProjectCells: realCellBuilder.insertSummaryModeComparisonProjectCells,
        },
      })
    } catch (error) {
      failureText = error instanceof Error ? error.message : String(error)
    }

    const rows = await getGenerationRows()
    const statusRow = await getStatusRow()

    console.log(JSON.stringify({failureText, rows, statusRow}))
    await database.close()
  `)

  expect(result.failureText).toContain('simulated comparison serving rebuild failure')
  expect(result.statusRow.activeGeneration).toBe('1')
  expect(result.statusRow.servingStatus).toBe('failed')
  expect(result.statusRow.servingGeneration).toBe('2')
  expect(result.statusRow.servingError).toContain('simulated comparison serving rebuild failure')
  expect(
    result.rows.every((row) => {
      return row.generation === '1'
    }),
  ).toBe(true)
})

test('comparison serving stale marker preserves active generation and clears target rebuild fields', () => {
  const result = runScript<{status: {activeGeneration: number | null; servingStatus: string}; statusRow: StatusRow}>(`
    await service.rebuildComparisonProjectServing(comparisonProjectId)
    const status = await service.markComparisonProjectServingStale(comparisonProjectId)
    const statusRow = await getStatusRow()

    console.log(JSON.stringify({status, statusRow}))
    await database.close()
  `)

  expect(result.status.activeGeneration).toBe(1)
  expect(result.status.servingStatus).toBe('stale')
  expect(result.statusRow.activeGeneration).toBe('1')
  expect(result.statusRow.servingError).toBeNull()
  expect(result.statusRow.servingGeneration).toBeNull()
  expect(result.statusRow.servingStatus).toBe('stale')
})

test('comparison serving rebuild treats stale promotion as failed', () => {
  const result = runScript<{failureText: string; rows: GenerationRow[]; statusRow: StatusRow}>(`
    await service.rebuildComparisonProjectServing(comparisonProjectId)

    const realGenerationService = getComparisonProjectServingGenerationService()
    let failureText = ''

    try {
      await service.rebuildComparisonProjectServing(comparisonProjectId, {
        generationService: {
          ...realGenerationService,
          promoteComparisonProjectServingGeneration: async () => {
            return false
          },
        },
      })
    } catch (error) {
      failureText = error instanceof Error ? error.message : String(error)
    }

    const rows = await getGenerationRows()
    const statusRow = await getStatusRow()

    console.log(JSON.stringify({failureText, rows, statusRow}))
    await database.close()
  `)

  expect(result.failureText).toContain('was not promoted')
  expect(result.statusRow.activeGeneration).toBe('1')
  expect(result.statusRow.servingGeneration).toBe('2')
  expect(result.statusRow.servingStatus).toBe('failed')
  expect(
    result.rows.every((row) => {
      return row.generation === '1'
    }),
  ).toBe(true)
})

test('comparison serving rebuild cleans old generations after a successful promotion', () => {
  const result = runScript<{
    rebuildResult: {cleanupResult: {deletedRowCount: number}; generation: number}
    rows: GenerationRow[]
    statusRow: StatusRow
  }>(`
    await service.rebuildComparisonProjectServing(comparisonProjectId)
    const rebuildResult = await service.rebuildComparisonProjectServing(comparisonProjectId)
    const rows = await getGenerationRows()
    const statusRow = await getStatusRow()

    console.log(JSON.stringify({rebuildResult, rows, statusRow}))
    await database.close()
  `)

  expect(result.rebuildResult.generation).toBe(2)
  expect(result.rebuildResult.cleanupResult.deletedRowCount).toBeGreaterThan(0)
  expect(result.statusRow.activeGeneration).toBe('2')
  expect(result.statusRow.servingGeneration).toBe('2')
  expect(result.statusRow.servingStatus).toBe('ready')
  expect(
    result.rows.every((row) => {
      return row.generation === '2'
    }),
  ).toBe(true)
})
