import {expect, test} from 'bun:test'

import {
  intakeReviewImportDeltasToDirtyWork,
  type ReviewImportDeltaDirtyIntakeDatabase,
} from './reviewImportDeltaDirtyIntakeService.ts'
import {getReviewServingInvalidationRule} from './reviewServingInvalidationRegistry.ts'

type StagedDirtyWorkRow = {
  article_id: string | null
  dirty_kind: string
  dirty_range_end: string | null
  dirty_range_start: string | null
  dirty_work_id: string
  first_source_high_water_mark: number
  latest_delta_id: string | null
  latest_source_high_water_mark: number
  project_id: string | null
  projection_component: string
  projection_identity: string
  projection_key: string
  scope_id: string
  scope_kind: string
  source_partition: string
}

const getLimit = (statement: string) => {
  return Number(statement.match(/LIMIT\s+(\d+)/u)?.[1] ?? 0)
}

const getStagedDirtyWorkRows = (statement: string) => {
  const [rows = [], projections = [], scopes = []] = [...statement.matchAll(/'([^']*(?:''[^']*)*)'/gu)]
    .map((match) => {
      return match[1]?.replaceAll("''", "'") ?? ''
    })
    .filter((literal) => {
      return literal.startsWith('[[') && literal !== '[["VARCHAR"]]'
    })
    .map((literal) => {
      return JSON.parse(literal) as (string | null)[][]
    })
  const projectionsByIndex = new Map(
    projections.map((projection) => {
      return [projection[0], projection] as const
    }),
  )
  const scopesByIndex = new Map(
    scopes.map((scope) => {
      return [scope[0], scope] as const
    }),
  )

  return rows.map((row): StagedDirtyWorkRow => {
    const projection = projectionsByIndex.get(row[3] ?? null) ?? []
    const scope = scopesByIndex.get(row[4] ?? null) ?? []

    return {
      article_id: scope[4] ?? null,
      dirty_kind: scope[5] ?? '',
      dirty_range_end: scope[11] ?? null,
      dirty_range_start: scope[10] ?? null,
      dirty_work_id: row[1] ?? '',
      first_source_high_water_mark: Number(scope[7]),
      latest_delta_id: scope[9] ?? null,
      latest_source_high_water_mark: Number(scope[8]),
      project_id: scope[1] ?? null,
      projection_component: projection[1] ?? '',
      projection_identity: projection[2] ?? '',
      projection_key: projection[3] ?? '',
      scope_id: scope[3] ?? '',
      scope_kind: scope[2] ?? '',
      source_partition: scope[6] ?? '',
    }
  })
}

const createReviewImportDelta = (input: Record<string, unknown>) => {
  return {
    articleId: 'article-1',
    changeKind: 'importRoute.article.added',
    conflictFlag: false,
    deltaId: 'delta-1',
    duplicateFlag: false,
    filterBucketKey: 'sourceKind',
    filterBucketValue: 'database',
    hotArticleId: 'article-1',
    hotImportRouteId: 'route-1',
    hotSourceRecordKey: 'source-1',
    importRouteId: 'route-1',
    payloadVersion: 1,
    projectId: 'project-1',
    publicationYear: 2024,
    selectedRankKey: '0000:article-1:source-1',
    selectedRankNumeric: 0,
    sourceHighWaterMark: 1,
    sourcePartition: 'importRoute:route-1',
    sourceRecordKey: 'source-1',
    tombstone: false,
    ...input,
  }
}

const createFakeIntakeDatabase = (rows: readonly Record<string, unknown>[]) => {
  const statements: string[] = []
  const stagedDirtyWorkRows: StagedDirtyWorkRow[] = []
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.import_run_article_delta')) {
      const deltaIds = [
        ...new Set(
          rows.map((row) => {
            return String(row.deltaId)
          }),
        ),
      ].slice(0, getLimit(statement))

      return rows.filter((row) => {
        return deltaIds.includes(String(row.deltaId))
      }) as T[]
    }

    return [] as T[]
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO temp_review_serving_dirty_work_batch_')) {
      stagedDirtyWorkRows.push(...getStagedDirtyWorkRows(statement))
    }
  }
  const database: ReviewImportDeltaDirtyIntakeDatabase = {
    queryJson,
    run,
    transaction: async (operation) => {
      return operation({queryJson, run})
    },
  }

  return {database, stagedDirtyWorkRows, statements}
}

const getStagedProjectionComponents = (rows: readonly StagedDirtyWorkRow[]) => {
  return rows.map((row) => {
    return row.projection_component
  })
}

test('import delta intake bounds source rows before route fanout', async () => {
  const {database, stagedDirtyWorkRows, statements} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-a', projectId: 'project-a', sourceHighWaterMark: 4}),
    createReviewImportDelta({deltaId: 'delta-a', projectId: 'project-b', sourceHighWaterMark: 4}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {limit: 1, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const deltaSelect = statements.find((statement) => {
    return statement.includes('WITH bounded_deltas AS')
  })

  expect(result).toMatchObject({dirtyWorkCount: 18, maxSourceHighWaterMark: 4, status: 'converted'})
  expect(deltaSelect).toContain('LIMIT 1')
  expect(deltaSelect).toContain('source_high_water_mark >= 1')
  expect(deltaSelect).toContain('AND reconciled_at IS NULL')
  expect(deltaSelect).toContain('ORDER BY source_high_water_mark ASC, delta_id ASC')
  expect(deltaSelect).not.toContain('source_high_water_mark <=')
  expect(deltaSelect).toContain('delta.source_high_water_mark AS sourceHighWaterMark')
  expect(deltaSelect).not.toContain('CAST(delta.source_high_water_mark AS INTEGER)')
  expect(deltaSelect).toContain('LEFT JOIN app.project_import_route')
  expect(stagedDirtyWorkRows).toHaveLength(18)
})

test('import delta intake accepts DuckDB bigint string high-water marks', async () => {
  const {database} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-string-watermark', sourceHighWaterMark: '4'}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  expect(result).toMatchObject({dirtyWorkCount: 9, maxSourceHighWaterMark: 4, status: 'converted'})
})

test('repeated import changes collapse into one dirty row per project component identity', async () => {
  const repeated = createReviewImportDelta({
    deltaId: 'delta-rank',
    changeKind: 'importRoute.article.rankFields.updated',
  })
  const {database, stagedDirtyWorkRows} = createFakeIntakeDatabase([repeated])

  await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  const dirtyWorkIds = new Set(
    stagedDirtyWorkRows.map((row) => {
      return row.dirty_work_id
    }),
  )

  expect(stagedDirtyWorkRows).toHaveLength(8)
  expect(dirtyWorkIds.size).toBe(4)
  expect(stagedDirtyWorkRows[0]?.projection_component).toBe('selectedImport')
  expect(stagedDirtyWorkRows[0]?.projection_key).toBe(stagedDirtyWorkRows[4]?.projection_key)
})

test('import projection identity is stable across per-mutation article values', async () => {
  const {database, stagedDirtyWorkRows} = createFakeIntakeDatabase([
    createReviewImportDelta({
      articleId: 'article-1',
      deltaId: 'delta-rank-1',
      hotArticleId: 'article-1',
      selectedRankKey: '0000:article-1:source-1',
      sourceHighWaterMark: 5,
    }),
    createReviewImportDelta({
      articleId: 'article-2',
      deltaId: 'delta-rank-2',
      hotArticleId: 'article-2',
      selectedRankKey: '0000:article-2:source-2',
      sourceHighWaterMark: 6,
      sourceRecordKey: 'source-2',
    }),
  ])

  await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  const projectionKeys = stagedDirtyWorkRows.map((row) => {
    return row.projection_key
  })

  expect(projectionKeys).toHaveLength(18)
  expect(new Set(projectionKeys).size).toBe(9)
})

test('selected import rank-field changes dirty search but not display payload or judgment input components', async () => {
  const {database, stagedDirtyWorkRows} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-selected', changeKind: 'importRoute.article.rankFields.updated'}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const projectionComponents = getStagedProjectionComponents(stagedDirtyWorkRows)

  expect(result).toMatchObject({dirtyWorkCount: 4, maxSourceHighWaterMark: 1, status: 'converted'})
  expect(projectionComponents).toEqual(['selectedImport', 'posting', 'search', 'summary'])
  expect(
    stagedDirtyWorkRows.every((row) => {
      return row.dirty_kind === 'importRoute.article.rankFields.updated'
    }),
  ).toBe(true)
  expect(projectionComponents).not.toContain('display')
  expect(projectionComponents).not.toContain('payload')
  expect(projectionComponents).not.toContain('judgmentInputContent')
})

test('tombstone import deltas create removed work with registry declared components', async () => {
  const {database, stagedDirtyWorkRows} = createFakeIntakeDatabase([
    createReviewImportDelta({changeKind: 'importRoute.article.removed', deltaId: 'delta-removed', tombstone: true}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const tombstoneRule = getReviewServingInvalidationRule('importRoute.article.removed')

  expect(result).toMatchObject({dirtyWorkCount: 9, maxSourceHighWaterMark: 1, status: 'converted'})
  expect(stagedDirtyWorkRows[0]?.projection_component).toBe('projectScope')
  expect(stagedDirtyWorkRows[0]?.dirty_kind).toBe('importRoute.article.removed')
  expect(getStagedProjectionComponents(stagedDirtyWorkRows)).toEqual([...tombstoneRule.affectedComponents])
  expect(tombstoneRule.affectedComponents).toEqual([
    'projectScope',
    'selectedImport',
    'llmStatus',
    'humanStatus',
    'queue',
    'posting',
    'search',
    'summary',
    'payload',
  ])
})

test('import delta intake rejects missing hot-field typed keys before dirty writes', async () => {
  const {database, stagedDirtyWorkRows, statements} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-bad', hotSourceRecordKey: null, sourceRecordKey: null}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  expect(result).toEqual({
    deltaId: 'delta-bad',
    reason: 'missing required keys: importSourceRecordKey',
    status: 'failed',
  })
  expect(stagedDirtyWorkRows).toEqual([])
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work (')
    }),
  ).toBe(false)
  expect(
    statements.some((statement) => {
      return statement.includes('reconciled_at = current_timestamp')
    }),
  ).toBe(false)
})

test('import delta intake commits one dirty-work batch per group for four-project deltas', async () => {
  const rows = Array.from({length: 120}, (_value, deltaIndex) => {
    return ['project-a', 'project-b', 'project-c', 'project-d'].map((projectId) => {
      return createReviewImportDelta({
        articleId: `article-${deltaIndex}`,
        deltaId: `delta-${String(deltaIndex).padStart(3, '0')}`,
        hotArticleId: `article-${deltaIndex}`,
        projectId,
        sourceHighWaterMark: deltaIndex + 1,
      })
    })
  }).flat()
  const {database, stagedDirtyWorkRows, statements} = createFakeIntakeDatabase(rows)

  const result = await intakeReviewImportDeltasToDirtyWork(
    {limit: 1_024, sourcePartition: 'import-route:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const stageStatements = statements.filter((statement) => {
    return statement.includes('INSERT INTO temp_review_serving_dirty_work_batch_')
  })
  const reconcileStatements = statements.filter((statement) => {
    return statement.includes('reconciled_at = current_timestamp')
  })

  expect(result).toMatchObject({dirtyWorkCount: 120 * 36, maxSourceHighWaterMark: 120, status: 'converted'})
  expect(stagedDirtyWorkRows).toHaveLength(120 * 36)
  expect(
    stageStatements.map((statement) => {
      return getStagedDirtyWorkRows(statement).length
    }),
  ).toEqual([113 * 36, 7 * 36])
  expect(reconcileStatements).toHaveLength(2)
})
