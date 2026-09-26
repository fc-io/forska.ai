import {expect, test} from 'bun:test'

import {
  intakeReviewChangeDeltasToDirtyWork,
  type ReviewChangeDeltaDirtyIntakeDatabase,
} from './reviewChangeDeltaDirtyIntakeService.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {reviewServingDeltaIntakeMaxDirtyWorkPerTransaction} from './reviewServingDeltaIntakeGroups.ts'

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

const createReviewChangeDelta = (input: Record<string, unknown>) => {
  return {
    articleId: null,
    changeKind: 'judgment.llm.updated',
    configFieldSet: null,
    deltaId: 'delta-1',
    humanJudgmentKey: null,
    judgmentId: null,
    modelId: null,
    payloadJson: {},
    payloadVersion: 1,
    projectId: null,
    promptId: null,
    sourceHighWaterMark: 1,
    sourcePartition: 'reviewChange:project-1',
    useAbstract: null,
    useFulltext: null,
    useFulltextNoImages: null,
    useTitle: null,
    ...input,
  }
}

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

const stagedDirtyWorkInsertColumns: (keyof StagedDirtyWorkRow)[] = [
  'dirty_work_id',
  'project_id',
  'scope_kind',
  'scope_id',
  'article_id',
  'projection_key',
  'projection_component',
  'projection_identity',
  'dirty_kind',
  'source_partition',
  'first_source_high_water_mark',
  'latest_source_high_water_mark',
  'latest_delta_id',
  'dirty_range_start',
  'dirty_range_end',
]

const getStagedSqlValue = (value: number | string | null | undefined) => {
  return value === null || value === undefined
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`
}

// Batched dirty-work upserts stage their rows as JSON literals; record one insert statement per staged row so
// the assertions below keep inspecting individual dirty-work rows.
const getDirtyWorkInsertStatements = (statement: string): string[] => {
  return getStagedDirtyWorkRows(statement).map((row) => {
    return `INSERT INTO app.review_serving_dirty_work (${stagedDirtyWorkInsertColumns.join(', ')}) VALUES (${stagedDirtyWorkInsertColumns
      .map((column) => {
        return getStagedSqlValue(row[column])
      })
      .join(', ')})`
  })
}

const createFakeIntakeDatabase = (
  rows: readonly Record<string, unknown>[],
  input?: {articleProjectRows?: readonly Record<string, unknown>[]},
) => {
  const statements: string[] = []
  const dirtyWorkIds = new Set<string>()
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_serving_dirty_work_ack')) {
      return [] as T[]
    }

    if (statement.includes('FROM app.review_change_delta')) {
      return rows.slice(0, getLimit(statement)) as T[]
    }

    if (statement.includes('FROM mart.project_scope_article')) {
      return (input?.articleProjectRows ?? []) as T[]
    }

    return [] as T[]
  }
  const run = async (statement: string) => {
    if (statement.includes('INSERT INTO temp_review_serving_dirty_work_batch_')) {
      getDirtyWorkInsertStatements(statement).forEach((rowStatement) => {
        statements.push(rowStatement)
        dirtyWorkIds.add(getDirtyWorkId(rowStatement))
      })
      return
    }

    if (!statement.includes('INSERT INTO app.review_serving_dirty_work (')) {
      statements.push(statement)
    }
  }
  const database: ReviewChangeDeltaDirtyIntakeDatabase = {
    queryJson,
    run,
    transaction: async (operation) => {
      return operation({queryJson, run})
    },
  }

  return {database, dirtyWorkIds, statements}
}

test('delta intake starts projector work at first affected component only', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewChangeDelta({
      articleId: 'article-1',
      judgmentId: 'judgment-1',
      modelId: 'model-1',
      payloadJson: {
        articleId: 'article-1',
        contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        judgmentId: 'judgment-1',
        modelId: 'model-1',
        projectId: 'project-1',
        promptId: 'prompt-1',
      },
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceHighWaterMark: 7,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }),
  ])

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 7, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )
  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work (')
  })
  const projectionComponents = dirtyInserts.map((statement) => {
    return parseProjectionKey(statement).projectionComponent
  })

  expect(result).toMatchObject({dirtyWorkCount: 5, maxSourceHighWaterMark: 7, status: 'converted'})
  expect(projectionComponents).toEqual(['llmStatus', 'queue', 'payload', 'posting', 'summary'])
  expect(dirtyInserts[0]).toContain('judgment.llm.updated')
  expect(dirtyInserts[0]).not.toContain('selectedImport')
  expect(dirtyInserts[0]).not.toContain('display')
})

test('delta intake accepts DuckDB bigint string high-water marks', async () => {
  const {database} = createFakeIntakeDatabase([
    createReviewChangeDelta({
      articleId: 'article-1',
      judgmentId: 'judgment-1',
      modelId: 'model-1',
      payloadJson: {
        articleId: 'article-1',
        contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        judgmentId: 'judgment-1',
        modelId: 'model-1',
        projectId: 'project-1',
        promptId: 'prompt-1',
      },
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceHighWaterMark: '7',
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }),
  ])

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 7, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )

  expect(result).toMatchObject({dirtyWorkCount: 5, maxSourceHighWaterMark: 7, status: 'converted'})
})

test('delta intake rejects malformed rows before dirty work writes', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewChangeDelta({
      changeKind: 'judgment.human.updated',
      deltaId: 'delta-bad',
      payloadJson: {articleId: 'article-1', projectId: 'project-1'},
      projectId: 'project-1',
      sourceHighWaterMark: 8,
    }),
  ])

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 8, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )

  expect(result).toEqual({deltaId: 'delta-bad', reason: 'missing required keys: humanJudgmentKey', status: 'failed'})
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

test('delta intake fans route and project changes to project-scope dirty work', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewChangeDelta({
      articleId: 'article-1',
      changeKind: 'projectScope.article.added',
      deltaId: 'delta-project-scope',
      payloadJson: {articleId: 'article-1', projectArticleId: 'project-article-1', projectId: 'project-1'},
      projectId: 'project-1',
      sourceHighWaterMark: 9,
    }),
    createReviewChangeDelta({
      changeKind: 'project.reviewConfig.updated',
      configFieldSet: 'importRoutes,useTitle',
      deltaId: 'delta-project-config',
      payloadJson: {changedReviewConfigFields: ['importRoutes', 'useTitle'], projectId: 'project-1'},
      projectId: 'project-1',
      sourceHighWaterMark: 10,
    }),
  ])

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 10, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )
  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work (')
  })
  const projectionComponents = dirtyInserts.map((statement) => {
    return parseProjectionKey(statement).projectionComponent
  })

  expect(result).toMatchObject({dirtyWorkCount: 19, maxSourceHighWaterMark: 10, status: 'converted'})
  expect(projectionComponents).toEqual([
    'projectScope',
    'selectedImport',
    'llmStatus',
    'humanStatus',
    'queue',
    'posting',
    'search',
    'summary',
    'payload',
    'projectScope',
    'selectedImport',
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
    'queue',
    'posting',
    'search',
    'summary',
    'payload',
  ])
  expect(dirtyInserts.map(getDirtyKind)).toEqual([
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'projectScope.article.added',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
    'project.reviewConfig.updated',
  ])
})

test('delta intake expands article-only changes to affected projects', async () => {
  const {database, statements} = createFakeIntakeDatabase(
    [
      createReviewChangeDelta({
        articleId: 'article-1',
        changeKind: 'article.display.updated',
        deltaId: 'delta-article-display',
        payloadJson: {articleId: 'article-1', changedDisplayFieldNames: ['articleTitle']},
        sourceHighWaterMark: 11,
      }),
    ],
    {articleProjectRows: [{projectId: 'project-1'}, {projectId: 'project-2'}]},
  )

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 11, limit: 10, sourcePartition: 'reviewChange:article-1', startSourceHighWaterMark: 1},
    database,
  )
  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work (')
  })

  expect(result).toMatchObject({dirtyWorkCount: 6, maxSourceHighWaterMark: 11, status: 'converted'})
  expect(dirtyInserts).toHaveLength(6)
  expect(dirtyInserts.join('\n')).toContain('project-1:article-1')
  expect(dirtyInserts.join('\n')).toContain('project-2:article-1')
  expect(dirtyInserts.join('\n')).not.toContain('global')
})

test('delta intake replay from the same range is idempotent', async () => {
  const row = createReviewChangeDelta({
    articleId: 'article-1',
    changeKind: 'judgment.human.updated',
    deltaId: 'delta-human',
    humanJudgmentKey: 'human:project-1:article-1',
    payloadJson: {articleId: 'article-1', humanJudgmentKey: 'human:project-1:article-1', projectId: 'project-1'},
    projectId: 'project-1',
    sourceHighWaterMark: 11,
  })
  const {database, dirtyWorkIds, statements} = createFakeIntakeDatabase([row])

  await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 11, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )
  await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 11, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )

  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work (')
  })

  expect(dirtyInserts).toHaveLength(10)
  expect(dirtyWorkIds.size).toBe(5)
  expect(getProjectionKey(dirtyInserts[0] ?? '')).toBe(getProjectionKey(dirtyInserts[5] ?? ''))
  expect(getProjectionKey(dirtyInserts[0] ?? '')).toBe(
    getStableReviewServingJson({
      projectionComponent: 'humanStatus',
      projectionIdentity: parseProjectionKey(dirtyInserts[0] ?? '').projectionIdentity,
    }),
  )
})

test('delta projection identity is stable across per-mutation values', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewChangeDelta({
      articleId: 'article-1',
      judgmentId: 'judgment-1',
      modelId: 'model-1',
      payloadJson: {
        articleId: 'article-1',
        contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        judgmentId: 'judgment-1',
        modelId: 'model-1',
        projectId: 'project-1',
        promptId: 'prompt-1',
      },
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceHighWaterMark: 12,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }),
    createReviewChangeDelta({
      articleId: 'article-2',
      deltaId: 'delta-2',
      judgmentId: 'judgment-2',
      modelId: 'model-1',
      payloadJson: {
        articleId: 'article-2',
        contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        judgmentId: 'judgment-2',
        modelId: 'model-1',
        projectId: 'project-1',
        promptId: 'prompt-1',
      },
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceHighWaterMark: 13,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    }),
  ])

  await intakeReviewChangeDeltasToDirtyWork(
    {endSourceHighWaterMark: 13, limit: 10, sourcePartition: 'reviewChange:project-1', startSourceHighWaterMark: 1},
    database,
  )

  const projectionKeys = statements
    .filter((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work (')
    })
    .map(getProjectionKey)

  expect(projectionKeys).toHaveLength(10)
  expect(projectionKeys.slice(0, 5)).toEqual(projectionKeys.slice(5))
})

test('delta intake converts search tokenizer upgrades into project-scoped search-only dirty work', async () => {
  const {database, statements} = createFakeIntakeDatabase([
    createReviewChangeDelta({
      changeKind: 'project.searchTokenizer.updated',
      deltaId: 'delta-tokenizer',
      payloadJson: {projectId: 'project-1', tokenizerVersion: 'title-token-v2'},
      projectId: 'project-1',
      sourceHighWaterMark: 12,
      sourcePartition: 'projectReviewConfig:project-1',
    }),
  ])

  const result = await intakeReviewChangeDeltasToDirtyWork(
    {
      endSourceHighWaterMark: 12,
      limit: 10,
      sourcePartition: 'projectReviewConfig:project-1',
      startSourceHighWaterMark: 1,
    },
    database,
  )
  const dirtyInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work (')
  })

  expect(result).toMatchObject({dirtyWorkCount: 1, maxSourceHighWaterMark: 12, status: 'converted'})
  expect(
    dirtyInserts.map(parseProjectionKey).map((key) => {
      return key.projectionComponent
    }),
  ).toEqual(['search'])
  expect(dirtyInserts.map(getDirtyKind)).toEqual(['project.searchTokenizer.updated'])
  expect(dirtyInserts[0]).toContain("'project'")
  expect(dirtyInserts[0]).not.toContain('llmStatus')
  expect(dirtyInserts[0]).not.toContain('display')
})

test('delta intake commits bounded groups and stops at a spent deadline after the first one', async () => {
  const deltasPerGroup = Math.floor(reviewServingDeltaIntakeMaxDirtyWorkPerTransaction / 5)
  const deltaCount = deltasPerGroup + 20
  const deltas = Array.from({length: deltaCount}, (_value, index) => {
    const articleId = `article-${index}`

    return createReviewChangeDelta({
      articleId,
      deltaId: `delta-${String(index).padStart(4, '0')}`,
      judgmentId: `judgment-${index}`,
      modelId: 'model-1',
      payloadJson: {
        articleId,
        contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
        judgmentId: `judgment-${index}`,
        modelId: 'model-1',
        projectId: 'project-1',
        promptId: 'prompt-1',
      },
      projectId: 'project-1',
      promptId: 'prompt-1',
      sourceHighWaterMark: index + 1,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    })
  })
  const params = {
    endSourceHighWaterMark: deltaCount,
    limit: deltaCount,
    sourcePartition: 'reviewChange:project-1',
    startSourceHighWaterMark: 1,
  }
  const bounded = createFakeIntakeDatabase(deltas)
  const unbounded = createFakeIntakeDatabase(deltas)

  const stopped = await intakeReviewChangeDeltasToDirtyWork({...params, deadlineAtMs: 0}, bounded.database)
  const completed = await intakeReviewChangeDeltasToDirtyWork(params, unbounded.database)
  const getReconciledStatements = (statements: readonly string[]) => {
    return statements.filter((statement) => {
      return statement.includes('SET reconciled_at = current_timestamp')
    })
  }

  expect(stopped).toEqual({
    dirtyWorkCount: deltasPerGroup * 5,
    maxSourceHighWaterMark: deltasPerGroup,
    status: 'converted',
  })
  expect(getReconciledStatements(bounded.statements)).toHaveLength(1)
  expect(getReconciledStatements(bounded.statements)[0]).toContain(
    `'delta-${String(deltasPerGroup - 1).padStart(4, '0')}'`,
  )
  expect(getReconciledStatements(bounded.statements)[0]).not.toContain(
    `'delta-${String(deltasPerGroup).padStart(4, '0')}'`,
  )
  expect(completed).toEqual({dirtyWorkCount: deltaCount * 5, maxSourceHighWaterMark: deltaCount, status: 'converted'})
  expect(getReconciledStatements(unbounded.statements)).toHaveLength(2)
})
