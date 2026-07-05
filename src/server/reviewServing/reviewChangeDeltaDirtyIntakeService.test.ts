import {expect, test} from 'bun:test'

import {
  intakeReviewChangeDeltasToDirtyWork,
  type ReviewChangeDeltaDirtyIntakeDatabase,
} from './reviewChangeDeltaDirtyIntakeService.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'

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
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_serving_dirty_work')) {
      dirtyWorkIds.add(getDirtyWorkId(statement))
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
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
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
      return statement.includes('INSERT INTO app.review_serving_dirty_work')
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
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
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
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
  })

  expect(result).toMatchObject({dirtyWorkCount: 8, maxSourceHighWaterMark: 11, status: 'converted'})
  expect(dirtyInserts).toHaveLength(8)
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
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
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
      return statement.includes('INSERT INTO app.review_serving_dirty_work')
    })
    .map(getProjectionKey)

  expect(projectionKeys).toHaveLength(10)
  expect(projectionKeys.slice(0, 5)).toEqual(projectionKeys.slice(5))
})
