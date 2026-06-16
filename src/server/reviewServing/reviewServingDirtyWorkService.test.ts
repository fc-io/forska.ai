import {expect, test} from 'bun:test'

import {
  claimReviewServingDirtyWork,
  completeReviewServingDirtyWorkClaims,
  failReviewServingDirtyWorkClaims,
  getReviewServingDirtyWork,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkDatabase,
  type ReviewServingDirtyWorkRecord,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingDirtyWorkScopeForChange,
  type ReviewServingDirtyWorkScope,
} from './reviewServingProjectorDomain.ts'

type FakeDirtyWorkRow = Omit<ReviewServingDirtyWorkRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string
  projectionKey: string
  updatedAt: string
}

type FakeAckRow = {completedSourceHighWaterMark: number; dirtyAckId: string; dirtyWorkId: string; status: string}

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getWhereLiteral = (statement: string, columnName: string) => {
  return (
    statement
      .match(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*'((?:''|[^'])*)'`, 'u'))?.[1]
      ?.replaceAll("''", "'") ?? null
  )
}

const getInLiterals = (statement: string, columnName: string) => {
  const inList = statement.match(new RegExp(`${columnName}\\s+IN\\s+\\(([^)]*)\\)`, 'u'))?.[1] ?? ''

  return getSqlStrings(inList)
}

const getLimit = (statement: string) => {
  return Number(statement.match(/LIMIT\s+(\d+)/u)?.[1] ?? 0)
}

const getNumbers = (statement: string) => {
  const unquotedStatement = statement.replace(/'((?:''|[^'])*)'/g, "''")

  return [...unquotedStatement.matchAll(/(?<![A-Za-z0-9_])-?\d+(?![A-Za-z0-9_])/g)].map((match) => {
    return Number(match[0])
  })
}

const getClock = (statements: string[]) => {
  return new Date(Date.UTC(2026, 5, 16, 12, statements.length)).toISOString()
}

const getBaseScope = (sourceHighWaterMark: number, dirtyRangeStart = '1', dirtyRangeEnd = '1') => {
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: 'article.display.updated',
    dirtyRangeEnd,
    dirtyRangeStart,
    sourceHighWaterMark,
    sourcePartition: 'article:display',
    values: {articleId: 'article-1', changedDisplayFieldNames: ['title'], projectId: 'project-1', sourceHighWaterMark},
  })

  if (scope === null) {
    throw new Error('expected valid dirty work scope')
  }

  return scope
}

const createFakeDirtyWorkDatabase = () => {
  const dirtyWork = new Map<string, FakeDirtyWorkRow>()
  const acks = new Map<string, FakeAckRow>()
  const statements: string[] = []
  const getQueryRow = (row: FakeDirtyWorkRow) => {
    return {
      articleId: row.articleId,
      createdAt: row.createdAt,
      dirtyKind: row.dirtyKind,
      dirtyRangeEnd: row.dirtyRangeEnd,
      dirtyRangeStart: row.dirtyRangeStart,
      dirtyWorkId: row.dirtyWorkId,
      firstSourceHighWaterMark: row.firstSourceHighWaterMark,
      latestDeltaId: row.latestDeltaId,
      latestSourceHighWaterMark: row.latestSourceHighWaterMark,
      projectId: row.projectId,
      projectionKey: row.projectionKey,
      scopeId: row.scopeId,
      scopeKind: row.scopeKind,
      sourcePartition: row.sourcePartition,
      status: row.status,
      updatedAt: row.updatedAt,
    }
  }
  const upsertDirtyWork = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const dirtyWorkId = strings[0] ?? ''
    const existing = dirtyWork.get(dirtyWorkId)
    const now = getClock(statements)
    const row = {
      articleId: strings[4] ?? null,
      createdAt: existing?.createdAt ?? now,
      dirtyKind: strings[6] ?? 'article.display.updated',
      dirtyRangeEnd: strings[10] ?? null,
      dirtyRangeStart: strings[9] ?? null,
      dirtyWorkId,
      firstSourceHighWaterMark: existing?.firstSourceHighWaterMark ?? numbers[0] ?? 0,
      latestDeltaId: strings[8] ?? null,
      latestSourceHighWaterMark: Math.max(existing?.latestSourceHighWaterMark ?? 0, numbers[1] ?? 0),
      projectId: strings[1] ?? null,
      projectionComponent: 'display' as const,
      projectionIdentity: 'display:identity-1',
      projectionKey: strings[5] ?? '',
      scopeId: strings[3] ?? '',
      scopeKind: strings[2] ?? 'article',
      sourcePartition: strings[7] ?? '',
      status: 'pending' as const,
      updatedAt: now,
    }
    const dirtyRangeStart = [existing?.dirtyRangeStart ?? null, row.dirtyRangeStart]
      .filter((value): value is string => {
        return value !== null
      })
      .sort()[0]
    const dirtyRangeEnd = [existing?.dirtyRangeEnd ?? null, row.dirtyRangeEnd]
      .filter((value): value is string => {
        return value !== null
      })
      .sort()
      .at(-1)

    dirtyWork.set(dirtyWorkId, {
      ...existing,
      ...row,
      dirtyRangeEnd: dirtyRangeEnd ?? null,
      dirtyRangeStart: dirtyRangeStart ?? null,
    })
  }
  const updateStatus = (
    statement: string,
    status: FakeDirtyWorkRow['status'],
    expectedStatus: FakeDirtyWorkRow['status'],
  ) => {
    getInLiterals(statement, 'dirty_work_id').forEach((dirtyWorkId) => {
      const existing = dirtyWork.get(dirtyWorkId)

      if (existing?.status === expectedStatus) {
        dirtyWork.set(dirtyWorkId, {...existing, status, updatedAt: getClock(statements)})
      }
    })
  }
  const insertAck = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const dirtyAckId = strings[0] ?? ''

    acks.set(dirtyAckId, {
      completedSourceHighWaterMark: numbers[0] ?? 0,
      dirtyAckId,
      dirtyWorkId: strings[1] ?? '',
      status: 'completed',
    })
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('WHERE dirty_work_id =')) {
      const row = dirtyWork.get(getWhereLiteral(statement, 'dirty_work_id') ?? '')
      return (row === undefined ? [] : [getQueryRow(row)]) as T[]
    }

    if (statement.includes("status = 'pending'") && statement.includes('starts_with(projection_key')) {
      const prefix = getSqlStrings(statement).at(-1) ?? ''
      return [...dirtyWork.values()]
        .filter((row) => {
          return row.status === 'pending' && row.projectionKey.startsWith(prefix)
        })
        .sort((left, right) => {
          return left.updatedAt.localeCompare(right.updatedAt) || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
        })
        .slice(0, getLimit(statement))
        .map(getQueryRow) as T[]
    }

    return []
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_serving_dirty_work (')) {
      upsertDirtyWork(statement)
    }

    if (statement.includes("SET status = 'running'")) {
      updateStatus(statement, 'running', 'pending')
    }

    if (statement.includes("SET status = 'pending'")) {
      updateStatus(statement, 'pending', 'running')
    }

    if (statement.includes("SET status = 'failed'")) {
      updateStatus(statement, 'failed', 'running')
    }

    if (statement.includes('INSERT INTO app.review_serving_dirty_work_ack')) {
      insertAck(statement)
    }

    if (statement.includes("SET status = 'completed'")) {
      updateStatus(statement, 'completed', 'running')
    }
  }
  const database: ReviewServingDirtyWorkDatabase = {
    queryJson,
    run,
    transaction: async (operation) => {
      return operation({queryJson, run})
    },
  }

  return {acks, database, dirtyWork, statements}
}

const upsertDisplayWork = (
  database: ReviewServingDirtyWorkDatabase,
  scope: ReviewServingDirtyWorkScope,
  latestDeltaId = 'delta-1',
) => {
  return upsertReviewServingDirtyWork(
    {latestDeltaId, projectionComponent: 'display', projectionIdentity: 'display:identity-1', scope},
    database,
  )
}

test('dirty-work creation coalesces by project component identity and scope', async () => {
  const {database, dirtyWork} = createFakeDirtyWorkDatabase()
  const first = await upsertDisplayWork(database, getBaseScope(5))
  const second = await upsertDisplayWork(database, getBaseScope(5), 'delta-1-replay')
  const row = await getReviewServingDirtyWork(first.dirtyWorkId, database)

  expect(second.dirtyWorkId).toBe(first.dirtyWorkId)
  expect(dirtyWork.size).toBe(1)
  expect(row).toMatchObject({
    dirtyRangeEnd: '1',
    dirtyRangeStart: '1',
    latestDeltaId: 'delta-1-replay',
    latestSourceHighWaterMark: 5,
    status: 'pending',
  })
})

test('repeated changes collapse to one pending row with latest high-water and dirty range', async () => {
  const {database} = createFakeDirtyWorkDatabase()
  const first = await upsertDisplayWork(database, getBaseScope(5, '2', '2'), 'delta-1')

  await upsertDisplayWork(database, getBaseScope(8, '1', '9'), 'delta-2')

  const row = await getReviewServingDirtyWork(first.dirtyWorkId, database)

  expect(row).toMatchObject({
    dirtyRangeEnd: '9',
    dirtyRangeStart: '1',
    firstSourceHighWaterMark: 5,
    latestDeltaId: 'delta-2',
    latestSourceHighWaterMark: 8,
    status: 'pending',
  })
})

test('claims pending work by component without exceeding wake budget', async () => {
  const {database} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')
  await upsertReviewServingDirtyWork(
    {
      latestDeltaId: 'delta-3',
      projectionComponent: 'search',
      projectionIdentity: 'search:identity-1',
      scope: {...getBaseScope(3, '3', '3'), scopeId: 'project-1:article-3'},
    },
    database,
  )

  const claims = await claimReviewServingDirtyWork(
    {limit: 5, maxWakeCount: 1, projectionComponent: 'display'},
    database,
  )

  expect(claims).toHaveLength(1)
  expect(claims[0]?.projectionComponent).toBe('display')
  expect(claims[0]?.status).toBe('running')
})

test('release returns running claims to pending for the next wake', async () => {
  const {database} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1), 'delta-1')
  const [claim] = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  await releaseReviewServingDirtyWorkClaims([claim?.dirtyWorkId ?? ''], database)

  const row = await getReviewServingDirtyWork(claim?.dirtyWorkId ?? '', database)

  expect(row?.status).toBe('pending')
})

test('completion and failure move running claims into retention-ready terminal states', async () => {
  const {acks, database} = createFakeDirtyWorkDatabase()
  const first = await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  const second = await upsertDisplayWork(
    database,
    {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'},
    'delta-2',
  )
  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)
  const completedClaim = claims[0]

  if (completedClaim === undefined) {
    throw new Error('expected a completed claim')
  }

  await completeReviewServingDirtyWorkClaims([completedClaim], database)
  await failReviewServingDirtyWorkClaims([claims[1]?.dirtyWorkId ?? ''], database)

  const completed = await getReviewServingDirtyWork(first.dirtyWorkId, database)
  const failed = await getReviewServingDirtyWork(second.dirtyWorkId, database)

  expect(completed?.status).toBe('completed')
  expect(failed?.status).toBe('failed')
  expect(acks.size).toBe(1)
})
