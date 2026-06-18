import {expect, test} from 'bun:test'

import {
  intakeReviewImportDeltasToDirtyWork,
  type ReviewImportDeltaDirtyIntakeDatabase,
} from './reviewImportDeltaDirtyIntakeService.ts'
import {getReviewServingInvalidationRule} from './reviewServingInvalidationRegistry.ts'

type ProjectionKey = {projectionComponent?: string; projectionIdentity?: string}

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getLimit = (statement: string) => {
  return Number(statement.match(/LIMIT\s+(\d+)/u)?.[1] ?? 0)
}

const getDirtyWorkId = (statement: string) => {
  return getSqlStrings(statement)[0] ?? ''
}

const getProjectionKey = (statement: string) => {
  return getSqlStrings(statement).find((value) => {
    return value.startsWith('{"projectionComponent":')
  })
}

const parseProjectionKey = (statement: string): ProjectionKey => {
  const projectionKey = getProjectionKey(statement)

  if (projectionKey === undefined) {
    return {}
  }

  const parsed = JSON.parse(projectionKey) as unknown

  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ProjectionKey) : {}
}

const getDirtyKind = (statement: string) => {
  return getSqlStrings(statement).find((value) => {
    return value.includes('.')
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
  const dirtyWorkIds = new Set<string>()
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_serving_dirty_work_ack')) {
      return [] as T[]
    }

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

    if (statement.includes('INSERT INTO app.review_serving_dirty_work')) {
      dirtyWorkIds.add(getDirtyWorkId(statement))
    }
  }
  const database: ReviewImportDeltaDirtyIntakeDatabase = {
    queryJson,
    run,
    transaction: async (operation) => {
      return operation({queryJson, run})
    },
  }

  return {database, dirtyWorkIds, statements}
}

test('import delta intake bounds source rows before route fanout', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-a', projectId: 'project-a', sourceHighWaterMark: 4}),
    createReviewImportDelta({deltaId: 'delta-a', projectId: 'project-b', sourceHighWaterMark: 4}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: 4, limit: 1, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const deltaSelect = statements.find((statement) => {
    return statement.includes('WITH bounded_deltas AS')
  })
  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
  })

  expect(result).toMatchObject({dirtyWorkCount: 18, maxSourceHighWaterMark: 4, status: 'converted'})
  expect(deltaSelect).toContain('LIMIT 1')
  expect(deltaSelect).toContain('delta.source_high_water_mark AS sourceHighWaterMark')
  expect(deltaSelect).not.toContain('CAST(delta.source_high_water_mark AS INTEGER)')
  expect(deltaSelect).toContain('LEFT JOIN app.project_import_route')
  expect(dirtyInserts).toHaveLength(18)
})

test('repeated import changes collapse into one dirty row per project component identity', async () => {
  const repeated = createReviewImportDelta({
    deltaId: 'delta-rank',
    changeKind: 'importRoute.article.rankFields.updated',
  })
  const {database, dirtyWorkIds, statements} = createFakeIntakeDatabase([repeated])

  await intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: 5, limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  await intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: 5, limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
  })

  expect(dirtyInserts).toHaveLength(6)
  expect(dirtyWorkIds.size).toBe(3)
  expect(parseProjectionKey(dirtyInserts[0] ?? '').projectionComponent).toBe('selectedImport')
  expect(getProjectionKey(dirtyInserts[0] ?? '')).toBe(getProjectionKey(dirtyInserts[3] ?? ''))
})

test('import projection identity is stable across per-mutation article values', async () => {
  const {database, statements} = createFakeIntakeDatabase([
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
    {endSourceHighWaterMark: 6, limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  const projectionKeys = statements
    .filter((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work')
    })
    .map(getProjectionKey)
  const uniqueProjectionKeys = new Set(projectionKeys)

  expect(projectionKeys).toHaveLength(18)
  expect(uniqueProjectionKeys.size).toBe(9)
})

test('selected import rank-field changes do not dirty display or judgment input components', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-selected', changeKind: 'importRoute.article.rankFields.updated'}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: 6, limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const dirtyInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
  })
  const projectionKey = dirtyInsert === undefined ? {} : parseProjectionKey(dirtyInsert)

  expect(result).toMatchObject({dirtyWorkCount: 3, maxSourceHighWaterMark: 1, status: 'converted'})
  expect(projectionKey).toMatchObject({projectionComponent: 'selectedImport'})
  expect(dirtyInsert).toContain('importRoute.article.rankFields.updated')
  expect(dirtyInsert).not.toContain('display')
  expect(dirtyInsert).not.toContain('judgmentInputContent')
})

test('tombstone import deltas create removed work with registry declared components', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewImportDelta({changeKind: 'importRoute.article.removed', deltaId: 'delta-removed', tombstone: true}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: 7, limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )
  const dirtyInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
  })
  const tombstoneRule = getReviewServingInvalidationRule('importRoute.article.removed')

  expect(result).toMatchObject({dirtyWorkCount: 9, maxSourceHighWaterMark: 1, status: 'converted'})
  expect(parseProjectionKey(dirtyInsert ?? '').projectionComponent).toBe('projectScope')
  expect(getDirtyKind(dirtyInsert ?? '')).toBe('importRoute.article.removed')
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
  const {database, statements} = createFakeIntakeDatabase([
    createReviewImportDelta({deltaId: 'delta-bad', hotSourceRecordKey: null, sourceRecordKey: null}),
  ])

  const result = await intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: 8, limit: 10, sourcePartition: 'importRoute:route-1', startSourceHighWaterMark: 1},
    database,
  )

  expect(result).toEqual({
    deltaId: 'delta-bad',
    reason: 'missing required keys: importSourceRecordKey',
    status: 'failed',
  })
  expect(
    statements.some((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work')
    }),
  ).toBe(false)
  expect(
    statements.some((statement) => {
      return statement.includes('reconciled_at = current_timestamp')
    }),
  ).toBe(false)
})
