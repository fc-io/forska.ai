import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {
  claimReviewServingDirtyWork,
  cleanupReviewServingDirtyWorkRetention,
  compactReviewServingDirtyWorkAcknowledgements,
  completeReviewServingDirtyWorkClaims,
  completeReviewServingDirtyWorkClaimsAndAdvanceWatermark,
  failReviewServingDirtyWorkClaims,
  getReviewServingDirtyWork,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkClaim,
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

type FakeAckRow = {
  completedSourceHighWaterMark: number
  dirtyAckId: string
  dirtyRangeEnd: string | null
  dirtyRangeStart: string | null
  dirtyWorkId: string | null
  projectionComponent: string
  projectionIdentity: string
  sourcePartition: string
  status: string
}

type FakeDirtySourceWatermarkRow = {projectId: string; sourceHighWaterMark: number; sourcePartition: string}

type FakeOutboxBarrier = {outboxId: string; sourceHighWaterMark: number; status: string} | null

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

const getStartsWithLiteral = (statement: string, columnName: string) => {
  return (
    statement.match(new RegExp(`starts_with\\(${columnName},\\s*'((?:''|[^'])*)'\\)`, 'u'))?.[1]?.replaceAll("''", "'")
    ?? null
  )
}

const getLimit = (statement: string) => {
  return Number([...statement.matchAll(/LIMIT\s+(\d+)/gu)].at(-1)?.[1] ?? 0)
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

const createFakeDirtyWorkDatabase = (options: {barrier?: FakeOutboxBarrier; beforeClaimUpdate?: () => void} = {}) => {
  const dirtyWork = new Map<string, FakeDirtyWorkRow>()
  const acks = new Map<string, FakeAckRow>()
  const dirtySourceWatermarks = new Map<string, FakeDirtySourceWatermarkRow>()
  const watermarks = new Map<string, number>()
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
  const insertMissingDirtyWork = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const dirtyWorkId = strings[0] ?? ''
    const existing = dirtyWork.get(dirtyWorkId)

    if (existing !== undefined) {
      return
    }

    const now = getClock(statements)
    const row = {
      articleId: strings[4] ?? null,
      createdAt: now,
      dirtyKind: strings[6] ?? 'article.display.updated',
      dirtyRangeEnd: strings[10] ?? null,
      dirtyRangeStart: strings[9] ?? null,
      dirtyWorkId,
      firstSourceHighWaterMark: numbers[0] ?? 0,
      latestDeltaId: strings[8] ?? null,
      latestSourceHighWaterMark: numbers[1] ?? 0,
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

    dirtyWork.set(dirtyWorkId, row)
  }
  const updateDirtyWork = (statement: string) => {
    const dirtyWorkId = getWhereLiteral(statement, 'dirty_work_id') ?? ''
    const existing = dirtyWork.get(dirtyWorkId)

    if (existing === undefined) {
      return
    }

    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const dirtyRangeStartCandidate = strings[1] ?? null
    const dirtyRangeEndCandidate = strings[4] ?? null
    const dirtyRangeStart = [existing.dirtyRangeStart, dirtyRangeStartCandidate]
      .filter((value): value is string => {
        return value !== null
      })
      .sort()[0]
    const dirtyRangeEnd = [existing.dirtyRangeEnd, dirtyRangeEndCandidate]
      .filter((value): value is string => {
        return value !== null
      })
      .sort()
      .at(-1)

    dirtyWork.set(dirtyWorkId, {
      ...existing,
      dirtyRangeEnd: dirtyRangeEnd ?? null,
      dirtyRangeStart: dirtyRangeStart ?? null,
      firstSourceHighWaterMark: Math.min(existing.firstSourceHighWaterMark, numbers[0] ?? 0),
      latestDeltaId: strings[0] ?? null,
      latestSourceHighWaterMark: Math.max(existing.latestSourceHighWaterMark, numbers[1] ?? 0),
      status: 'pending',
      updatedAt: getClock(statements),
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
    const compacted = statement.includes('NULL,')
    const dirtyWorkId = compacted ? null : (strings[1] ?? '')
    const projectionComponent = strings[compacted ? 1 : 2] ?? ''
    const projectionIdentity = strings[compacted ? 2 : 3] ?? ''
    const sourcePartition = strings[compacted ? 3 : 4] ?? ''

    acks.set(dirtyAckId, {
      completedSourceHighWaterMark: numbers[0] ?? 0,
      dirtyAckId,
      dirtyRangeEnd: compacted ? null : (strings[6] ?? null),
      dirtyRangeStart: compacted ? null : (strings[5] ?? null),
      dirtyWorkId,
      projectionComponent,
      projectionIdentity,
      sourcePartition,
      status: 'completed',
    })
  }
  const deleteCompactedAcks = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const keepDirtyAckId = strings[0] ?? ''
    const projectionComponent = strings[1] ?? ''
    const projectionIdentity = strings[2] ?? ''
    const sourcePartition = strings[3] ?? ''
    const completedSourceHighWaterMark = numbers[0] ?? 0

    ;[...acks.values()]
      .filter((ack) => {
        return (
          ack.dirtyAckId !== keepDirtyAckId
          && ack.dirtyWorkId !== null
          && ack.projectionComponent === projectionComponent
          && ack.projectionIdentity === projectionIdentity
          && ack.sourcePartition === sourcePartition
          && ack.completedSourceHighWaterMark <= completedSourceHighWaterMark
        )
      })
      .map((ack) => {
        return ack.dirtyAckId
      })
      .forEach((dirtyAckId) => {
        acks.delete(dirtyAckId)
      })
  }
  const upsertWatermark = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const watermarkId = strings[0] ?? ''

    watermarks.set(watermarkId, Math.max(watermarks.get(watermarkId) ?? 0, numbers[0] ?? 0))
  }
  const upsertDirtySourceWatermarks = (statement: string) => {
    const valueTuples = [...statement.matchAll(/\('((?:''|[^'])*)',\s*'((?:''|[^'])*)',\s*(\d+)\)/gu)]

    valueTuples.forEach((match) => {
      const projectId = match[1]?.replaceAll("''", "'") ?? ''
      const sourcePartition = match[2]?.replaceAll("''", "'") ?? ''
      const sourceHighWaterMark = Number(match[3] ?? 0)
      const key = `${projectId}:${sourcePartition}`
      const existing = dirtySourceWatermarks.get(key)

      dirtySourceWatermarks.set(key, {
        projectId,
        sourceHighWaterMark: Math.max(existing?.sourceHighWaterMark ?? 0, sourceHighWaterMark),
        sourcePartition,
      })
    })
  }
  const isAckRangeCoveringStatement = (ack: FakeAckRow, statement: string) => {
    const strings = getSqlStrings(statement)
    const dirtyRangeStart = strings[4] ?? null
    const dirtyRangeEnd = strings[5] ?? null

    return ack.dirtyRangeStart === null || dirtyRangeStart === null || dirtyRangeEnd === null
      ? ack.dirtyRangeStart === null && ack.dirtyRangeEnd === null
      : ack.dirtyRangeStart <= dirtyRangeStart && (ack.dirtyRangeEnd ?? '') >= dirtyRangeEnd
  }
  const isAckRangeCoveringDirtyWork = (ack: FakeAckRow, row: FakeDirtyWorkRow) => {
    return ack.dirtyRangeStart === null && ack.dirtyRangeEnd === null
      ? true
      : row.dirtyRangeStart !== null
          && row.dirtyRangeEnd !== null
          && ack.dirtyRangeStart !== null
          && ack.dirtyRangeEnd !== null
          && ack.dirtyRangeStart <= row.dirtyRangeStart
          && ack.dirtyRangeEnd >= row.dirtyRangeEnd
  }
  const isDirtyWorkCoveredByAck = (row: FakeDirtyWorkRow) => {
    return [...acks.values()].some((ack) => {
      return (
        ack.projectionComponent === row.projectionComponent
        && ack.projectionIdentity === row.projectionIdentity
        && ack.sourcePartition === row.sourcePartition
        && ack.status === 'completed'
        && ack.completedSourceHighWaterMark >= row.latestSourceHighWaterMark
        && (ack.dirtyWorkId === row.dirtyWorkId || (ack.dirtyWorkId === null && isAckRangeCoveringDirtyWork(ack, row)))
      )
    })
  }
  const isDirtyWorkSourceWatermarkAdvanced = (row: FakeDirtyWorkRow) => {
    if (row.projectId === null) {
      return false
    }

    return (
      (dirtySourceWatermarks.get(`${row.projectId}:${row.sourcePartition}`)?.sourceHighWaterMark ?? -1)
      >= row.latestSourceHighWaterMark
    )
  }
  const hasLowerRetentionBlocker = (row: FakeDirtyWorkRow, highWaterMark = row.latestSourceHighWaterMark) => {
    return [...dirtyWork.values()].some((blocker) => {
      return (
        blocker.projectionComponent === row.projectionComponent
        && blocker.projectionIdentity === row.projectionIdentity
        && blocker.sourcePartition === row.sourcePartition
        && blocker.status !== 'completed'
        && blocker.latestSourceHighWaterMark <= highWaterMark
      )
    })
  }
  const getRetentionReadyRows = () => {
    return [...dirtyWork.values()].filter((row) => {
      return (
        row.status === 'completed'
        && isDirtyWorkSourceWatermarkAdvanced(row)
        && isDirtyWorkCoveredByAck(row)
        && !hasLowerRetentionBlocker(row)
      )
    })
  }
  const getRetentionReadyLanes = (statement: string) => {
    const lanes = new Map<
      string,
      {
        completedSourceHighWaterMark: number
        projectionComponent: string
        projectionIdentity: string
        sourcePartition: string
      }
    >()

    getRetentionReadyRows().forEach((row) => {
      const key = `${row.projectionComponent}:${row.projectionIdentity}:${row.sourcePartition}`
      const existing = lanes.get(key)

      lanes.set(key, {
        completedSourceHighWaterMark: Math.max(
          existing?.completedSourceHighWaterMark ?? 0,
          row.latestSourceHighWaterMark,
        ),
        projectionComponent: row.projectionComponent,
        projectionIdentity: row.projectionIdentity,
        sourcePartition: row.sourcePartition,
      })
    })

    return [...lanes.values()]
      .filter((lane) => {
        return (
          ![...dirtyWork.values()].some((blocker) => {
            return (
              blocker.projectionComponent === lane.projectionComponent
              && blocker.projectionIdentity === lane.projectionIdentity
              && blocker.sourcePartition === lane.sourcePartition
              && blocker.status !== 'completed'
              && blocker.latestSourceHighWaterMark <= lane.completedSourceHighWaterMark
            )
          })
          && ![...dirtyWork.values()].some((uncoveredCompleted) => {
            return (
              uncoveredCompleted.projectionComponent === lane.projectionComponent
              && uncoveredCompleted.projectionIdentity === lane.projectionIdentity
              && uncoveredCompleted.sourcePartition === lane.sourcePartition
              && uncoveredCompleted.status === 'completed'
              && uncoveredCompleted.latestSourceHighWaterMark <= lane.completedSourceHighWaterMark
              && (!isDirtyWorkSourceWatermarkAdvanced(uncoveredCompleted)
                || !isDirtyWorkCoveredByAck(uncoveredCompleted))
            )
          })
        )
      })
      .sort((left, right) => {
        return (
          left.projectionComponent.localeCompare(right.projectionComponent)
          || left.projectionIdentity.localeCompare(right.projectionIdentity)
          || left.sourcePartition.localeCompare(right.sourcePartition)
        )
      })
      .slice(0, getLimit(statement))
  }
  const deleteRetentionAcks = (statement: string) => {
    const limit = getLimit(statement)
    const syntheticAcks = [...acks.values()].filter((ack) => {
      return ack.status === 'completed' && ack.dirtyWorkId === null
    })
    const deletable = [...acks.values()]
      .filter((ack) => {
        return syntheticAcks.some((highWaterAck) => {
          return (
            ack.dirtyAckId !== highWaterAck.dirtyAckId
            && ack.status === 'completed'
            && ack.projectionComponent === highWaterAck.projectionComponent
            && ack.projectionIdentity === highWaterAck.projectionIdentity
            && ack.sourcePartition === highWaterAck.sourcePartition
            && ack.completedSourceHighWaterMark <= highWaterAck.completedSourceHighWaterMark
          )
        })
      })
      .sort((left, right) => {
        return (
          left.completedSourceHighWaterMark - right.completedSourceHighWaterMark
          || left.dirtyAckId.localeCompare(right.dirtyAckId)
        )
      })
      .slice(0, limit)

    deletable.forEach((ack) => {
      acks.delete(ack.dirtyAckId)
    })

    return deletable.map((ack) => {
      return {dirtyAckId: ack.dirtyAckId}
    })
  }
  const deleteRetentionDirtyWork = (statement: string) => {
    const deletable = getRetentionReadyRows()
      .sort((left, right) => {
        return (
          left.updatedAt.localeCompare(right.updatedAt)
          || left.latestSourceHighWaterMark - right.latestSourceHighWaterMark
          || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
        )
      })
      .slice(0, getLimit(statement))

    deletable.forEach((row) => {
      dirtyWork.delete(row.dirtyWorkId)
    })

    return deletable.map((row) => {
      return {dirtyWorkId: row.dirtyWorkId}
    })
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_source_change_outbox')) {
      return (options.barrier === undefined || options.barrier === null ? [] : [options.barrier]) as T[]
    }

    if (statement.includes('WITH retention_ready_dirty_work AS')) {
      return getRetentionReadyLanes(statement) as T[]
    }

    if (
      statement.includes('DELETE FROM app.review_serving_dirty_work_ack')
      && statement.includes('RETURNING dirty_ack_id AS dirtyAckId')
    ) {
      return deleteRetentionAcks(statement) as T[]
    }

    if (
      statement.includes('DELETE FROM app.review_serving_dirty_work')
      && statement.includes('RETURNING dirty_work_id AS dirtyWorkId')
    ) {
      return deleteRetentionDirtyWork(statement) as T[]
    }

    if (statement.includes('FROM app.review_serving_dirty_work_ack')) {
      const strings = getSqlStrings(statement)
      const numbers = getNumbers(statement)
      const projectionComponent = strings[0] ?? ''
      const projectionIdentity = strings[1] ?? ''
      const sourcePartition = strings[2] ?? ''
      const sourceHighWaterMark = numbers[0] ?? 0
      const acknowledged = [...acks.values()].some((ack) => {
        return (
          ack.projectionComponent === projectionComponent
          && ack.projectionIdentity === projectionIdentity
          && ack.sourcePartition === sourcePartition
          && ack.status === 'completed'
          && ack.completedSourceHighWaterMark >= sourceHighWaterMark
          && isAckRangeCoveringStatement(ack, statement)
        )
      })

      return (acknowledged ? [{acknowledged: true}] : []) as T[]
    }

    if (statement.includes('WHERE dirty_work_id =')) {
      const row = dirtyWork.get(getWhereLiteral(statement, 'dirty_work_id') ?? '')
      return (row === undefined ? [] : [getQueryRow(row)]) as T[]
    }

    if (statement.includes("status = 'pending'") && statement.includes('starts_with(projection_key')) {
      const prefix = getStartsWithLiteral(statement, 'projection_key') ?? ''
      const eligibleRows = [...dirtyWork.values()]
        .filter((row) => {
          return (row.status === 'pending' || row.status === 'running') && row.projectionKey.startsWith(prefix)
        })
        .sort((left, right) => {
          return (
            left.updatedAt.localeCompare(right.updatedAt)
            || left.latestSourceHighWaterMark - right.latestSourceHighWaterMark
            || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
          )
        })

      const usesBoundedLane = statement.includes('eligible_lane')
      const sourcePartition =
        usesBoundedLane || statement.includes('source_partition = (') ? eligibleRows[0]?.sourcePartition : null
      const projectionKey =
        usesBoundedLane || statement.includes('projection_key = (') ? eligibleRows[0]?.projectionKey : null

      const rows = eligibleRows
        .filter((row) => {
          return (
            (sourcePartition === null || row.sourcePartition === sourcePartition)
            && (projectionKey === null || row.projectionKey === projectionKey)
          )
        })
        .slice(0, getLimit(statement))

      if (statement.includes('UPDATE app.review_serving_dirty_work') && statement.includes('RETURNING')) {
        options.beforeClaimUpdate?.()

        return rows.flatMap((row) => {
          const existing = dirtyWork.get(row.dirtyWorkId)

          if (existing?.status !== 'pending' && existing?.status !== 'running') {
            return []
          }

          const updated = {...existing, status: 'running' as const, updatedAt: getClock(statements)}
          dirtyWork.set(row.dirtyWorkId, updated)

          return [getQueryRow(updated)]
        }) as T[]
      }

      return rows.map(getQueryRow) as T[]
    }

    return []
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('UPDATE app.review_serving_dirty_work') && !statement.includes('RETURNING')) {
      updateDirtyWork(statement)
    }

    if (statement.includes('INSERT INTO app.review_serving_dirty_work (')) {
      insertMissingDirtyWork(statement)
    }

    if (statement.includes("SET status = 'running'")) {
      updateStatus(statement, 'running', 'pending')
      updateStatus(statement, 'running', 'running')
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

    if (statement.includes('DELETE FROM app.review_serving_dirty_work_ack')) {
      deleteCompactedAcks(statement)
    }

    if (statement.includes('INSERT INTO app.review_serving_projector_watermark')) {
      upsertWatermark(statement)
    }

    if (
      statement.includes('INSERT INTO app.review_serving_project_dirty_source_watermark')
      || statement.includes('UPDATE app.review_serving_project_dirty_source_watermark')
    ) {
      upsertDirtySourceWatermarks(statement)
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

  return {acks, database, dirtySourceWatermarks, dirtyWork, statements, watermarks}
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
  const {database, dirtyWork, statements} = createFakeDirtyWorkDatabase()
  const first = await upsertDisplayWork(database, getBaseScope(5))
  const second = await upsertDisplayWork(database, getBaseScope(5), 'delta-1-replay')
  const row = await getReviewServingDirtyWork(first.dirtyWorkId, database)
  const dirtyWorkUpdate = statements.find((statement) => {
    return statement.includes('UPDATE app.review_serving_dirty_work')
  })
  const dirtyWorkInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work')
  })

  expect(second.dirtyWorkId).toBe(first.dirtyWorkId)
  expect(dirtyWork.size).toBe(1)
  expect(dirtyWorkUpdate).toContain('latest_source_high_water_mark = GREATEST')
  expect(dirtyWorkUpdate).toContain("status = 'pending'")
  expect(dirtyWorkInsert).toContain('WHERE NOT EXISTS')
  expect(dirtyWorkInsert).toContain("(existing.dirty_work_id || '')")
  expect(statements.join('\n')).not.toContain('ON CONFLICT(dirty_work_id) DO UPDATE SET')
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

test('claims pending work from one source partition per batch', async () => {
  const {database} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertDisplayWork(
    database,
    {...getBaseScope(2, '2', '2'), sourcePartition: 'prompt:config', scopeId: 'project-1:prompt-1'},
    'delta-2',
  )

  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)

  expect(claims).toHaveLength(1)
  expect(claims[0]?.sourcePartition).toBe('article:display')
})

test('claims pending work from one projection identity per batch', async () => {
  const {database} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertReviewServingDirtyWork(
    {
      latestDeltaId: 'delta-2',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-2',
      scope: {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'},
    },
    database,
  )

  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)

  expect(claims).toHaveLength(1)
  expect(claims[0]?.projectionIdentity).toBe('display:identity-1')
})

test('claim query blocks newer lane work behind lower running or backoff watermarks', async () => {
  const {database, statements} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')

  await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)
  const claimSelect = statements.find((statement) => {
    return statement.includes('NOT EXISTS') && statement.includes('blocker.latest_source_high_water_mark')
  })

  expect(claimSelect).toContain("blocker.status IN ('running', 'failed')")
  expect(claimSelect).toContain("blocker.updated_at > current_timestamp - INTERVAL '900 seconds'")
  expect(claimSelect).toContain(
    'blocker.latest_source_high_water_mark < app.review_serving_dirty_work.latest_source_high_water_mark',
  )
})

test('claims dirty work with one atomic update returning statement', async () => {
  const {database, statements} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')

  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)
  const claimUpdates = statements.filter((statement) => {
    return (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes("SET status = 'running'")
      && statement.includes('RETURNING')
    )
  })

  expect(claims).toHaveLength(2)
  expect(claimUpdates).toHaveLength(1)
  expect(claimUpdates[0]).toContain('WITH eligible_lane AS (')
  expect(claimUpdates[0]).toContain('claim_candidates AS (')
  expect(claimUpdates[0]).toContain('eligible_lane.source_partition = app.review_serving_dirty_work.source_partition')
  expect(claimUpdates[0]).toContain('eligible_lane.projection_key = app.review_serving_dirty_work.projection_key')
  expect(claimUpdates[0]).not.toContain('AND source_partition = (')
  expect(claimUpdates[0]).not.toContain('AND projection_key = (')
})

test('claims only return rows whose atomic update succeeded', async () => {
  let setup: ReturnType<typeof createFakeDirtyWorkDatabase>

  setup = createFakeDirtyWorkDatabase({
    beforeClaimUpdate: () => {
      const row = [...setup.dirtyWork.values()][0]

      if (row !== undefined) {
        setup.dirtyWork.set(row.dirtyWorkId, {...row, status: 'completed'})
      }
    },
  })
  const {database} = setup

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')

  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  expect(claims).toHaveLength(0)
})

test('release returns running claims to pending for the next wake', async () => {
  const {database} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1), 'delta-1')
  const [claim] = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  await releaseReviewServingDirtyWorkClaims([claim?.dirtyWorkId ?? ''], database)

  const row = await getReviewServingDirtyWork(claim?.dirtyWorkId ?? '', database)

  expect(row?.status).toBe('pending')
})

test('claims stale running work after the running lease expires', async () => {
  const {database, statements} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1), 'delta-1')
  await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  const claims = await claimReviewServingDirtyWork(
    {
      limit: 1,
      now: new Date(Date.UTC(2026, 5, 16, 13, 0)),
      projectionComponent: 'display',
      staleRunningClaimSeconds: 60,
    },
    database,
  )
  const claimSelect = statements
    .filter((statement) => {
      return statement.includes('FROM app.review_serving_dirty_work') && statement.includes("status = 'running'")
    })
    .at(-1)

  expect(claims).toHaveLength(1)
  expect(claimSelect).toContain("status = 'running'")
  expect(claimSelect).toContain("status = 'failed'")
  expect(claimSelect).toContain("INTERVAL '60 seconds'")
  expect(claimSelect).toContain("TIMESTAMPTZ '2026-06-16T13:00:00.000Z'")
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

test('completion advances dirty source watermarks by project and source partition without dropping acknowledgements', async () => {
  const {acks, database, dirtySourceWatermarks, statements} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(5, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(9, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')
  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaims(claims, database)

  const aggregateInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_serving_project_dirty_source_watermark')
  })
  const aggregateUpdate = statements.find((statement) => {
    return statement.includes('UPDATE app.review_serving_project_dirty_source_watermark')
  })

  expect(acks.size).toBe(2)
  expect(dirtySourceWatermarks.get('project-1:article:display')).toMatchObject({
    projectId: 'project-1',
    sourceHighWaterMark: 9,
    sourcePartition: 'article:display',
  })
  expect(aggregateUpdate).toContain('GROUP BY project_id, source_partition')
  expect(aggregateUpdate).toContain('source_high_water_mark = GREATEST')
  expect(aggregateInsert).toContain('GROUP BY project_id, source_partition')
  expect(aggregateInsert).toContain('WHERE NOT EXISTS')
  expect(`${aggregateUpdate}\n${aggregateInsert}`).not.toContain('ON CONFLICT')
  expect(aggregateInsert).not.toContain('DELETE FROM app.review_serving_dirty_work_ack')
})

test('completion advances dirty source watermarks monotonically in DuckDB without conflict updates', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()
  const run = async (statement: string) => {
    await connection.run(statement)
  }
  const queryJson = async <T>(statement: string) => {
    const reader = await connection.runAndReadAll(statement)

    return reader.getRowObjectsJson() as T[]
  }

  try {
    await run('CREATE SCHEMA app')
    await run(`
      CREATE TABLE app.review_serving_dirty_work_ack (
        dirty_ack_id VARCHAR PRIMARY KEY,
        dirty_work_id VARCHAR,
        projection_component VARCHAR,
        projection_identity VARCHAR,
        source_partition VARCHAR,
        completed_source_high_water_mark BIGINT,
        dirty_range_start VARCHAR,
        dirty_range_end VARCHAR,
        status VARCHAR,
        completed_at TIMESTAMPTZ
      )
    `)
    await run(`
      CREATE TABLE app.review_serving_project_dirty_source_watermark (
        project_id VARCHAR,
        source_partition VARCHAR,
        source_high_water_mark BIGINT,
        updated_at TIMESTAMPTZ,
        PRIMARY KEY (project_id, source_partition)
      )
    `)
    await run(`
      CREATE TABLE app.review_serving_dirty_work (
        dirty_work_id VARCHAR PRIMARY KEY,
        status VARCHAR,
        updated_at TIMESTAMPTZ
      )
    `)

    const getClaim = (dirtyWorkId: string, latestSourceHighWaterMark: number): ReviewServingDirtyWorkClaim => {
      return {
        articleId: 'article-1',
        dirtyKind: 'article.display.updated',
        dirtyRangeEnd: 'article-1',
        dirtyRangeStart: 'article-1',
        dirtyWorkId,
        firstSourceHighWaterMark: latestSourceHighWaterMark,
        latestDeltaId: `delta-${latestSourceHighWaterMark}`,
        latestSourceHighWaterMark,
        projectId: 'project-1',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        scopeId: 'project-1:article-1',
        scopeKind: 'article',
        sourcePartition: 'article:display',
        status: 'running',
      }
    }
    const database = {queryJson, run}

    await completeReviewServingDirtyWorkClaims([getClaim('dirty-work-5', 5)], database)
    await completeReviewServingDirtyWorkClaims([getClaim('dirty-work-3', 3)], database)
    await completeReviewServingDirtyWorkClaims([getClaim('dirty-work-9', 9)], database)

    const rows = await queryJson<{sourceHighWaterMark: number}>(`
      SELECT CAST(source_high_water_mark AS INTEGER) AS sourceHighWaterMark
      FROM app.review_serving_project_dirty_source_watermark
      WHERE project_id = 'project-1'
        AND source_partition = 'article:display'
    `)

    expect(rows).toEqual([{sourceHighWaterMark: 9}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('concurrent dirty source watermark completion cannot lose the higher watermark', async () => {
  let dirtySourceWatermark: number | null = null
  let resolveHighWatermarkStatement = () => {}
  let resolveLowInsert = () => {}
  const highWatermarkStatement = new Promise<void>((resolve) => {
    resolveHighWatermarkStatement = resolve
  })
  const lowInsert = new Promise<void>((resolve) => {
    resolveLowInsert = resolve
  })
  const getClaim = (dirtyWorkId: string, latestSourceHighWaterMark: number): ReviewServingDirtyWorkClaim => {
    return {
      articleId: 'article-1',
      dirtyKind: 'article.display.updated',
      dirtyRangeEnd: 'article-1',
      dirtyRangeStart: 'article-1',
      dirtyWorkId,
      firstSourceHighWaterMark: latestSourceHighWaterMark,
      latestDeltaId: `delta-${latestSourceHighWaterMark}`,
      latestSourceHighWaterMark,
      projectId: 'project-1',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      scopeId: 'project-1:article-1',
      scopeKind: 'article',
      sourcePartition: 'article:display',
      status: 'running',
    }
  }
  const run = async (statement: string) => {
    if (statement.includes('INSERT INTO app.review_serving_dirty_work_ack') && statement.includes('dirty-work-low')) {
      await highWatermarkStatement

      return
    }

    const isInsert = statement.includes('INSERT INTO app.review_serving_project_dirty_source_watermark')
    const isUpdate = statement.includes('UPDATE app.review_serving_project_dirty_source_watermark')

    if (!isInsert && !isUpdate) {
      return
    }

    const sourceHighWaterMark = Number(statement.match(/\('project-1',\s*'article:display',\s*(\d+)\)/u)?.[1] ?? 0)

    if (sourceHighWaterMark === 9) {
      resolveHighWatermarkStatement()
    }

    if (isInsert) {
      if (sourceHighWaterMark === 9 && dirtySourceWatermark === null) {
        // Force the lower insert to land before the higher caller reaches its final monotonic update.
        await lowInsert
      }

      if (dirtySourceWatermark === null) {
        dirtySourceWatermark = sourceHighWaterMark

        if (sourceHighWaterMark === 5) {
          resolveLowInsert()
        }
      }

      return
    }

    const rowExistedWhenUpdateStarted = dirtySourceWatermark !== null

    if (sourceHighWaterMark === 9 && !rowExistedWhenUpdateStarted) {
      await lowInsert
    }

    if (rowExistedWhenUpdateStarted) {
      dirtySourceWatermark = Math.max(dirtySourceWatermark ?? 0, sourceHighWaterMark)
    }
  }
  const database = {
    queryJson: async <T>() => {
      return [] as T[]
    },
    run,
  }

  await Promise.all([
    completeReviewServingDirtyWorkClaims([getClaim('dirty-work-high', 9)], database),
    completeReviewServingDirtyWorkClaims([getClaim('dirty-work-low', 5)], database),
  ])

  expect(dirtySourceWatermark).toBe(9)
})

test('component acknowledgements skip already completed dirty keys', async () => {
  const {acks, database, dirtyWork} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(5), 'delta-1')
  const firstClaims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(firstClaims, database)

  const result = await upsertDisplayWork(database, getBaseScope(5), 'delta-1-replayed')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  expect(result.skipped).toBe(true)
  expect(acks.size).toBe(1)
  expect(dirtyWork.size).toBe(1)
  expect(claims).toHaveLength(0)
})

test('dirty-work completion and watermark advance are blocked atomically by source barriers', async () => {
  const {acks, database, statements} = createFakeDirtyWorkDatabase({
    barrier: {outboxId: 'outbox-blocked', sourceHighWaterMark: 3, status: 'retryable'},
  })

  await upsertDisplayWork(database, getBaseScope(5), 'delta-1')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  const error = await completeReviewServingDirtyWorkClaimsAndAdvanceWatermark(
    {
      claims,
      watermark: {
        projectionComponent: 'display',
        projectorName: 'review-serving-v4-display',
        sourceHighWaterMark: 5,
        sourcePartition: 'article:display',
      },
    },
    database,
  ).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught instanceof Error ? caught : new Error(String(caught))
    },
  )

  expect(error?.message).toBe('review-serving watermark blocked by unreconciled outbox outbox-blocked at 3 (retryable)')
  expect(acks.size).toBe(0)
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_serving_projector_watermark')
})

test('dirty-work acknowledgements and watermark advance in one transaction', async () => {
  const {acks, database, statements, watermarks} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(5), 'delta-1')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaimsAndAdvanceWatermark(
    {
      claims,
      watermark: {
        projectionComponent: 'display',
        projectorName: 'review-serving-v4-display',
        sourceHighWaterMark: 5,
        sourcePartition: 'article:display',
      },
    },
    database,
  )

  expect(acks.size).toBe(1)
  expect(watermarks.size).toBe(1)
  expect(statements.join('\n')).toContain("status NOT IN ('operator_terminal', 'reconciled')")
})

test('ack compaction creates a component high-water row and removes covered point acks', async () => {
  const {acks, database, statements} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(3), 'delta-1')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)

  expect(acks.size).toBe(1)

  const result = await compactReviewServingDirtyWorkAcknowledgements(
    {
      completedSourceHighWaterMark: 5,
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      sourcePartition: 'article:display',
    },
    database,
  )

  const remainingAcks = [...acks.values()]

  expect(result.compactedThroughHighWaterMark).toBe(5)
  expect(remainingAcks).toHaveLength(1)
  expect(remainingAcks[0]).toMatchObject({
    completedSourceHighWaterMark: 5,
    dirtyWorkId: null,
    projectionComponent: 'display',
  })

  const compactedAckInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work_ack') && statement.includes('dirty_work_id')
  })
  expect(compactedAckInsert).toContain('WHERE NOT EXISTS')
  expect(compactedAckInsert).toContain('existing.dirty_ack_id = incoming.dirty_ack_id')
  expect(compactedAckInsert).not.toContain('DO UPDATE SET')
})

test('ack compaction replays the same high-water row without updating it', async () => {
  const {acks, database, statements} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(3), 'delta-1')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)

  const firstResult = await compactReviewServingDirtyWorkAcknowledgements(
    {
      completedSourceHighWaterMark: 5,
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      sourcePartition: 'article:display',
    },
    database,
  )
  const secondResult = await compactReviewServingDirtyWorkAcknowledgements(
    {
      completedSourceHighWaterMark: 5,
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      sourcePartition: 'article:display',
    },
    database,
  )

  const compactedAckInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_serving_dirty_work_ack') && statement.includes('NULL,')
  })
  const remainingAcks = [...acks.values()]

  expect(secondResult.dirtyAckId).toBe(firstResult.dirtyAckId)
  expect(compactedAckInserts).toHaveLength(2)
  expect(compactedAckInserts.join('\n')).toContain('WHERE NOT EXISTS')
  expect(compactedAckInserts.join('\n')).toContain('existing.dirty_ack_id = incoming.dirty_ack_id')
  expect(compactedAckInserts.join('\n')).not.toContain('DO UPDATE SET')
  expect(remainingAcks).toHaveLength(1)
  expect(remainingAcks[0]).toMatchObject({
    completedSourceHighWaterMark: 5,
    dirtyAckId: firstResult.dirtyAckId,
    dirtyWorkId: null,
    projectionComponent: 'display',
  })
})

test('retention cleanup preserves pending running and failed dirty work rows', async () => {
  const {database, dirtyWork} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')
  await upsertDisplayWork(database, {...getBaseScope(3, '3', '3'), scopeId: 'project-1:article-3'}, 'delta-3')
  await upsertDisplayWork(database, {...getBaseScope(4, '4', '4'), scopeId: 'project-1:article-4'}, 'delta-4')
  const claims = await claimReviewServingDirtyWork({limit: 4, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaims(claims.slice(0, 1), database)
  await failReviewServingDirtyWorkClaims([claims[1]?.dirtyWorkId ?? ''], database)
  await releaseReviewServingDirtyWorkClaims([claims[2]?.dirtyWorkId ?? ''], database)

  const result = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )
  const statuses = [...dirtyWork.values()].map((row) => {
    return row.status
  })

  expect(result.deletedDirtyWorkCount).toBe(1)
  expect(statuses.sort()).toEqual(['failed', 'pending', 'running'])
})

test('retention cleanup inserts high-water ack and removes point and older synthetic acknowledgements', async () => {
  const {acks, database} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(3, '3', '3'), 'delta-3')
  let claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)

  const first = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )

  await upsertDisplayWork(database, getBaseScope(5, '5', '5'), 'delta-5')
  claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)

  const second = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )
  const remainingAcks = [...acks.values()]

  expect(first.compactedAcknowledgements[0]).toMatchObject({
    completedSourceHighWaterMark: 3,
    projectionComponent: 'display',
  })
  expect(second.deletedAcknowledgementCount).toBe(2)
  expect(remainingAcks).toHaveLength(1)
  expect(remainingAcks[0]).toMatchObject({
    completedSourceHighWaterMark: 5,
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: null,
  })
})

test('retention cleanup deletes only completed dirty rows covered by ack and project source watermark', async () => {
  const {acks, database, dirtySourceWatermarks, dirtyWork} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(5, '5', '5'), 'delta-5')
  await upsertDisplayWork(database, {...getBaseScope(8, '8', '8'), scopeId: 'project-1:article-8'}, 'delta-8')
  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaims(claims, database)

  const highWaterClaim = claims.find((claim) => {
    return claim.latestSourceHighWaterMark === 8
  })

  if (highWaterClaim !== undefined) {
    ;[...acks.values()]
      .filter((ack) => {
        return ack.dirtyWorkId === highWaterClaim.dirtyWorkId
      })
      .forEach((ack) => {
        acks.delete(ack.dirtyAckId)
      })
  }

  dirtySourceWatermarks.set('project-1:article:display', {
    projectId: 'project-1',
    sourceHighWaterMark: 5,
    sourcePartition: 'article:display',
  })

  const result = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )
  const remainingHighWaters = [...dirtyWork.values()].map((row) => {
    return row.latestSourceHighWaterMark
  })

  expect(result.deletedDirtyWorkCount).toBe(1)
  expect(remainingHighWaters).toEqual([8])
})

test('retention cleanup does not let point acknowledgements cover other dirty rows', async () => {
  const {acks, database, dirtyWork} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(5, '1', '1'), 'delta-5')
  await upsertDisplayWork(database, {...getBaseScope(8, '1', '1'), scopeId: 'project-1:article-8'}, 'delta-8')
  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaims(claims, database)

  const lowWaterClaim = claims.find((claim) => {
    return claim.latestSourceHighWaterMark === 5
  })

  if (lowWaterClaim !== undefined) {
    ;[...acks.values()]
      .filter((ack) => {
        return ack.dirtyWorkId === lowWaterClaim.dirtyWorkId
      })
      .forEach((ack) => {
        acks.delete(ack.dirtyAckId)
      })
  }

  const result = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 0, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 0},
    database,
  )
  const remainingHighWaters = [...dirtyWork.values()].map((row) => {
    return row.latestSourceHighWaterMark
  })

  expect(result.deletedDirtyWorkCount).toBe(1)
  expect(remainingHighWaters).toEqual([5])
})

test('retention cleanup is idempotent after rows are compacted and deleted', async () => {
  const {acks, database, dirtyWork} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(5, '5', '5'), 'delta-5')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)

  const first = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )
  const second = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )

  expect(first).toMatchObject({compactedLaneCount: 1, deletedAcknowledgementCount: 1, deletedDirtyWorkCount: 1})
  expect(second).toMatchObject({compactedLaneCount: 0, deletedAcknowledgementCount: 0, deletedDirtyWorkCount: 0})
  expect(acks.size).toBe(1)
  expect(dirtyWork.size).toBe(0)
})

test('retention cleanup skips lanes blocked by non-completed work at or below high-water', async () => {
  const {acks, database, dirtyWork} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(4, '4', '4'), 'delta-4')
  await upsertDisplayWork(database, {...getBaseScope(5, '5', '5'), scopeId: 'project-1:article-5'}, 'delta-5')
  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)
  const highWaterClaim = claims.find((claim) => {
    return claim.latestSourceHighWaterMark === 5
  })

  await completeReviewServingDirtyWorkClaims(highWaterClaim === undefined ? [] : [highWaterClaim], database)
  await releaseReviewServingDirtyWorkClaims(
    claims
      .filter((claim) => {
        return claim.latestSourceHighWaterMark === 4
      })
      .map((claim) => {
        return claim.dirtyWorkId
      }),
    database,
  )

  const result = await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )

  expect(result).toMatchObject({compactedLaneCount: 0, deletedAcknowledgementCount: 0, deletedDirtyWorkCount: 0})
  expect([...acks.values()]).toHaveLength(1)
  expect(
    [...dirtyWork.values()]
      .map((row) => {
        return row.status
      })
      .sort(),
  ).toEqual(['completed', 'pending'])
})
