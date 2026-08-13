import {expect, test} from 'bun:test'

import {
  claimReviewServingDirtyWork,
  cleanupReviewServingDirtyWorkRetention,
  compactReviewServingDirtyWorkAcknowledgements,
  completeReviewServingDirtyWorkClaims,
  completeReviewServingDirtyWorkClaimsAndAdvanceWatermark,
  completeReviewServingDirtyWorkCoveredByRebuild,
  failReviewServingDirtyWorkClaims,
  getReviewServingDirtyWork,
  releaseReviewServingDirtyWorkClaims,
  type ReviewServingDirtyWorkDatabase,
  type ReviewServingDirtyWorkRecord,
  upsertReviewServingDirtyWork,
} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingDirtyWorkScopeForChange,
  getReviewServingSourceWatermarkKeys,
  type ReviewServingDirtyWorkScope,
} from './reviewServingProjectorDomain.ts'

type FakeDirtyWorkRow = Omit<
  ReviewServingDirtyWorkRecord,
  'createdAt' | 'projectionComponent' | 'projectionIdentity' | 'updatedAt'
> & {
  createdAt: string
  projectionComponent: ReviewServingDirtyWorkRecord['projectionComponent'] | null
  projectionIdentity: string | null
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

const getInNumbers = (statement: string, columnName: string) => {
  const inList = statement.match(new RegExp(`${columnName}\\s+IN\\s+\\(([^)]*)\\)`, 'u'))?.[1] ?? ''

  return getNumbers(inList)
}

const getEqualLiterals = (statement: string, columnName: string) => {
  return [...statement.matchAll(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*'((?:''|[^'])*)'`, 'gu'))].map(
    (match) => {
      return match[1]?.replaceAll("''", "'") ?? ''
    },
  )
}

const getEqualNumbers = (statement: string, columnName: string) => {
  const unquotedStatement = statement.replace(/'((?:''|[^'])*)'/g, "''")

  return [...unquotedStatement.matchAll(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*(-?\\d+)`, 'gu'))].map(
    (match) => {
      return Number(match[1] ?? 0)
    },
  )
}

const getLimit = (statement: string) => {
  return Number([...statement.matchAll(/LIMIT\s+(\d+)/gu)].at(-1)?.[1] ?? 0)
}

const getProjectionFromKey = (projectionKey: string) => {
  return JSON.parse(projectionKey) as {projectionComponent: 'display' | 'search'; projectionIdentity: string}
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

const getBaseScope = (
  sourceHighWaterMark: number,
  dirtyRangeStart: string | null = '1',
  dirtyRangeEnd: string | null = '1',
) => {
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
      lifecycleReason: row.lifecycleReason,
      projectId: row.projectId,
      projectionComponent: row.projectionComponent,
      projectionIdentity: row.projectionIdentity,
      projectionKey: row.projectionKey,
      scopeId: row.scopeId,
      scopeKind: row.scopeKind,
      sourcePartition: row.sourcePartition,
      status: row.status,
      storageRowId: row.storageRowId,
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
    const projection = getProjectionFromKey(strings[5] ?? '{}')
    const row: FakeDirtyWorkRow = {
      articleId: strings[4] ?? null,
      createdAt: now,
      dirtyKind: strings[8] ?? 'article.display.updated',
      dirtyRangeEnd: strings[12] ?? null,
      dirtyRangeStart: strings[11] ?? null,
      dirtyWorkId,
      firstSourceHighWaterMark: numbers[0] ?? 0,
      latestDeltaId: strings[10] ?? null,
      latestSourceHighWaterMark: numbers[1] ?? 0,
      lifecycleReason: null,
      projectId: strings[1] ?? null,
      projectionComponent:
        (strings[6] as ReviewServingDirtyWorkRecord['projectionComponent'] | undefined)
        ?? projection.projectionComponent,
      projectionIdentity: strings[7] ?? projection.projectionIdentity,
      projectionKey: strings[5] ?? '',
      scopeId: strings[3] ?? '',
      scopeKind: strings[2] ?? 'article',
      sourcePartition: strings[9] ?? '',
      status: 'pending' as const,
      storageRowId: dirtyWork.size + 1,
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
    const dirtyRangeStartCandidate = strings[3] ?? null
    const dirtyRangeEndCandidate = strings[6] ?? null
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
      lifecycleReason: null,
      projectionComponent:
        (strings[1] as ReviewServingDirtyWorkRecord['projectionComponent'] | undefined) ?? existing.projectionComponent,
      projectionIdentity: strings[2] ?? existing.projectionIdentity,
      status: 'pending',
      updatedAt: getClock(statements),
    })
  }
  const updateStatus = (
    statement: string,
    status: FakeDirtyWorkRow['status'],
    expectedStatus: FakeDirtyWorkRow['status'],
  ) => {
    const dirtyWorkIds = getInLiterals(statement, 'dirty_work_id')
    const rowIds = getInNumbers(statement, 'rowid')
    const matchingRows =
      rowIds.length > 0
        ? [...dirtyWork.values()].filter((row) => {
            return row.storageRowId !== undefined && row.storageRowId !== null && rowIds.includes(row.storageRowId)
          })
        : dirtyWorkIds.flatMap((dirtyWorkId) => {
            const row = dirtyWork.get(dirtyWorkId)

            return row === undefined ? [] : [row]
          })

    matchingRows.forEach((existing) => {
      if (existing.status === expectedStatus) {
        const lifecycleReason =
          (statement.match(/lifecycle_reason\s*=\s*'((?:''|[^'])*)'/u)?.[1] as
            | FakeDirtyWorkRow['lifecycleReason']
            | undefined) ?? existing.lifecycleReason

        dirtyWork.set(existing.dirtyWorkId, {...existing, lifecycleReason, status, updatedAt: getClock(statements)})
      }
    })
  }
  const insertAck = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const compacted = statement.includes('NULL,')

    if (compacted) {
      for (let index = 0; index < strings.length; index += 5) {
        const dirtyAckId = strings[index] ?? ''
        const projectionComponent = strings[index + 1] ?? ''
        const projectionIdentity = strings[index + 2] ?? ''
        const sourcePartition = strings[index + 3] ?? ''

        acks.set(dirtyAckId, {
          completedSourceHighWaterMark: numbers[Math.floor(index / 5)] ?? 0,
          dirtyAckId,
          dirtyRangeEnd: null,
          dirtyRangeStart: null,
          dirtyWorkId: null,
          projectionComponent,
          projectionIdentity,
          sourcePartition,
          status: 'completed',
        })
      }

      return
    }

    const dirtyAckId = strings[0] ?? ''
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
  const getCoverageRows = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const coverages = new Map<
      string,
      {completedSourceHighWaterMark: number; projectId: string; projectionKey: string; sourcePartition: string}
    >()

    for (let index = 0; index < strings.length; index += 5) {
      const projectId = strings[index] ?? ''
      const projectionKey = strings[index + 1] ?? ''
      const sourcePartition = strings[index + 4] ?? ''
      const completedSourceHighWaterMark = numbers[Math.floor(index / 5)] ?? 0
      const key = `${projectId}:${projectionKey}:${sourcePartition}`
      const existing = coverages.get(key)

      coverages.set(key, {
        completedSourceHighWaterMark: Math.max(
          existing?.completedSourceHighWaterMark ?? 0,
          completedSourceHighWaterMark,
        ),
        projectId,
        projectionKey,
        sourcePartition,
      })
    }

    return [...dirtyWork.values()].filter((row) => {
      const sourceWatermarkKeys = [row.sourcePartition, ...getReviewServingSourceWatermarkKeys(row.sourcePartition)]

      return sourceWatermarkKeys.some((sourceWatermarkKey) => {
        const coverage = coverages.get(`${row.projectId}:${row.projectionKey}:${sourceWatermarkKey}`)

        return (
          coverage !== undefined
          && row.status !== 'completed'
          && row.latestSourceHighWaterMark <= coverage.completedSourceHighWaterMark
        )
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
  const getFixedNow = (statement: string) => {
    const timestamp = statement.match(/TIMESTAMPTZ\s+'([^']+)'/u)?.[1]

    return timestamp === undefined ? null : new Date(timestamp)
  }
  const getStaleSeconds = (statement: string) => {
    return Number(statement.match(/INTERVAL\s+'(\d+) seconds'/u)?.[1] ?? 900)
  }
  const isStaleForStatement = (row: FakeDirtyWorkRow, statement: string) => {
    const fixedNow = getFixedNow(statement)

    if (fixedNow === null) {
      return false
    }

    return new Date(row.updatedAt).getTime() <= fixedNow.getTime() - getStaleSeconds(statement) * 1000
  }
  const isClaimEligibleForStatement = (row: FakeDirtyWorkRow, statement: string) => {
    return (
      row.status === 'pending'
      || ((row.status === 'running' || row.status === 'failed') && isStaleForStatement(row, statement))
    )
  }
  const getClaimStateRow = (row: FakeDirtyWorkRow) => {
    return {
      dirtyRangeEnd: row.dirtyRangeEnd,
      dirtyRangeStart: row.dirtyRangeStart,
      dirtyWorkId: row.dirtyWorkId,
      latestSourceHighWaterMark: row.latestSourceHighWaterMark,
      projectId: row.projectId ?? '',
      projectionComponent: row.projectionComponent ?? 'display',
      projectionIdentity: row.projectionIdentity ?? '',
      sourcePartition: row.sourcePartition,
      status: row.status,
      storageRowId: row.storageRowId ?? null,
      updatedAt: row.updatedAt,
    }
  }
  const getClaimStateRows = (statement: string) => {
    const projectionComponent = getWhereLiteral(statement, 'projection_component') ?? ''
    const eligibleRows = [...dirtyWork.values()]
      .filter((row) => {
        return (
          row.projectionComponent === projectionComponent
          && row.projectionIdentity !== null
          && isClaimEligibleForStatement(row, statement)
        )
      })
      .sort((left, right) => {
        return (
          left.updatedAt.localeCompare(right.updatedAt)
          || left.latestSourceHighWaterMark - right.latestSourceHighWaterMark
          || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
        )
      })
    const oldest = eligibleRows.find((row) => {
      return ![...dirtyWork.values()].some((blocker) => {
        return (
          (blocker.status === 'running' || blocker.status === 'failed')
          && !isStaleForStatement(blocker, statement)
          && (blocker.projectId ?? '') === (row.projectId ?? '')
          && blocker.projectionComponent === row.projectionComponent
          && blocker.projectionIdentity === row.projectionIdentity
          && blocker.sourcePartition === row.sourcePartition
          && blocker.latestSourceHighWaterMark < row.latestSourceHighWaterMark
        )
      })
    })

    if (oldest === undefined) {
      return []
    }

    return eligibleRows
      .filter((row) => {
        return (
          (row.projectId ?? '') === (oldest.projectId ?? '')
          && row.projectionComponent === oldest.projectionComponent
          && row.projectionIdentity === oldest.projectionIdentity
          && row.sourcePartition === oldest.sourcePartition
        )
      })
      .slice(0, getLimit(statement))
      .map(getClaimStateRow)
  }
  const getCoalescableClaimStateRows = () => {
    return [...dirtyWork.values()]
      .filter((older) => {
        return (
          older.status === 'pending'
          && older.dirtyRangeStart === null
          && older.dirtyRangeEnd === null
          && [...dirtyWork.values()].some((newer) => {
            return (
              newer.dirtyWorkId !== older.dirtyWorkId
              && (newer.status === 'pending' || newer.status === 'running')
              && newer.projectId === older.projectId
              && newer.projectionComponent === older.projectionComponent
              && newer.projectionIdentity === older.projectionIdentity
              && newer.sourcePartition === older.sourcePartition
              && newer.dirtyRangeStart === null
              && newer.dirtyRangeEnd === null
              && (newer.latestSourceHighWaterMark > older.latestSourceHighWaterMark
                || newer.updatedAt > older.updatedAt
                || newer.dirtyWorkId > older.dirtyWorkId)
            )
          })
        )
      })
      .sort((left, right) => {
        return (
          left.updatedAt.localeCompare(right.updatedAt)
          || left.latestSourceHighWaterMark - right.latestSourceHighWaterMark
          || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
        )
      })
      .slice(0, 1)
      .map(getClaimStateRow)
  }
  const getTargetDirtyWorkRows = (statement: string) => {
    const dirtyWorkIds = [
      ...new Set([...getInLiterals(statement, 'dirty_work_id'), ...getEqualLiterals(statement, 'dirty_work_id')]),
    ]
    const rowIds = [...new Set([...getInNumbers(statement, 'rowid'), ...getEqualNumbers(statement, 'rowid')])]

    return [...dirtyWork.values()].filter((row) => {
      return (
        dirtyWorkIds.includes(row.dirtyWorkId)
        || (row.storageRowId !== undefined && row.storageRowId !== null && rowIds.includes(row.storageRowId))
      )
    })
  }
  const updateDirtyWorkReturningRows = (
    statement: string,
    status: FakeDirtyWorkRow['status'],
    expectedStatus: FakeDirtyWorkRow['status'] | 'claimable',
  ) => {
    options.beforeClaimUpdate?.()

    return getTargetDirtyWorkRows(statement).flatMap((existing) => {
      const current = dirtyWork.get(existing.dirtyWorkId)

      if (current === undefined) {
        return []
      }

      const matchesExpected =
        expectedStatus === 'claimable'
          ? isClaimEligibleForStatement(current, statement)
          : current.status === expectedStatus

      if (!matchesExpected) {
        return []
      }

      const lifecycleReason =
        (statement.match(/lifecycle_reason\s*=\s*'((?:''|[^'])*)'/u)?.[1] as
          | FakeDirtyWorkRow['lifecycleReason']
          | undefined) ?? current.lifecycleReason
      const updated = {...current, lifecycleReason, status, updatedAt: getClock(statements)}
      dirtyWork.set(current.dirtyWorkId, updated)

      return [getQueryRow(updated)]
    })
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
        projectionComponent: row.projectionComponent ?? 'display',
        projectionIdentity: row.projectionIdentity ?? '',
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
  const getRetentionAckRows = (statement: string) => {
    const limit = getLimit(statement)
    const syntheticAcks = [...acks.values()].filter((ack) => {
      return ack.status === 'completed' && ack.dirtyWorkId === null
    })
    return [...acks.values()]
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
  }
  const getRetentionDirtyWorkRows = (statement: string) => {
    return getRetentionReadyRows()
      .sort((left, right) => {
        return (
          left.updatedAt.localeCompare(right.updatedAt)
          || left.latestSourceHighWaterMark - right.latestSourceHighWaterMark
          || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
        )
      })
      .slice(0, getLimit(statement))
  }
  const getLaneRepairRows = (statement: string) => {
    return [...dirtyWork.values()]
      .filter((row) => {
        return row.projectionComponent === null || row.projectionIdentity === null
      })
      .slice(0, getLimit(statement))
      .map((row) => {
        return {storageRowId: row.storageRowId ?? 0}
      })
  }
  const repairLaneRowsByIds = (statement: string) => {
    const rowIds = getInNumbers(statement, 'rowid')

    ;[...dirtyWork.values()]
      .filter((row) => {
        return row.storageRowId !== undefined && row.storageRowId !== null && rowIds.includes(row.storageRowId)
      })
      .forEach((row) => {
        const projection = getProjectionFromKey(row.projectionKey)

        dirtyWork.set(row.dirtyWorkId, {
          ...row,
          projectionComponent: projection.projectionComponent,
          projectionIdentity: projection.projectionIdentity,
        })
      })
  }
  const getCoalescableDirtyWorkRows = (statement: string) => {
    return [...dirtyWork.values()]
      .filter((older) => {
        return (
          older.status === 'pending'
          && older.dirtyRangeStart === null
          && older.dirtyRangeEnd === null
          && [...dirtyWork.values()].some((newer) => {
            return (
              newer.dirtyWorkId !== older.dirtyWorkId
              && (newer.status === 'pending' || newer.status === 'running')
              && newer.projectId === older.projectId
              && newer.projectionComponent === older.projectionComponent
              && newer.projectionIdentity === older.projectionIdentity
              && newer.sourcePartition === older.sourcePartition
              && newer.dirtyRangeStart === null
              && newer.dirtyRangeEnd === null
              && newer.latestSourceHighWaterMark >= older.latestSourceHighWaterMark
              && (newer.latestSourceHighWaterMark > older.latestSourceHighWaterMark
                || newer.updatedAt > older.updatedAt
                || newer.dirtyWorkId > older.dirtyWorkId)
            )
          })
        )
      })
      .sort((left, right) => {
        return (
          left.updatedAt.localeCompare(right.updatedAt)
          || left.latestSourceHighWaterMark - right.latestSourceHighWaterMark
          || left.dirtyWorkId.localeCompare(right.dirtyWorkId)
        )
      })
      .slice(0, getLimit(statement))
      .map((row) => {
        return {dirtyWorkId: row.dirtyWorkId}
      })
  }
  const deleteDirtyWorkByIds = (statement: string) => {
    const dirtyWorkIds = getInLiterals(statement, 'dirty_work_id')
    const deletable = dirtyWorkIds.flatMap((dirtyWorkId) => {
      const row = dirtyWork.get(dirtyWorkId)

      return row === undefined ? [] : [row]
    })

    deletable.forEach((row) => {
      dirtyWork.delete(row.dirtyWorkId)
    })

    return deletable.map((row) => {
      return {dirtyWorkId: row.dirtyWorkId}
    })
  }
  const getCompactedAckRows = (statement: string) => {
    const strings = getSqlStrings(statement)
    const numbers = getNumbers(statement)
    const keepDirtyAckId = strings[0] ?? ''
    const projectionComponent = strings[1] ?? ''
    const projectionIdentity = strings[2] ?? ''
    const sourcePartition = strings[3] ?? ''
    const completedSourceHighWaterMark = numbers[0] ?? 0

    return [...acks.values()]
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
        return {dirtyAckId: ack.dirtyAckId}
      })
  }
  const deleteAcksByIds = (statement: string) => {
    const dirtyAckIds = getInLiterals(statement, 'dirty_ack_id')
    const deletable = dirtyAckIds.flatMap((dirtyAckId) => {
      const ack = acks.get(dirtyAckId)

      return ack === undefined ? [] : [ack]
    })

    deletable.forEach((ack) => {
      acks.delete(ack.dirtyAckId)
    })

    return deletable.map((ack) => {
      return {dirtyAckId: ack.dirtyAckId}
    })
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_source_change_outbox')) {
      return (options.barrier === undefined || options.barrier === null ? [] : [options.barrier]) as T[]
    }

    if (
      statement.includes('FROM app.review_serving_dirty_work_claim_state state')
      && statement.includes('oldest_claimable AS')
    ) {
      return getClaimStateRows(statement) as T[]
    }

    if (
      statement.includes('FROM app.review_serving_dirty_work_claim_state older')
      && statement.includes('older.dirty_range_start IS NULL')
    ) {
      return getCoalescableClaimStateRows() as T[]
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('RETURNING')
      && statement.includes('first_source_high_water_mark = LEAST')
    ) {
      updateDirtyWork(statement)

      return getTargetDirtyWorkRows(statement).map(getQueryRow) as T[]
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('RETURNING')
      && statement.includes("SET status = 'running'")
    ) {
      return updateDirtyWorkReturningRows(statement, 'running', 'claimable') as T[]
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('RETURNING')
      && statement.includes("SET status = 'pending'")
    ) {
      return updateDirtyWorkReturningRows(statement, 'pending', 'running') as T[]
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('RETURNING')
      && statement.includes("SET status = 'failed'")
    ) {
      return updateDirtyWorkReturningRows(statement, 'failed', 'running') as T[]
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('RETURNING')
      && statement.includes("SET status = 'completed'")
      && statement.includes("lifecycle_reason = 'superseded_by_high_water'")
    ) {
      return updateDirtyWorkReturningRows(statement, 'completed', 'pending') as T[]
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('RETURNING')
      && statement.includes("json_extract_string(projection_key, '$.projectionComponent')")
    ) {
      repairLaneRowsByIds(statement)

      return getTargetDirtyWorkRows(statement).map(getQueryRow) as T[]
    }

    if (statement.includes('WITH retention_ready_dirty_work AS')) {
      return getRetentionReadyLanes(statement) as T[]
    }

    if (
      statement.includes('SELECT rowid AS storageRowId')
      && statement.includes('(projection_component IS NULL OR projection_identity IS NULL)')
    ) {
      return getLaneRepairRows(statement) as T[]
    }

    if (
      statement.includes('SELECT older.dirty_work_id AS dirtyWorkId')
      && statement.includes('superseded_by_high_water') === false
    ) {
      return getCoalescableDirtyWorkRows(statement) as T[]
    }

    if (statement.includes('WITH rebuild_dirty_work_coverage AS')) {
      return getCoverageRows(statement).map(getQueryRow) as T[]
    }

    if (
      statement.includes('SELECT dirty_work.dirty_work_id AS dirtyWorkId')
      && statement.includes('FROM app.review_serving_dirty_work dirty_work')
    ) {
      return getRetentionDirtyWorkRows(statement).map((row) => {
        return {dirtyWorkId: row.dirtyWorkId}
      }) as T[]
    }

    if (
      statement.includes('SELECT dirty_ack_id AS dirtyAckId')
      && statement.includes('FROM app.review_serving_dirty_work_ack')
      && statement.includes('ORDER BY completed_source_high_water_mark ASC')
    ) {
      return getRetentionAckRows(statement).map((ack) => {
        return {dirtyAckId: ack.dirtyAckId}
      }) as T[]
    }

    if (
      statement.includes('SELECT dirty_ack_id AS dirtyAckId')
      && statement.includes('FROM app.review_serving_dirty_work_ack')
      && statement.includes('dirty_ack_id <>')
    ) {
      return getCompactedAckRows(statement) as T[]
    }

    if (
      statement.includes('DELETE FROM app.review_serving_dirty_work_ack')
      && statement.includes('RETURNING dirty_ack_id AS dirtyAckId')
    ) {
      return deleteAcksByIds(statement) as T[]
    }

    if (
      statement.includes('DELETE FROM app.review_serving_dirty_work')
      && statement.includes('RETURNING dirty_work_id AS dirtyWorkId')
    ) {
      return deleteDirtyWorkByIds(statement) as T[]
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

    if (statement.includes("status = 'pending'") && statement.includes('projection_component =')) {
      const projectionComponent = getWhereLiteral(statement, 'projection_component') ?? ''
      const eligibleRows = [...dirtyWork.values()]
        .filter((row) => {
          return (
            (row.status === 'pending' || row.status === 'running') && row.projectionComponent === projectionComponent
          )
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
      const projectionIdentity =
        usesBoundedLane || statement.includes('projection_identity = (') ? eligibleRows[0]?.projectionIdentity : null

      const rows = eligibleRows
        .filter((row) => {
          return (
            (sourcePartition === null || row.sourcePartition === sourcePartition)
            && (projectionIdentity === null || row.projectionIdentity === projectionIdentity)
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

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes('first_source_high_water_mark')
      && !statement.includes('RETURNING')
    ) {
      updateDirtyWork(statement)
    }

    if (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes("json_extract_string(projection_key, '$.projectionComponent')")
    ) {
      repairLaneRowsByIds(statement)
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

    if (statement.includes('INSERT INTO app.review_serving_project_dirty_source_watermark')) {
      upsertDirtySourceWatermarks(statement)
    }

    if (statement.includes("SET status = 'completed'")) {
      updateStatus(statement, 'completed', 'running')

      if (statement.includes('WITH rebuild_dirty_work_coverage AS')) {
        getCoverageRows(statement).forEach((row) => {
          dirtyWork.set(row.dirtyWorkId, {...row, status: 'completed', updatedAt: getClock(statements)})
        })
      } else {
        const rowIds = getInNumbers(statement, 'rowid')
        const dirtyWorkIds = getInLiterals(statement, 'dirty_work_id')
        const matchingRows =
          rowIds.length > 0
            ? [...dirtyWork.values()].filter((row) => {
                return row.storageRowId !== undefined && row.storageRowId !== null && rowIds.includes(row.storageRowId)
              })
            : dirtyWorkIds.flatMap((dirtyWorkId) => {
                const row = dirtyWork.get(dirtyWorkId)

                return row === undefined ? [] : [row]
              })

        matchingRows.forEach((existing) => {
          if (existing.status !== 'completed') {
            const lifecycleReason =
              (statement.match(/lifecycle_reason\s*=\s*'((?:''|[^'])*)'/u)?.[1] as
                | FakeDirtyWorkRow['lifecycleReason']
                | undefined) ?? existing.lifecycleReason

            dirtyWork.set(existing.dirtyWorkId, {
              ...existing,
              lifecycleReason,
              status: 'completed',
              updatedAt: getClock(statements),
            })
          }
        })
      }
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
  expect(dirtyWorkInsert).toContain('INSERT INTO app.review_serving_dirty_work')
  expect(statements.join('\n')).toContain('FROM app.review_serving_dirty_work_id_lookup')
  expect(dirtyWorkInsert).not.toContain('WHERE NOT EXISTS')
  expect(dirtyWorkInsert).not.toContain('existing.dirty_work_id =')
  expect(dirtyWorkInsert).not.toContain('existing.dirty_work_id ||')
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
  expect(claimSelect).toContain('blocker.latest_source_high_water_mark < oldest.latestSourceHighWaterMark')
  expect(claimSelect).toContain('FROM app.review_serving_dirty_work_claim_state blocker')
})

test('claims dirty work from bounded per-row claim state with one exact update returning statement', async () => {
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
  const claimStateSelect = statements.find((statement) => {
    return (
      statement.includes('FROM app.review_serving_dirty_work_claim_state state')
      && statement.includes('oldest_claimable AS')
    )
  })

  expect(claims).toHaveLength(2)
  expect(claimStateSelect).toContain('WITH claim_state_window AS (')
  expect(claimStateSelect).toContain('FROM app.review_serving_dirty_work_claim_state state')
  expect(claimStateSelect).toContain('oldest_claimable AS')
  expect(claimStateSelect).toContain('LIMIT 2048')
  expect(claimStateSelect).not.toContain('FROM app.review_serving_dirty_work ')
  expect(claimStateSelect).not.toContain('projection_key')
  expect(claimStateSelect).not.toContain('json_extract_string')
  expect(claimUpdates).toHaveLength(1)
  expect(claimUpdates[0]).toContain('rowid =')
  expect(claimUpdates[0]).toContain('dirty_work_id =')
  expect(claimUpdates[0]).not.toContain('WITH claim_state_window AS')
  expect(claimUpdates[0]).not.toContain('SELECT dirty_work_id')
  expect(claimUpdates[0]).not.toContain('projection_key =')
  expect(claimUpdates[0]).not.toContain('json_extract_string')
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
      return (
        statement.includes('FROM app.review_serving_dirty_work_claim_state state')
        && statement.includes("state.status IN ('running', 'failed')")
      )
    })
    .at(-1)

  expect(claims).toHaveLength(1)
  expect(claimSelect).toContain("state.status IN ('running', 'failed')")
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

test('completion release and failure terminal updates target exact dirty work rows', async () => {
  const {database, statements} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(2, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')
  await upsertDisplayWork(database, {...getBaseScope(3, '3', '3'), scopeId: 'project-1:article-3'}, 'delta-3')
  const claims = await claimReviewServingDirtyWork({limit: 3, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaims(claims.slice(0, 1), database)
  await releaseReviewServingDirtyWorkClaims(
    claims.slice(1, 2).map((claim) => {
      return claim.dirtyWorkId
    }),
    database,
  )
  await failReviewServingDirtyWorkClaims(
    claims.slice(2, 3).map((claim) => {
      return claim.dirtyWorkId
    }),
    database,
  )

  const completionUpdate = statements.findLast((statement) => {
    return (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes("SET status = 'completed'")
      && !statement.includes('WITH rebuild_dirty_work_coverage AS')
    )
  })
  const releaseUpdate = statements.findLast((statement) => {
    return statement.includes('UPDATE app.review_serving_dirty_work') && statement.includes("SET status = 'pending'")
  })
  const failUpdate = statements.findLast((statement) => {
    return statement.includes('UPDATE app.review_serving_dirty_work') && statement.includes("SET status = 'failed'")
  })
  const terminalPredicates = [completionUpdate, releaseUpdate, failUpdate]
    .map((statement) => {
      return statement?.split('RETURNING')[0] ?? ''
    })
    .join('\n')

  expect(completionUpdate).toContain('rowid IN (')
  expect(completionUpdate).toContain('OR dirty_work_id IN (')
  expect(releaseUpdate).toContain('WHERE dirty_work_id IN (')
  expect(failUpdate).toContain('WHERE dirty_work_id IN (')
  expect(terminalPredicates).not.toContain('projection_key =')
  expect(terminalPredicates).not.toContain('source_partition =')
  expect(terminalPredicates).not.toContain('project_id =')
  expect(terminalPredicates).not.toContain('latest_source_high_water_mark <=')
})

test('completion advances dirty source watermarks by project and source partition without dropping acknowledgements', async () => {
  const {acks, database, dirtySourceWatermarks, statements} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(5, '1', '1'), 'delta-1')
  await upsertDisplayWork(database, {...getBaseScope(9, '2', '2'), scopeId: 'project-1:article-2'}, 'delta-2')
  const claims = await claimReviewServingDirtyWork({limit: 2, projectionComponent: 'display'}, database)

  await completeReviewServingDirtyWorkClaims(claims, database)

  const aggregateUpdate = statements.find((statement) => {
    return statement.includes('UPDATE app.review_serving_project_dirty_source_watermark')
  })
  const aggregateInsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_serving_project_dirty_source_watermark')
  })

  expect(acks.size).toBe(2)
  expect(dirtySourceWatermarks.get('project-1:article:display')).toMatchObject({
    projectId: 'project-1',
    sourceHighWaterMark: 9,
    sourcePartition: 'article:display',
  })
  expect(aggregateUpdate).toContain('GROUP BY project_id, source_partition')
  expect(aggregateUpdate).toContain('source_high_water_mark = GREATEST')
  expect(aggregateInsert).toContain('WHERE NOT EXISTS')
  expect(aggregateInsert).not.toContain('ON CONFLICT(project_id, source_partition) DO UPDATE SET')
  expect(aggregateInsert).not.toContain('DELETE FROM app.review_serving_dirty_work_ack')
})

test('component acknowledgements do not scan ack history before dirty work coalescing', async () => {
  const {acks, database, dirtyWork} = createFakeDirtyWorkDatabase()

  await upsertDisplayWork(database, getBaseScope(5), 'delta-1')
  const firstClaims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(firstClaims, database)

  const result = await upsertDisplayWork(database, getBaseScope(5), 'delta-1-replayed')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)

  expect(result.skipped).toBe(false)
  expect(acks.size).toBe(1)
  expect(dirtyWork.size).toBe(1)
  expect(claims).toHaveLength(1)
})

test('rebuild coverage completion only acknowledges matching project component identity partition and watermark', async () => {
  const {acks, database, dirtySourceWatermarks, dirtyWork, statements} = createFakeDirtyWorkDatabase()

  const covered = await upsertDisplayWork(
    database,
    {...getBaseScope(5, '5', '5'), sourcePartition: 'reviewChange:project-1'},
    'delta-covered',
  )
  const newer = await upsertDisplayWork(
    database,
    {...getBaseScope(9, '9', '9'), scopeId: 'project-1:article-newer', sourcePartition: 'reviewChange:project-1'},
    'delta-newer',
  )
  const otherSource = await upsertDisplayWork(
    database,
    {...getBaseScope(4, '4', '4'), scopeId: 'project-1:article-source', sourcePartition: 'projectScope:project-1'},
    'delta-source',
  )
  const otherProject = await upsertReviewServingDirtyWork(
    {
      latestDeltaId: 'delta-project',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
      scope: {
        ...getBaseScope(4, '4', '4'),
        projectId: 'project-2',
        scopeId: 'project-2:article-project',
        sourcePartition: 'reviewChange:project-1',
      },
    },
    database,
  )
  const otherIdentity = await upsertReviewServingDirtyWork(
    {
      latestDeltaId: 'delta-identity',
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-2',
      scope: {
        ...getBaseScope(4, '4', '4'),
        scopeId: 'project-1:article-identity',
        sourcePartition: 'reviewChange:project-1',
      },
    },
    database,
  )

  const result = await completeReviewServingDirtyWorkCoveredByRebuild(
    [
      {
        completedSourceHighWaterMark: 5,
        projectId: 'project-1',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        sourcePartition: 'reviewChange:project-1',
      },
    ],
    database,
  )

  expect(result.completedCount).toBe(1)
  expect((await getReviewServingDirtyWork(covered.dirtyWorkId, database))?.status).toBe('completed')
  expect((await getReviewServingDirtyWork(newer.dirtyWorkId, database))?.status).toBe('pending')
  expect((await getReviewServingDirtyWork(otherSource.dirtyWorkId, database))?.status).toBe('pending')
  expect((await getReviewServingDirtyWork(otherProject.dirtyWorkId, database))?.status).toBe('pending')
  expect((await getReviewServingDirtyWork(otherIdentity.dirtyWorkId, database))?.status).toBe('pending')
  expect(acks.size).toBe(1)
  expect(dirtySourceWatermarks.get('project-1:reviewChange:project-1')).toMatchObject({
    projectId: 'project-1',
    sourceHighWaterMark: 5,
    sourcePartition: 'reviewChange:project-1',
  })
  expect(dirtyWork.size).toBe(5)
  expect(statements.join('\n')).toContain('WITH rebuild_dirty_work_coverage AS')
  expect(statements.join('\n')).toContain('FROM app.review_serving_dirty_work_claim_state claim_state')
  expect(statements.join('\n')).toContain('LIMIT 2048')
  expect(statements.join('\n')).toContain('latest_source_high_water_mark <= coverage.completed_source_high_water_mark')
  const coverageCompletionUpdate = statements.findLast((statement) => {
    return (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && !statement.includes('UPDATE app.review_serving_dirty_work_claim_state')
    )
  })
  expect(coverageCompletionUpdate).toContain('rowid IN (')
  expect(coverageCompletionUpdate).toContain('OR dirty_work_id IN (')
  expect(coverageCompletionUpdate).not.toContain('WITH rebuild_dirty_work_coverage AS')
  expect(coverageCompletionUpdate).not.toContain(
    'latest_source_high_water_mark <= coverage.completed_source_high_water_mark',
  )
})

test('rebuild coverage completion matches promotion source watermark aliases', async () => {
  const {database, dirtyWork, statements} = createFakeDirtyWorkDatabase()

  const reviewChange = await upsertDisplayWork(
    database,
    {...getBaseScope(5, '5', '5'), sourcePartition: 'reviewChange:project-1'},
    'delta-review-change',
  )
  const humanJudgment = await upsertDisplayWork(
    database,
    {...getBaseScope(4, '4', '4'), scopeId: 'project-1:article-human', sourcePartition: 'humanJudgment:project-1:a'},
    'delta-human',
  )
  const projectScope = await upsertDisplayWork(
    database,
    {...getBaseScope(7, '7', '7'), scopeId: 'project-1:article-scope', sourcePartition: 'projectScope:project-1'},
    'delta-project-scope',
  )
  const newerReviewChange = await upsertDisplayWork(
    database,
    {...getBaseScope(9, '9', '9'), scopeId: 'project-1:article-newer', sourcePartition: 'reviewChange:project-1'},
    'delta-newer',
  )

  const result = await completeReviewServingDirtyWorkCoveredByRebuild(
    [
      {
        completedSourceHighWaterMark: 5,
        projectId: 'project-1',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        sourcePartition: 'reviewChange',
      },
      {
        completedSourceHighWaterMark: 7,
        projectId: 'project-1',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        sourcePartition: 'projectScope',
      },
    ],
    database,
  )

  expect(result.completedCount).toBe(3)
  expect((await getReviewServingDirtyWork(reviewChange.dirtyWorkId, database))?.status).toBe('completed')
  expect((await getReviewServingDirtyWork(humanJudgment.dirtyWorkId, database))?.status).toBe('completed')
  expect((await getReviewServingDirtyWork(projectScope.dirtyWorkId, database))?.status).toBe('completed')
  expect((await getReviewServingDirtyWork(newerReviewChange.dirtyWorkId, database))?.status).toBe('pending')
  expect(dirtyWork.size).toBe(4)
  expect(statements.join('\n')).toContain("WHEN 'humanJudgment' THEN 'reviewChange'")
  expect(statements.join('\n')).toContain("WHEN 'project-scope' THEN 'projectScope'")
})

test('rebuild coverage completion records exact high-water acks before dirty work is re-intaken', async () => {
  const {acks, database, dirtySourceWatermarks, dirtyWork, statements} = createFakeDirtyWorkDatabase()

  const result = await completeReviewServingDirtyWorkCoveredByRebuild(
    [
      {
        completedSourceHighWaterMark: 5,
        projectId: 'project-1',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        sourcePartition: 'reviewChange:project-1',
      },
      {
        completedSourceHighWaterMark: 5,
        projectId: 'project-2',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        sourcePartition: 'reviewChange:project-2',
      },
      {
        completedSourceHighWaterMark: 999,
        projectId: 'project-1',
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
        sourcePartition: 'reviewChange',
      },
    ],
    database,
  )

  const skipped = await upsertDisplayWork(
    database,
    {...getBaseScope(5, '5', '5'), sourcePartition: 'reviewChange:project-1'},
    'delta-covered-late',
  )
  const notSkipped = await upsertDisplayWork(
    database,
    {...getBaseScope(6, '6', '6'), scopeId: 'project-1:article-newer', sourcePartition: 'reviewChange:project-1'},
    'delta-newer-late',
  )

  expect(result.completedCount).toBe(0)
  expect(skipped.skipped).toBe(false)
  expect(notSkipped.skipped).toBe(false)
  expect(acks.size).toBe(2)
  expect(
    [...acks.values()]
      .map((ack) => {
        return ack.sourcePartition
      })
      .sort(),
  ).toEqual(['reviewChange:project-1', 'reviewChange:project-2'])
  expect(dirtyWork.size).toBe(2)
  expect(dirtySourceWatermarks.get('project-1:reviewChange:project-1')).toMatchObject({
    projectId: 'project-1',
    sourceHighWaterMark: 5,
    sourcePartition: 'reviewChange:project-1',
  })
  expect(
    statements.filter((statement) => {
      return statement.includes('INSERT INTO app.review_serving_dirty_work_ack') && statement.includes('NULL')
    }),
  ).toHaveLength(1)
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
  expect(compactedAckInsert).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(statements.join('\n')).toContain('FROM app.review_serving_dirty_work_ack_id_lookup')
  expect(compactedAckInsert).not.toContain('WHERE NOT EXISTS')
  expect(compactedAckInsert).not.toContain('existing.dirty_ack_id = incoming.dirty_ack_id')
  expect(compactedAckInsert).not.toContain('DO UPDATE SET')

  const compactedAckDelete = statements.findLast((statement) => {
    return statement.includes('DELETE FROM app.review_serving_dirty_work_ack')
  })

  expect(compactedAckDelete).toContain('WHERE dirty_ack_id IN (')
  expect(compactedAckDelete).not.toContain('projection_component =')
  expect(compactedAckDelete).not.toContain('projection_identity =')
  expect(compactedAckDelete).not.toContain('source_partition =')
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
  expect(compactedAckInserts.join('\n')).toContain('INSERT INTO app.review_serving_dirty_work_ack')
  expect(statements.join('\n')).toContain('FROM app.review_serving_dirty_work_ack_id_lookup')
  expect(compactedAckInserts.join('\n')).not.toContain('WHERE NOT EXISTS')
  expect(compactedAckInserts.join('\n')).not.toContain('existing.dirty_ack_id = incoming.dirty_ack_id')
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

test('default retention cleanup avoids broad retention compaction and delete scans', async () => {
  const {database, statements} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  const claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)

  const result = await cleanupReviewServingDirtyWorkRetention({}, database)
  const cleanupStatements = statements.slice(
    statements.findLastIndex((statement) => {
      return (
        statement.includes('UPDATE app.review_serving_dirty_work')
        && statement.includes("SET status = 'completed', lifecycle_reason = 'projected'")
      )
    }) + 1,
  )

  expect(result).toMatchObject({compactedLaneCount: 0, deletedAcknowledgementCount: 0, deletedDirtyWorkCount: 0})
  expect(cleanupStatements.join('\n')).not.toContain('WITH retention_ready_dirty_work AS')
  expect(cleanupStatements.join('\n')).not.toContain('DELETE FROM app.review_serving_dirty_work')
  expect(cleanupStatements.join('\n')).not.toContain('DELETE FROM app.review_serving_dirty_work_ack')
})

test('retention cleanup repairs compact lane columns before dirty work drain', async () => {
  const {database, dirtyWork, statements} = createFakeDirtyWorkDatabase({barrier: null})

  const created = await upsertDisplayWork(database, getBaseScope(1, '1', '1'), 'delta-1')
  const existing = dirtyWork.get(created.dirtyWorkId)

  if (existing !== undefined) {
    dirtyWork.set(created.dirtyWorkId, {...existing, projectionComponent: null, projectionIdentity: null})
  }

  const result = await cleanupReviewServingDirtyWorkRetention(
    {coalesceDirtyWorkLimit: 0, dirtyWorkDeleteLimit: 0, laneCompactionLimit: 0, laneRepairLimit: 10},
    database,
  )
  const repaired = dirtyWork.get(created.dirtyWorkId)
  const repairUpdate = statements.findLast((statement) => {
    return (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes("json_extract_string(projection_key, '$.projectionComponent')")
    )
  })

  expect(result.repairedLaneColumnCount).toBe(1)
  expect(repaired).toMatchObject({projectionComponent: 'display', projectionIdentity: 'display:identity-1'})
  expect(repairUpdate).toContain('WHERE rowid IN (')
  expect(repairUpdate).not.toContain('dirty_work_id IN')
})

test('retention cleanup coalesces superseded high-water dirty work by exact selected ids', async () => {
  const {database, dirtyWork, statements} = createFakeDirtyWorkDatabase({barrier: null})
  const oldHighWater = await upsertDisplayWork(
    database,
    {...getBaseScope(3, null, null), dirtyRangeEnd: null, dirtyRangeStart: null},
    'delta-3',
  )

  await upsertDisplayWork(
    database,
    {...getBaseScope(9, null, null), dirtyRangeEnd: null, dirtyRangeStart: null, scopeId: 'project-1:high-water-2'},
    'delta-9',
  )
  ;[...dirtyWork.values()].forEach((row) => {
    dirtyWork.set(row.dirtyWorkId, {...row, dirtyRangeEnd: null, dirtyRangeStart: null})
  })

  const result = await cleanupReviewServingDirtyWorkRetention(
    {coalesceDirtyWorkLimit: 10, dirtyWorkDeleteLimit: 0, laneCompactionLimit: 0, laneRepairLimit: 0},
    database,
  )
  const coalesced = dirtyWork.get(oldHighWater.dirtyWorkId)
  const coalesceUpdate = statements.findLast((statement) => {
    return (
      statement.includes('UPDATE app.review_serving_dirty_work')
      && statement.includes("lifecycle_reason = 'superseded_by_high_water'")
    )
  })
  const coalesceSelect = statements.findLast((statement) => {
    return statement.includes('FROM app.review_serving_dirty_work_claim_state older')
  })

  expect(result.coalescedDirtyWorkCount).toBe(1)
  expect(coalesced).toMatchObject({lifecycleReason: 'superseded_by_high_water', status: 'completed'})
  expect(coalesceSelect).toContain('older.dirty_range_start IS NULL')
  expect(coalesceSelect).toContain('FROM app.review_serving_dirty_work_claim_state older')
  expect(coalesceSelect).not.toContain('FROM app.review_serving_dirty_work dirty_work')
  expect(coalesceUpdate).toContain('rowid =')
  expect(coalesceUpdate).toContain('dirty_work_id =')
  expect(coalesceUpdate).not.toContain('EXISTS (')
  expect(coalesceUpdate).not.toContain('projection_component =')
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

test('retention cleanup deletes exact selected dirty work and acknowledgement ids only', async () => {
  const {database, statements} = createFakeDirtyWorkDatabase({barrier: null})

  await upsertDisplayWork(database, getBaseScope(3, '3', '3'), 'delta-3')
  let claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)
  await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )

  await upsertDisplayWork(database, getBaseScope(5, '5', '5'), 'delta-5')
  claims = await claimReviewServingDirtyWork({limit: 1, projectionComponent: 'display'}, database)
  await completeReviewServingDirtyWorkClaims(claims, database)
  await cleanupReviewServingDirtyWorkRetention(
    {acknowledgementDeleteLimit: 10, dirtyWorkDeleteLimit: 10, laneCompactionLimit: 10},
    database,
  )

  const dirtyWorkDelete = statements.findLast((statement) => {
    return (
      statement.includes('DELETE FROM app.review_serving_dirty_work')
      && !statement.includes('DELETE FROM app.review_serving_dirty_work_ack')
    )
  })
  const ackDelete = statements.findLast((statement) => {
    return statement.includes('DELETE FROM app.review_serving_dirty_work_ack')
  })
  const terminalDeletes = [dirtyWorkDelete, ackDelete].join('\n')

  expect(dirtyWorkDelete).toContain('WHERE dirty_work_id IN (')
  expect(ackDelete).toContain('WHERE dirty_ack_id IN (')
  expect(terminalDeletes).not.toContain('SELECT dirty_work.dirty_work_id')
  expect(terminalDeletes).not.toContain('SELECT dirty_ack_id')
  expect(terminalDeletes).not.toContain('projection_component =')
  expect(terminalDeletes).not.toContain('projection_identity =')
  expect(terminalDeletes).not.toContain('source_partition =')
  expect(terminalDeletes).not.toContain('json_extract_string')
  expect(terminalDeletes).not.toContain('latest_source_high_water_mark <=')
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
