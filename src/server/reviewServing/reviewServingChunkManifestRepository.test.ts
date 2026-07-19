import {expect, test} from 'bun:test'

import {
  claimReviewServingRebuildChunk,
  getNextClaimableReviewServingRebuildChunk,
  getReviewServingRebuildChunkId,
  getReviewServingRebuildChunkWorkloadClass,
  getReviewServingRebuildTimingDiagnostics,
  heartbeatReviewServingRebuildChunkLease,
  isReviewServingRebuildChunkComplete,
  markReviewServingRebuildChunkFailed,
  releaseInactiveRequestRebuildChunkManifests,
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingChunkManifestRepositoryTransaction,
  type ReviewServingRebuildChunkIdentity,
  type ReviewServingRebuildChunkManifest,
  upsertReviewServingRebuildChunkManifests,
  writeReviewServingRebuildChunkOutput,
} from './reviewServingChunkManifestRepository.ts'

type FakeChunkRow = ReviewServingRebuildChunkManifest

const baseChunkIdentity = {
  chunkEndKey: 'article:099',
  chunkStartKey: 'article:001',
  inputDigest: 'digest-v1',
  inputWatermark: 42,
  outputBaseGeneration: 7,
  projectId: 'project-1',
  projectionComponent: 'summary',
  projectionIdentity: 'summary:llm:definition-v1',
} satisfies ReviewServingRebuildChunkIdentity

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

const getAssignmentLiteral = (statement: string, columnName: string) => {
  return (
    statement
      .match(new RegExp(`(?<![A-Za-z0-9_])${columnName}\\s*=\\s*'((?:''|[^'])*)'`, 'u'))?.[1]
      ?.replaceAll("''", "'") ?? null
  )
}

const hasChunkIdLiteralPredicate = (statement: string) => {
  return statement.match(/chunk_id\s*=\s*'/u) !== null
}

const getChunkIdLiteral = (statement: string) => {
  return (
    getWhereLiteral(statement, 'chunk_id')
    ?? statement.match(/manifest\.chunk_id\s*=\s*'((?:''|[^'])*)'/u)?.[1]?.replaceAll("''", "'")
    ?? getSqlStrings(statement).find((value) => {
      return value.startsWith('chunk:')
    })
    ?? ''
  )
}

const getClock = (statements: readonly string[]) => {
  return new Date(2026, 5, 16, 14, statements.length).toISOString()
}

const getPromiseRejection = async (promise: Promise<unknown>) => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const shouldPreserveChunkStateOnUpsert = (row: FakeChunkRow | undefined) => {
  return row === undefined ? false : ['completed', 'failed', 'running'].includes(row.status)
}

const getFakeLeasePriority = (row: FakeChunkRow) => {
  return row.status === 'running' ? 0 : 1
}

const getFakeRequestPriority = (row: FakeChunkRow) => {
  return row.requestId?.includes('stalled-foreground') === true
    ? 10_000
    : row.requestId?.includes('foreground') === true
      ? 1_000
      : 100
}

const getFakeRequestUpdatedAt = (row: FakeChunkRow) => {
  if (row.requestId?.includes('freshly-requested') === true) {
    return '2026-06-16T14:20:00.000Z'
  }

  if (row.requestId?.includes('stale-requested') === true) {
    return '2026-06-16T14:00:00.000Z'
  }

  return row.requestId?.includes('stalled-foreground') === true ? '2026-06-16T14:05:00.000Z' : row.updatedAt
}

const fakeCriticalComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'summary',
  'payload',
] as const satisfies readonly FakeChunkRow['projectionComponent'][]

const fakeComponentPrerequisites = {
  display: ['projectScope', 'selectedImport'],
  humanStatus: ['projectScope', 'display'],
  judgmentInputContent: ['projectScope'],
  llmStatus: ['projectScope', 'display', 'judgmentInputContent'],
  payload: ['projectScope', 'display'],
  posting: ['projectScope', 'selectedImport', 'display', 'llmStatus', 'humanStatus'],
  projectScope: [],
  queue: ['projectScope', 'selectedImport', 'llmStatus', 'humanStatus'],
  search: ['projectScope', 'selectedImport'],
  selectedImport: ['projectScope'],
  summary: ['projectScope', 'selectedImport', 'llmStatus', 'humanStatus', 'queue'],
} as const satisfies Record<FakeChunkRow['projectionComponent'], readonly FakeChunkRow['projectionComponent'][]>

const getFakeClaimLane = (row: FakeChunkRow) => {
  return fakeCriticalComponents.some((component) => {
    return component === row.projectionComponent
  })
    ? 0
    : 1
}

const getFakeClaimPriority = (row: FakeChunkRow) => {
  const componentOrder = [
    'projectScope',
    'selectedImport',
    'display',
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
    'queue',
    'summary',
    'payload',
    'search',
    'posting',
  ]

  return componentOrder.indexOf(row.projectionComponent)
}

const isFakeChunkReady = (row: FakeChunkRow, rows: Iterable<FakeChunkRow>) => {
  const prerequisites = fakeComponentPrerequisites[row.projectionComponent]

  return prerequisites.every((component) => {
    return [...rows].every((candidate) => {
      return (
        candidate.requestId !== row.requestId
        || candidate.projectId !== row.projectId
        || candidate.projectionComponent !== component
        || candidate.status === 'completed'
      )
    })
  })
}

const getChunkRowFromIdentity = (
  input: ReviewServingRebuildChunkIdentity,
  statements: readonly string[],
): FakeChunkRow => {
  return {
    ...input,
    actualInputRows: null,
    actualOutputBytes: null,
    actualOutputRows: null,
    actualPayloadBytes: null,
    actualPromptCount: null,
    actualTempBytes: null,
    admissionState: 'admitted',
    budgetJson: {},
    checksum: null,
    chunkId: getReviewServingRebuildChunkId(input),
    completedAt: null,
    createdAt: getClock(statements),
    diagnosticsJson: {},
    durationMs: null,
    estimatedInputRows: null,
    estimatedOutputBytes: null,
    estimatedOutputRows: null,
    estimatedPayloadBytes: null,
    estimatedPromptCount: null,
    estimatedTempBytes: null,
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    maxInputRows: null,
    maxOutputBytes: null,
    maxOutputRows: null,
    maxPayloadBytes: null,
    maxPromptCount: null,
    maxTempBytes: null,
    oomCategory: null,
    overBudgetReason: null,
    parentChunkId: null,
    requestId: input.requestId ?? null,
    retryAfter: null,
    retryCount: 0,
    snapshotCount: 1,
    snapshotId: null,
    splitDepth: 0,
    startedAt: null,
    status: 'pending',
    updatedAt: getClock(statements),
    workloadClass: null,
  }
}

const createFakeChunkManifestDatabase = (initialRows: readonly FakeChunkRow[] = []) => {
  const rows = new Map<string, FakeChunkRow>()
  const claimedRows = new Map<string, FakeChunkRow>()
  const statements: string[] = []
  const outputWrites: string[] = []

  initialRows.map((row) => {
    rows.set(row.chunkId, row)
    return row
  })

  const upsertChunk = (statement: string) => {
    const strings = getSqlStrings(statement)
    const chunkId = strings[0] ?? ''
    const existing = rows.get(chunkId)
    const preserveState = shouldPreserveChunkStateOnUpsert(existing)
    const row = {
      actualInputRows: preserveState ? (existing?.actualInputRows ?? null) : null,
      actualOutputBytes: preserveState ? (existing?.actualOutputBytes ?? null) : null,
      actualOutputRows: preserveState ? (existing?.actualOutputRows ?? null) : null,
      actualPayloadBytes: preserveState ? (existing?.actualPayloadBytes ?? null) : null,
      actualPromptCount: preserveState ? (existing?.actualPromptCount ?? null) : null,
      actualTempBytes: preserveState ? (existing?.actualTempBytes ?? null) : null,
      admissionState: preserveState
        ? existing?.admissionState
        : strings[7] === 'blocked_over_budget'
          ? 'blocked_over_budget'
          : 'admitted',
      budgetJson: existing?.budgetJson ?? {},
      checksum: preserveState ? (existing?.checksum ?? null) : (strings[9] ?? null),
      chunkEndKey: strings[6] ?? '',
      chunkId,
      chunkStartKey: strings[5] ?? '',
      completedAt: preserveState ? (existing?.completedAt ?? null) : null,
      createdAt: existing?.createdAt ?? getClock(statements),
      diagnosticsJson: existing?.diagnosticsJson ?? {},
      durationMs: preserveState ? (existing?.durationMs ?? null) : null,
      estimatedInputRows: existing?.estimatedInputRows ?? null,
      estimatedOutputBytes: existing?.estimatedOutputBytes ?? null,
      estimatedOutputRows: existing?.estimatedOutputRows ?? null,
      estimatedPayloadBytes: existing?.estimatedPayloadBytes ?? null,
      estimatedPromptCount: existing?.estimatedPromptCount ?? null,
      estimatedTempBytes: existing?.estimatedTempBytes ?? null,
      inputDigest: strings[4] ?? null,
      inputWatermark: Number(statement.match(/input_watermark[\s\S]*?,\s*(\d+),\s*'[^']*',/u)?.[1] ?? 0),
      lastError: preserveState ? (existing?.lastError ?? null) : null,
      leaseExpiresAt: preserveState ? (existing?.leaseExpiresAt ?? null) : null,
      leaseOwner: preserveState ? (existing?.leaseOwner ?? null) : null,
      maxInputRows: existing?.maxInputRows ?? null,
      maxOutputBytes: existing?.maxOutputBytes ?? null,
      maxOutputRows: existing?.maxOutputRows ?? null,
      maxPayloadBytes: existing?.maxPayloadBytes ?? null,
      maxPromptCount: existing?.maxPromptCount ?? null,
      maxTempBytes: existing?.maxTempBytes ?? null,
      oomCategory: existing?.oomCategory ?? null,
      outputBaseGeneration: Number(statement.match(/output_base_generation[\s\S]*?'[^']*',\s*(\d+),/u)?.[1] ?? 0),
      overBudgetReason: existing?.overBudgetReason ?? null,
      parentChunkId: existing?.parentChunkId ?? null,
      projectId: strings[1] ?? null,
      projectionComponent: (strings[2] ?? 'display') as FakeChunkRow['projectionComponent'],
      projectionIdentity: strings[3] ?? '',
      requestId: preserveState ? (existing?.requestId ?? null) : (strings[8] ?? null),
      retryAfter: preserveState ? (existing?.retryAfter ?? null) : null,
      retryCount: preserveState ? (existing?.retryCount ?? 0) : 0,
      snapshotCount: existing?.snapshotCount ?? 1,
      snapshotId: existing?.snapshotId ?? null,
      splitDepth: existing?.splitDepth ?? 0,
      startedAt: preserveState ? (existing?.startedAt ?? null) : null,
      status: (preserveState ? (existing?.status ?? 'pending') : (strings[7] ?? 'pending')) as FakeChunkRow['status'],
      updatedAt: getClock(statements),
      workloadClass: existing?.workloadClass ?? null,
    }

    rows.set(chunkId, row)
  }
  const claimChunk = (statement: string) => {
    const chunkId = getChunkIdLiteral(statement)
    const existing = rows.get(chunkId)
    const strings = getSqlStrings(statement)
    const leaseOwner = getAssignmentLiteral(statement, 'lease_owner') ?? strings[1] ?? ''
    const leaseExpiresAt =
      statement.match(/lease_expires_at\s*=\s*TIMESTAMPTZ\s*'((?:''|[^'])*)'/u)?.[1] ?? strings[2] ?? null
    const canClaim =
      existing?.admissionState === 'admitted'
      && (existing.status === 'pending' || existing.status === 'failed' || existing.status === 'running')

    if (existing !== undefined && canClaim) {
      const claimed = {
        ...existing,
        lastError: null,
        leaseExpiresAt,
        leaseOwner,
        startedAt: existing.startedAt ?? getClock(statements),
        status: 'running',
        updatedAt: getClock(statements),
      } satisfies FakeChunkRow

      rows.set(chunkId, claimed)
      claimedRows.set(chunkId, claimed)
    }
  }
  const failChunk = (statement: string) => {
    const chunkId = getChunkIdLiteral(statement)
    const existing = rows.get(chunkId)
    const retryAfter = statement.match(/retry_after\s*=\s*TIMESTAMPTZ\s*'((?:''|[^'])*)'/u)?.[1] ?? null
    const retryCount = Number(statement.match(/retry_count\s*=\s*(\d+)/u)?.[1] ?? existing?.retryCount ?? 0)
    const status = (getAssignmentLiteral(statement, 'status') ?? 'failed') as FakeChunkRow['status']

    if (existing !== undefined && existing.status !== 'completed') {
      claimedRows.delete(chunkId)
      rows.set(chunkId, {
        ...existing,
        admissionState: status === 'blocked_over_budget' ? 'blocked_over_budget' : existing.admissionState,
        lastError: getAssignmentLiteral(statement, 'last_error'),
        leaseExpiresAt: null,
        leaseOwner: null,
        retryAfter,
        retryCount,
        status,
        updatedAt: getClock(statements),
      })
    }
  }
  const heartbeatChunk = (statement: string) => {
    const chunkId = getChunkIdLiteral(statement)
    const existing = rows.get(chunkId)
    const leaseOwner = getWhereLiteral(statement, 'lease_owner')
    const leaseExpiresAt = statement.match(/lease_expires_at\s*=\s*TIMESTAMPTZ\s*'((?:''|[^'])*)'/u)?.[1] ?? null

    if (existing?.status === 'running' && existing.leaseOwner === leaseOwner) {
      const heartbeated = {...existing, leaseExpiresAt, updatedAt: getClock(statements)} satisfies FakeChunkRow

      rows.set(chunkId, heartbeated)
      claimedRows.set(chunkId, heartbeated)
    }
  }
  const completeChunk = (statement: string) => {
    const chunkId = getChunkIdLiteral(statement)
    const existing = rows.get(chunkId)

    if (existing?.status === 'running') {
      claimedRows.delete(chunkId)
      rows.set(chunkId, {
        ...existing,
        checksum: getSqlStrings(statement)[1] ?? null,
        completedAt: getClock(statements),
        lastError: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: 'completed',
        updatedAt: getClock(statements),
      })
    }
  }
  const releaseInactiveRequestChunks = (statement: string) => {
    const scopedChunkIds = statement.includes('chunk_id IN') ? new Set(getSqlStrings(statement)) : null

    rows.forEach((existing, chunkId) => {
      if (
        (scopedChunkIds === null || scopedChunkIds.has(chunkId))
        && existing.requestId === 'rebuild:missing'
        && ['pending', 'completed', 'running', 'failed', 'blocked_over_budget', 'quarantined'].includes(existing.status)
      ) {
        rows.set(chunkId, {
          ...existing,
          actualInputRows: null,
          actualOutputBytes: null,
          actualOutputRows: null,
          actualPayloadBytes: null,
          actualPromptCount: null,
          actualTempBytes: null,
          admissionState: 'admitted',
          budgetJson: {},
          checksum: null,
          completedAt: null,
          diagnosticsJson: {},
          durationMs: null,
          lastError: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          oomCategory: null,
          overBudgetReason: null,
          requestId: null,
          retryAfter: null,
          retryCount: 0,
          startedAt: null,
          status: 'pending',
          updatedAt: getClock(statements),
        })
      }
    })
  }
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')) {
      upsertChunk(statement)
    }

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && statement.includes('request_id = NULL')
      && statement.includes('NOT EXISTS')
    ) {
      releaseInactiveRequestChunks(statement)
    }

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && (statement.includes("SET\n        status = 'running'")
        || statement.includes("SET\r\n        status = 'running'")
        || statement.includes("SET\n      status = 'running'")
        || statement.includes("SET\r\n      status = 'running'"))
    ) {
      claimChunk(statement)
    }

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && statement.includes('lease_expires_at =')
      && statement.includes("AND status = 'running'")
      && statement.includes('AND lease_owner =')
    ) {
      heartbeatChunk(statement)
    }

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && statement.includes('last_error =')
      && statement.match(/retry_count\s*=\s*\d+/u) !== null
      && !statement.includes('NOT EXISTS')
    ) {
      failChunk(statement)
    }

    if (
      statement.includes("SET\n        status = 'completed'")
      || statement.includes("SET\r\n        status = 'completed'")
    ) {
      completeChunk(statement)
    }

    if (
      statement.includes('INSERT INTO mart.fake_chunk_output')
      || statement.includes('DELETE FROM mart.fake_chunk_output')
    ) {
      outputWrites.push(statement)
    }
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && statement.includes('RETURNING')
      && (statement.includes("SET\n      status = 'running'") || statement.includes("SET\r\n      status = 'running'"))
    ) {
      claimChunk(statement)

      const chunkId = getChunkIdLiteral(statement)
      const row = claimedRows.get(chunkId) ?? rows.get(chunkId)
      return (row === undefined ? [] : [row]) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && hasChunkIdLiteralPredicate(statement)) {
      const chunkId = getChunkIdLiteral(statement)
      const row = claimedRows.get(chunkId) ?? rows.get(chunkId)
      return (row === undefined ? [] : [row]) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      if (statement.includes('FROM app.review_rebuild_chunk_manifest AS candidate')) {
        const [claimable] = [...rows.values()]
          .filter((row) => {
            return (
              row.admissionState === 'admitted'
              && (row.status === 'pending' || row.status === 'failed' || row.status === 'running')
              && isFakeChunkReady(row, rows.values())
            )
          })
          .toSorted((left, right) => {
            return (
              getFakeRequestPriority(right) - getFakeRequestPriority(left)
              || (getFakeRequestPriority(left) >= 10_000 && getFakeRequestPriority(right) >= 10_000
                ? getFakeRequestUpdatedAt(right).localeCompare(getFakeRequestUpdatedAt(left))
                : 0)
              || (getFakeRequestPriority(left) >= 10_000 && getFakeRequestPriority(right) >= 10_000
                ? left.updatedAt.localeCompare(right.updatedAt)
                : 0)
              || getFakeClaimLane(left) - getFakeClaimLane(right)
              || getFakeClaimPriority(left) - getFakeClaimPriority(right)
              || getFakeLeasePriority(left) - getFakeLeasePriority(right)
              || left.updatedAt.localeCompare(right.updatedAt)
              || left.inputWatermark - right.inputWatermark
              || left.chunkStartKey.localeCompare(right.chunkStartKey)
              || left.chunkId.localeCompare(right.chunkId)
            )
          })

        return (claimable === undefined ? [] : [claimable]) as T[]
      }

      const chunkId = getReviewServingRebuildChunkId(baseChunkIdentity)
      const row = rows.get(chunkId)
      const complete =
        row?.status === 'completed' && statement.includes(`input_digest IS NOT DISTINCT FROM '${row.inputDigest}'`)
      return (complete ? [{chunkId}] : []) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_request')) {
      return [{retryPolicyJson: {maxAttempts: 2, retryAfterMs: 120_000, terminalState: 'blocked_over_budget'}}] as T[]
    }

    return [] as T[]
  }
  const database = {
    queryJson,
    run,
    transaction: async <T>(operation: (tx: {queryJson: typeof queryJson; run: typeof run}) => Promise<T>) => {
      const rowSnapshot = new Map(rows)
      const claimedRowSnapshot = new Map(claimedRows)
      const outputWriteSnapshot = [...outputWrites]

      try {
        return await operation({queryJson, run})
      } catch (error) {
        rows.clear()
        rowSnapshot.forEach((row, chunkId) => {
          rows.set(chunkId, row)
        })
        claimedRows.clear()
        claimedRowSnapshot.forEach((row, chunkId) => {
          claimedRows.set(chunkId, row)
        })
        outputWrites.splice(0, outputWrites.length, ...outputWriteSnapshot)

        throw error
      }
    },
  } satisfies ReviewServingChunkManifestRepositoryDatabase

  return {database, outputWrites, rows, statements}
}

test('null-request chunk ids preserve legacy identity hashes', () => {
  expect(getReviewServingRebuildChunkId({...baseChunkIdentity, requestId: null})).toBe(
    getReviewServingRebuildChunkId(baseChunkIdentity),
  )
  expect(getReviewServingRebuildChunkId({...baseChunkIdentity, requestId: 'rebuild:new'})).not.toBe(
    getReviewServingRebuildChunkId(baseChunkIdentity),
  )
})

test('rebuild chunk workload classes mark durable critical and bulk lanes', async () => {
  const {database, statements} = createFakeChunkManifestDatabase([])

  await upsertReviewServingRebuildChunkManifests(
    [
      {...baseChunkIdentity, projectionComponent: 'summary', projectionIdentity: 'summary:project-1'},
      {...baseChunkIdentity, projectionComponent: 'posting', projectionIdentity: 'posting:project-1'},
    ],
    database,
  )
  const joined = statements.join('\n')

  expect(getReviewServingRebuildChunkWorkloadClass('summary')).toBe('critical')
  expect(getReviewServingRebuildChunkWorkloadClass('posting')).toBe('bulk')
  expect(joined).toContain("'critical'")
  expect(joined).toContain("'bulk'")
  expect(joined).toContain('workload_class')
})

test('completed chunks resume after restart and are skipped for the same maintained input digest', async () => {
  const completed = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    checksum: 'checksum-v1',
    completedAt: '2026-06-16T14:00:00.000Z',
    status: 'completed' as const,
  }
  const {database, statements} = createFakeChunkManifestDatabase([completed])

  await upsertReviewServingRebuildChunkManifests([baseChunkIdentity], database)

  const isComplete = await isReviewServingRebuildChunkComplete(
    {...baseChunkIdentity, checksum: 'checksum-v1'},
    database,
  )
  const claimed = await claimReviewServingRebuildChunk(
    {
      ...baseChunkIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-1',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )

  expect(isComplete).toBe(true)
  expect(claimed).toBeNull()
  expect(
    statements.some((statement) => {
      return statement.includes('input_digest IS NOT DISTINCT FROM')
    }),
  ).toBe(true)
  expect(
    statements.some((statement) => {
      return statement.includes('FROM mart.') || statement.includes('FROM app.review_change_delta')
    }),
  ).toBe(false)
})

test('idempotent rebuild chunk upserts preserve active retry and lease state', async () => {
  const running = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    lastError: 'still writing',
    leaseExpiresAt: '2026-06-16T14:10:00.000Z',
    leaseOwner: 'worker-active',
    startedAt: '2026-06-16T14:00:00.000Z',
    status: 'running' as const,
  }
  const failed = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-failed'}, []),
    lastError: 'cooling down',
    retryAfter: '2026-06-16T14:15:00.000Z',
    retryCount: 1,
    status: 'failed' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([running, failed])

  await upsertReviewServingRebuildChunkManifests(
    [
      {...baseChunkIdentity, status: 'pending'},
      {...baseChunkIdentity, inputDigest: 'digest-failed', status: 'pending'},
    ],
    database,
  )
  const joined = statements.join('\n')

  expect(rows.get(running.chunkId)).toMatchObject({
    lastError: 'still writing',
    leaseOwner: 'worker-active',
    status: 'running',
  })
  expect(rows.get(failed.chunkId)).toMatchObject({
    lastError: 'cooling down',
    retryAfter: '2026-06-16T14:15:00.000Z',
    retryCount: 1,
    status: 'failed',
  })
  expect(joined).toContain("status IN ('completed', 'running', 'failed')")
})

test('rebuild chunk upserts serialize manifest writes on one DuckDB connection', async () => {
  let inFlightInsertCount = 0
  let maxInFlightInsertCount = 0
  const insertOrder: string[] = []
  const transactionContext: ReviewServingChunkManifestRepositoryTransaction = {
    queryJson: async <T>() => {
      return [] as T[]
    },
    run: async (statement: string) => {
      if (!statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')) {
        return
      }

      if (inFlightInsertCount > 0) {
        throw new Error('concurrent manifest insert on one connection')
      }

      inFlightInsertCount += 1
      maxInFlightInsertCount = Math.max(maxInFlightInsertCount, inFlightInsertCount)
      insertOrder.push(getSqlStrings(statement)[0] ?? '')
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
      inFlightInsertCount -= 1
    },
  }
  const database: ReviewServingChunkManifestRepositoryDatabase = {
    ...transactionContext,
    transaction: async <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => {
      return operation(transactionContext)
    },
  }

  await upsertReviewServingRebuildChunkManifests(
    [
      {...baseChunkIdentity, inputDigest: 'digest-sequential-a'},
      {...baseChunkIdentity, inputDigest: 'digest-sequential-b'},
    ],
    database,
  )

  expect(maxInFlightInsertCount).toBe(1)
  expect(insertOrder).toEqual([
    getReviewServingRebuildChunkId({...baseChunkIdentity, inputDigest: 'digest-sequential-a'}),
    getReviewServingRebuildChunkId({...baseChunkIdentity, inputDigest: 'digest-sequential-b'}),
  ])
})

test('rebuild chunk upserts replace terminal chunks so fresh V4 plans can repair obsolete budget blocks', async () => {
  const blocked = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    admissionState: 'blocked_over_budget' as const,
    lastError: 'old planner over budget',
    oomCategory: 'request_over_budget',
    overBudgetReason: 'input rows: estimated 480025 > max 250000',
    retryCount: 3,
    status: 'blocked_over_budget' as const,
  }
  const quarantined = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-quarantined'}, []),
    lastError: 'old quarantine',
    retryCount: 3,
    status: 'quarantined' as const,
  }
  const {database, rows} = createFakeChunkManifestDatabase([blocked, quarantined])

  await upsertReviewServingRebuildChunkManifests(
    [
      {...baseChunkIdentity, status: 'pending'},
      {...baseChunkIdentity, inputDigest: 'digest-quarantined', status: 'pending'},
    ],
    database,
  )

  expect(rows.get(blocked.chunkId)).toMatchObject({
    admissionState: 'admitted',
    lastError: null,
    retryCount: 0,
    status: 'pending',
  })
  expect(rows.get(quarantined.chunkId)).toMatchObject({lastError: null, retryCount: 0, status: 'pending'})
})

test('rebuild chunk upserts clear stale execution metadata when re-admitting inactive terminal chunks', async () => {
  const blocked = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    actualInputRows: 10,
    actualOutputRows: 20,
    completedAt: '2026-06-16T14:30:00.000Z',
    durationMs: 60_000,
    lastError: 'old DuckDB OOM',
    retryCount: 3,
    startedAt: '2026-06-16T14:00:00.000Z',
    status: 'quarantined' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([blocked])

  await upsertReviewServingRebuildChunkManifests([{...baseChunkIdentity, status: 'pending'}], database)

  expect(rows.get(blocked.chunkId)).toMatchObject({
    actualInputRows: null,
    actualOutputRows: null,
    completedAt: null,
    durationMs: null,
    lastError: null,
    retryCount: 0,
    startedAt: null,
    status: 'pending',
  })
  expect(statements.join('\n')).toContain('completed_at = CASE')
})

test('next claimable chunk discovery returns maintained identity and checksum', async () => {
  const pending = getChunkRowFromIdentity(baseChunkIdentity, [])
  const {database, statements} = createFakeChunkManifestDatabase([pending])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:00:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toEqual({...baseChunkIdentity, checksum: null, chunkId: pending.chunkId, requestId: null})
  expect(statements.join('\n')).toContain("candidate.status = 'pending'")
  expect(statements.join('\n')).toContain("candidate.status = 'failed'")
  expect(statements.join('\n')).toContain("request.status IN ('admitted', 'running')")
  expect(statements.join('\n')).toContain('request.request_id = candidate.request_id')
  expect(statements.join('\n')).toContain("candidate.projection_component = 'selectedImport'")
  expect(statements.join('\n')).toContain("candidate.projection_component = 'summary'")
  expect(statements.join('\n')).toContain('FROM app.review_rebuild_chunk_manifest prerequisite')
  expect(statements.join('\n')).toContain('prerequisite.request_id IS NOT DISTINCT FROM candidate.request_id')
  expect(statements.join('\n')).toContain("prerequisite.projection_component IN ('projectScope')")
  expect(statements.join('\n')).toMatch(
    /candidate\.projection_component = 'search'[\s\S]*prerequisite\.projection_component IN \('projectScope', 'selectedImport'\)/,
  )
  expect(statements.join('\n')).toContain(
    "prerequisite.projection_component IN ('projectScope', 'selectedImport', 'llmStatus', 'humanStatus', 'queue')",
  )
  expect(statements.join('\n')).toContain("prerequisite.status <> 'completed'")
  expect(statements.join('\n')).not.toContain("prerequisite.status IN ('failed', 'blocked_over_budget', 'quarantined')")
  expect(statements.join('\n')).not.toContain('prerequisite.updated_at < candidate.updated_at')
  expect(statements.join('\n')).toContain("project_id IS NOT DISTINCT FROM 'project-1'")
  expect(statements.join('\n')).toContain("candidate.status = 'running'")
  expect(statements.join('\n')).toContain('candidate.lease_expires_at IS NULL')
  expect(statements.join('\n')).toContain('candidate.lease_expires_at <=')
  expect(statements.join('\n')).toContain('ORDER BY')
  expect(statements.join('\n')).toContain("WHEN candidate.status = 'running'")
  expect(statements.join('\n')).toContain('SELECT MAX(request.priority)')
  expect(statements.join('\n')).toContain('SELECT MAX(request.updated_at)')
  expect(statements.join('\n')).toContain('candidate.updated_at ASC')
  expect(statements.join('\n')).toMatch(
    /SELECT MAX\(request\.priority\)[\s\S]*\) DESC NULLS LAST,[\s\S]*SELECT MAX\(request\.updated_at\)[\s\S]*candidate\.updated_at[\s\S]*candidate\.projection_component IN \('projectScope', 'selectedImport', 'display'[\s\S]*CASE candidate\.projection_component/,
  )
  expect(statements.join('\n')).toContain('CASE candidate.projection_component')
})

test('next claimable chunk discovery does not favor newer pending requests over older pending work', async () => {
  const olderPending = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-older-pending'}, []),
    requestId: 'rebuild:older',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const newerPending = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-newer-pending'}, []),
    requestId: 'rebuild:newer',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database, statements} = createFakeChunkManifestDatabase([newerPending, olderPending])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-older-pending', requestId: 'rebuild:older'})
  expect(statements.join('\n')).toMatch(
    /candidate\.projection_component IN \('projectScope', 'selectedImport', 'display'[\s\S]*CASE candidate\.projection_component[\s\S]*SELECT MAX\(request\.updated_at\)[\s\S]*candidate\.updated_at ASC/,
  )
})

test('next claimable chunk discovery preserves component priority before chunk age', async () => {
  const oldSearch = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-old-search', projectionComponent: 'search'},
      [],
    ),
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const newProjectScope = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-new-project-scope', projectionComponent: 'projectScope'},
      [],
    ),
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([oldSearch, newProjectScope])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-new-project-scope', projectionComponent: 'projectScope'})
})

test('next claimable chunk discovery gates requestless bootstrap chunks with null-safe prerequisites', async () => {
  const oldSelectedImport = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-requestless-selected-import', projectionComponent: 'selectedImport'},
      [],
    ),
    requestId: null,
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const newProjectScope = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-requestless-project-scope', projectionComponent: 'projectScope'},
      [],
    ),
    requestId: null,
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database, statements} = createFakeChunkManifestDatabase([oldSelectedImport, newProjectScope])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-requestless-project-scope', projectionComponent: 'projectScope'})
  expect(statements.join('\n')).toContain('prerequisite.request_id IS NOT DISTINCT FROM candidate.request_id')
})

test('next claimable chunk discovery allows independent critical components before unrelated bulk work finishes', async () => {
  const completedProjectScope = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-project-scope', projectionComponent: 'projectScope'},
      [],
    ),
    requestId: 'rebuild:foreground',
    status: 'completed' as const,
  }
  const completedSelectedImport = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-selected-import', projectionComponent: 'selectedImport'},
      [],
    ),
    requestId: 'rebuild:foreground',
    status: 'completed' as const,
  }
  const display = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-display', projectionComponent: 'display'},
      [],
    ),
    requestId: 'rebuild:foreground',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const oldSearch = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-old-search', projectionComponent: 'search'},
      [],
    ),
    requestId: 'rebuild:foreground',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const oldPosting = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-old-posting', projectionComponent: 'posting'},
      [],
    ),
    requestId: 'rebuild:foreground',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([
    completedProjectScope,
    completedSelectedImport,
    oldSearch,
    oldPosting,
    display,
  ])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-display', projectionComponent: 'display'})
})

test('next claimable chunk discovery lets posting run before unrelated queue search and payload chunks complete', async () => {
  const completedComponents = [
    'projectScope',
    'selectedImport',
    'display',
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
  ] as const
  const completed = completedComponents.map((projectionComponent) => {
    return {
      ...getChunkRowFromIdentity(
        {...baseChunkIdentity, inputDigest: `digest-${projectionComponent}`, projectionComponent},
        [],
      ),
      requestId: 'rebuild:foreground',
      status: 'completed' as const,
    }
  })
  const pendingQueue = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-queue', projectionComponent: 'queue'}, []),
    requestId: 'rebuild:other',
  }
  const pendingSearch = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-search', projectionComponent: 'search'}, []),
    requestId: 'rebuild:other',
  }
  const pendingPayload = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-payload', projectionComponent: 'payload'},
      [],
    ),
    requestId: 'rebuild:other',
  }
  const posting = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-posting', projectionComponent: 'posting'},
      [],
    ),
    requestId: 'rebuild:foreground',
  }
  const {database} = createFakeChunkManifestDatabase([
    ...completed,
    pendingQueue,
    pendingSearch,
    pendingPayload,
    posting,
  ])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-posting', projectionComponent: 'posting'})
})

test('next claimable chunk discovery prioritizes summary before posting once queue is ready', async () => {
  const completedComponents = [
    'projectScope',
    'selectedImport',
    'display',
    'judgmentInputContent',
    'llmStatus',
    'humanStatus',
    'queue',
  ] as const
  const completed = completedComponents.map((projectionComponent) => {
    return {
      ...getChunkRowFromIdentity(
        {...baseChunkIdentity, inputDigest: `digest-${projectionComponent}`, projectionComponent},
        [],
      ),
      requestId: 'rebuild:foreground',
      status: 'completed' as const,
    }
  })
  const oldPosting = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-old-posting', projectionComponent: 'posting'},
      [],
    ),
    requestId: 'rebuild:foreground',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const summary = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-summary', projectionComponent: 'summary'},
      [],
    ),
    requestId: 'rebuild:foreground',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([...completed, oldPosting, summary])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-summary', projectionComponent: 'summary'})
})

test('next claimable chunk discovery applies request priority before component order', async () => {
  const normalProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-normal-project-scope',
        projectId: 'project-2',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:normal',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const foregroundProjectScope = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-foreground-project-scope', projectionComponent: 'projectScope'},
      [],
    ),
    requestId: 'rebuild:foreground',
    status: 'completed' as const,
  }
  const foregroundSelectedImport = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-foreground-selected-import', projectionComponent: 'selectedImport'},
      [],
    ),
    requestId: 'rebuild:foreground',
    status: 'completed' as const,
  }
  const foregroundDisplay = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-foreground-display', projectionComponent: 'display'},
      [],
    ),
    requestId: 'rebuild:foreground',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([
    normalProjectScope,
    foregroundProjectScope,
    foregroundSelectedImport,
    foregroundDisplay,
  ])

  const next = await getNextClaimableReviewServingRebuildChunk({now: '2026-06-16T14:05:00.000Z'}, database)

  expect(next).toMatchObject({inputDigest: 'digest-foreground-display', projectionComponent: 'display'})
})

test('next claimable chunk discovery keeps foreground fairness ahead of route touch order', async () => {
  const oldProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-old-project-scope',
        projectId: 'project-old',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:foreground-old',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const freshProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-fresh-project-scope',
        projectId: 'project-fresh',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:fresh-foreground',
    status: 'completed' as const,
  }
  const freshSelectedImport = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-fresh-selected-import',
        projectId: 'project-fresh',
        projectionComponent: 'selectedImport',
      },
      [],
    ),
    requestId: 'rebuild:fresh-foreground',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([oldProjectScope, freshProjectScope, freshSelectedImport])

  const next = await getNextClaimableReviewServingRebuildChunk({now: '2026-06-16T14:15:00.000Z'}, database)

  expect(next).toMatchObject({inputDigest: 'digest-old-project-scope', projectionComponent: 'projectScope'})
})

test('next claimable chunk discovery lets stalled foreground age break same-priority component ties', async () => {
  const oldProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-old-project-scope',
        projectId: 'project-old',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-old',
    status: 'completed' as const,
  }
  const oldSelectedImport = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-old-selected-import',
        projectId: 'project-old',
        projectionComponent: 'selectedImport',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-old',
    status: 'completed' as const,
  }
  const oldSearch = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-old-search', projectId: 'project-old', projectionComponent: 'search'},
      [],
    ),
    requestId: 'rebuild:stalled-foreground-old',
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const freshProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-fresh-project-scope',
        projectId: 'project-fresh',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-fresh',
    status: 'completed' as const,
  }
  const freshJudgmentInput = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-fresh-judgment-input',
        projectId: 'project-fresh',
        projectionComponent: 'judgmentInputContent',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-fresh',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database, statements} = createFakeChunkManifestDatabase([
    oldProjectScope,
    oldSelectedImport,
    oldSearch,
    freshProjectScope,
    freshJudgmentInput,
  ])

  const next = await getNextClaimableReviewServingRebuildChunk({now: '2026-06-16T14:15:00.000Z'}, database)

  expect(next).toMatchObject({inputDigest: 'digest-old-search', projectionComponent: 'search'})
  expect(statements.join('\n')).toMatch(
    /request\.priority[\s\S]*request\.updated_at[\s\S]*candidate\.updated_at[\s\S]*candidate\.projection_component/,
  )
})

test('next claimable chunk discovery lets freshly requested stalled foreground work preempt stale stalled foreground work', async () => {
  const staleProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-stale-project-scope',
        projectId: 'project-stale',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-stale-requested',
    status: 'completed' as const,
  }
  const staleSearch = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-stale-search',
        projectId: 'project-stale',
        projectionComponent: 'search',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-stale-requested',
    updatedAt: '2026-06-16T13:45:00.000Z',
  }
  const freshProjectScope = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-fresh-project-scope',
        projectId: 'project-fresh',
        projectionComponent: 'projectScope',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-freshly-requested',
    status: 'completed' as const,
  }
  const freshJudgmentInput = {
    ...getChunkRowFromIdentity(
      {
        ...baseChunkIdentity,
        inputDigest: 'digest-fresh-judgment-input',
        projectId: 'project-fresh',
        projectionComponent: 'judgmentInputContent',
      },
      [],
    ),
    requestId: 'rebuild:stalled-foreground-freshly-requested',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([
    staleProjectScope,
    staleSearch,
    freshProjectScope,
    freshJudgmentInput,
  ])

  const next = await getNextClaimableReviewServingRebuildChunk({now: '2026-06-16T14:15:00.000Z'}, database)

  expect(next).toMatchObject({
    inputDigest: 'digest-fresh-judgment-input',
    projectionComponent: 'judgmentInputContent',
    requestId: 'rebuild:stalled-foreground-freshly-requested',
  })
})

test('next claimable chunk discovery preserves component order before expired lease priority', async () => {
  const expiredSearch = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-expired-search', projectionComponent: 'search'},
      [],
    ),
    leaseExpiresAt: '2026-06-16T13:59:00.000Z',
    leaseOwner: 'worker-stale',
    status: 'running' as const,
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const pendingProjectScope = {
    ...getChunkRowFromIdentity(
      {...baseChunkIdentity, inputDigest: 'digest-pending-project-scope', projectionComponent: 'projectScope'},
      [],
    ),
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([expiredSearch, pendingProjectScope])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-pending-project-scope', projectionComponent: 'projectScope'})
})

test('next claimable chunk discovery reclaims expired running leases before newer pending requests', async () => {
  const pending = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-newer-pending'}, []),
    requestId: 'rebuild:newer',
    updatedAt: '2026-06-16T14:10:00.000Z',
  }
  const expiredRunning = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-expired-running'}, []),
    leaseExpiresAt: '2026-06-16T13:59:00.000Z',
    leaseOwner: 'worker-stale',
    requestId: 'rebuild:older',
    status: 'running' as const,
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const {database} = createFakeChunkManifestDatabase([pending, expiredRunning])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-expired-running', requestId: 'rebuild:older'})
})

test('next claimable chunk discovery releases chunks for missing rebuild requests', async () => {
  const orphanedExpiredRunning = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-orphaned-running'}, []),
    leaseExpiresAt: '2026-06-16T13:59:00.000Z',
    leaseOwner: 'worker-gone',
    requestId: 'rebuild:missing',
    status: 'running' as const,
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([orphanedExpiredRunning])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-orphaned-running', requestId: null})
  expect(rows.get(orphanedExpiredRunning.chunkId)).toMatchObject({
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    requestId: null,
    retryCount: 0,
    status: 'pending',
  })
  expect(statements.join('\n')).toContain('NOT EXISTS')
  expect(statements.join('\n')).toContain('FROM app.review_rebuild_request request')
})

test('inactive request release detaches pending chunks with missing rebuild requests', async () => {
  const orphanedPending = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-orphaned-pending'}, []),
    requestId: 'rebuild:missing',
    status: 'pending' as const,
    updatedAt: '2026-06-16T14:00:00.000Z',
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([orphanedPending])

  await releaseInactiveRequestRebuildChunkManifests(database)

  expect(rows.get(orphanedPending.chunkId)).toMatchObject({requestId: null, retryCount: 0, status: 'pending'})
  expect(statements.join('\n')).toContain("'pending'")
  expect(statements.join('\n')).toContain('NOT EXISTS')
})

test('claim discovery only releases chunks whose rebuild request row is missing', async () => {
  const missingRequest = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-missing-request'}, []),
    requestId: 'rebuild:missing',
    status: 'pending' as const,
  }
  const inactiveButPresentRequest = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-inactive-request'}, []),
    lastError: 'request completed with retained diagnostics',
    requestId: 'rebuild:completed',
    retryCount: 2,
    status: 'failed' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([missingRequest, inactiveButPresentRequest])

  await releaseInactiveRequestRebuildChunkManifests(database)

  expect(rows.get(missingRequest.chunkId)).toMatchObject({requestId: null, retryCount: 0, status: 'pending'})
  expect(rows.get(inactiveButPresentRequest.chunkId)).toMatchObject({
    lastError: 'request completed with retained diagnostics',
    requestId: 'rebuild:completed',
    retryCount: 2,
    status: 'failed',
  })
  const releaseStatement = statements.find((statement) => {
    return statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('request_id = NULL')
  })

  expect(releaseStatement).toBeDefined()
  expect(releaseStatement).not.toContain("request.status IN ('admitted', 'running')")
})

test('claim discovery preserves finalized chunks for inactive but present rebuild requests', async () => {
  const completed = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-completed-request'}, []),
    completedAt: '2026-06-16T14:00:00.000Z',
    lastError: 'completed request retained diagnostics',
    requestId: 'rebuild:completed',
    status: 'completed' as const,
  }
  const quarantined = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-quarantined-request'}, []),
    admissionState: 'blocked_over_budget' as const,
    lastError: 'quarantined request retained diagnostics',
    overBudgetReason: 'manual quarantine',
    requestId: 'rebuild:quarantined',
    retryCount: 3,
    status: 'quarantined' as const,
  }
  const claimable = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, inputDigest: 'digest-claimable'}, []),
    requestId: null,
    status: 'pending' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([completed, quarantined, claimable])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:05:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toMatchObject({inputDigest: 'digest-claimable', requestId: null})
  expect(rows.get(completed.chunkId)).toMatchObject({
    completedAt: '2026-06-16T14:00:00.000Z',
    lastError: 'completed request retained diagnostics',
    requestId: 'rebuild:completed',
    status: 'completed',
  })
  expect(rows.get(quarantined.chunkId)).toMatchObject({
    admissionState: 'blocked_over_budget',
    lastError: 'quarantined request retained diagnostics',
    overBudgetReason: 'manual quarantine',
    requestId: 'rebuild:quarantined',
    retryCount: 3,
    status: 'quarantined',
  })
  const releaseStatement = statements.find((statement) => {
    return statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('request_id = NULL')
  })

  expect(releaseStatement).toBeDefined()
  expect(releaseStatement).not.toContain("request.status IN ('admitted', 'running')")
})

test('over-budget chunks are parked before claim and cannot hot-loop', async () => {
  const blocked = {
    ...getChunkRowFromIdentity({...baseChunkIdentity, requestId: 'rebuild:blocked'}, []),
    admissionState: 'blocked_over_budget' as const,
    oomCategory: 'request_over_budget',
    overBudgetReason: 'input rows: estimated 99 > max 10',
    retryAfter: '2026-06-16T14:10:00.000Z',
    status: 'blocked_over_budget' as const,
  }
  const {database, statements} = createFakeChunkManifestDatabase([blocked])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:00:00.000Z', projectId: 'project-1'},
    database,
  )
  const claimed = await claimReviewServingRebuildChunk(
    {
      ...baseChunkIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-blocked',
      now: '2026-06-16T14:00:00.000Z',
      requestId: 'rebuild:blocked',
    },
    database,
  )

  expect(next).toBeNull()
  expect(claimed).toBeNull()
  expect(statements.join('\n')).toContain("admission_state = 'admitted'")
  expect(statements.join('\n')).toContain('retry_after')
})

test('failed chunks can be claimed again and completed transactionally with output validation', async () => {
  const failed = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    lastError: 'previous worker crashed',
    status: 'failed' as const,
  }
  const {database, outputWrites, rows} = createFakeChunkManifestDatabase([failed])

  const claimed = await claimReviewServingRebuildChunk(
    {
      ...baseChunkIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-2',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )
  const completed = await writeReviewServingRebuildChunkOutput(
    {
      ...baseChunkIdentity,
      leaseOwner: 'worker-2',
      validateOutput: async () => {
        return {actualChecksum: 'checksum-v2', actualCount: 25, expectedChecksum: 'checksum-v2', expectedCount: 25}
      },
      writeOutput: async (tx) => {
        await tx.run('INSERT INTO mart.fake_chunk_output VALUES (25)')
      },
    },
    database,
  )

  expect(claimed).toMatchObject({leaseOwner: 'worker-2', status: 'running'})
  expect(outputWrites).toHaveLength(1)
  expect(completed).toMatchObject({checksum: 'checksum-v2', status: 'completed'})
  expect(rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))?.lastError).toBeNull()
})

test('completed rebuild chunks persist write and validation timing diagnostics', async () => {
  const running = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    leaseExpiresAt: '2026-06-16T14:05:00.000Z',
    leaseOwner: 'worker-timing',
    status: 'running' as const,
  }
  const {database, statements} = createFakeChunkManifestDatabase([running])

  const completed = await writeReviewServingRebuildChunkOutput(
    {
      ...baseChunkIdentity,
      diagnosticsJson: {source: 'test'},
      leaseOwner: 'worker-timing',
      validateOutput: async () => {
        return {
          actualChecksum: 'checksum-timing',
          actualCount: 25,
          diagnosticsJson: {validationMode: 'cheap-count'},
          expectedChecksum: 'checksum-timing',
          expectedCount: 25,
        }
      },
      writeOutput: async (tx) => {
        await tx.run('INSERT INTO mart.fake_chunk_output VALUES (25)')
        return {
          diagnosticsJson: {phaseTimings: {sourceQueryMs: 7, writerMs: 11}, writer: {records: {inputRecordCount: 25}}},
        }
      },
    },
    database,
  )
  const joined = statements.join('\n')

  expect(completed).toMatchObject({checksum: 'checksum-timing', status: 'completed'})
  expect(joined).toContain('"source":"test"')
  expect(joined).toContain('"validationMode":"cheap-count"')
  expect(joined).toContain('"sourceQueryMs":7')
  expect(joined).toContain('"writerMs":11')
  expect(joined).toContain('"inputRecordCount":25')
  expect(joined).toContain('"phaseTimings"')
  expect(joined).toContain('"writeOutputMs"')
  expect(joined).toContain('"validationMs"')
  expect(joined).toContain('"totalBeforeCompletionMs"')
})

test('completed rebuild chunks can reuse writer validation results without rescanning output', async () => {
  const running = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    leaseExpiresAt: '2026-06-16T14:05:00.000Z',
    leaseOwner: 'worker-reused-validation',
    status: 'running' as const,
  }
  const {database, statements} = createFakeChunkManifestDatabase([running])
  let validationScans = 0

  const completed = await writeReviewServingRebuildChunkOutput(
    {
      ...baseChunkIdentity,
      leaseOwner: 'worker-reused-validation',
      validateOutput: async () => {
        validationScans += 1

        return {actualChecksum: 'rescanned-checksum', actualCount: 99, expectedChecksum: 'rescanned-checksum'}
      },
      writeOutput: async (tx) => {
        await tx.run('INSERT INTO mart.fake_chunk_output VALUES (25)')

        return {
          validationResult: {
            actualChecksum: 'reused-checksum',
            actualCount: 25,
            diagnosticsJson: {validationMode: 'reused-source-posting-checksum'},
            expectedChecksum: 'reused-checksum',
            expectedCount: 25,
          },
        }
      },
    },
    database,
  )
  const joined = statements.join('\n')

  expect(validationScans).toBe(0)
  expect(completed).toMatchObject({checksum: 'reused-checksum', status: 'completed'})
  expect(joined).toContain('"validationMode":"reused-source-posting-checksum"')
})

test('rebuild timing diagnostics summarize phase timings and claimable pending chunks', async () => {
  const statements: string[] = []
  const database: ReviewServingChunkManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('GROUP BY')) {
        return [
          {
            avgDurationMs: 42,
            avgValidationMs: 3,
            avgWriteOutputMs: 30,
            chunkCount: 2,
            completedCount: 1,
            failedCount: 0,
            maxDurationMs: 50,
            maxValidationMs: 4,
            maxWriteOutputMs: 34,
            pendingCount: 1,
            projectId: 'project-1',
            projectionComponent: 'summary',
            requestId: 'rebuild:timing',
            runningCount: 0,
            status: 'completed',
            totalActualOutputRows: 25,
          },
        ] as T[]
      }

      return [
        {
          chunkEndKey: 'article:099',
          chunkId: 'chunk:summary:claimable',
          chunkStartKey: 'article:001',
          durationMs: null,
          estimatedInputRows: 25,
          estimatedOutputRows: 25,
          projectId: 'project-1',
          projectionComponent: 'summary',
          requestId: 'rebuild:timing',
          splitDepth: 1,
          status: 'pending',
          updatedAt: '2026-06-16T14:00:00.000Z',
        },
      ] as T[]
    },
    run: async () => {},
    transaction: async <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => {
      return operation(database)
    },
  }

  const diagnostics = await getReviewServingRebuildTimingDiagnostics(
    {limit: 7, projectId: 'project-1', requestId: 'rebuild:timing'},
    database,
  )

  expect(diagnostics.filters).toEqual({limit: 7, projectId: 'project-1', requestId: 'rebuild:timing'})
  expect(diagnostics.phaseTimings).toHaveLength(1)
  expect(diagnostics.claimablePendingChunks).toHaveLength(1)
  expect(statements[0]).toContain("chunk.request_id = 'rebuild:timing'")
  expect(statements[0]).toContain("chunk.project_id = 'project-1'")
  expect(statements[0]).toContain("json_extract_string(chunk.diagnostics_json, '$.phaseTimings.writeOutputMs')")
  expect(statements[0]).toContain("json_extract_string(chunk.diagnostics_json, '$.phaseTimings.validationMs')")
  expect(statements[1]).toContain("chunk.admission_state = 'admitted'")
  expect(statements[1]).toContain('prerequisite.request_id IS NOT DISTINCT FROM chunk.request_id')
  expect(statements[1]).toContain('LIMIT 7')
})

test('rebuild chunk heartbeat extends only the current owner lease', async () => {
  const running = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    leaseExpiresAt: '2026-06-16T14:05:00.000Z',
    leaseOwner: 'worker-heartbeat',
    status: 'running' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([running])

  const mismatch = await heartbeatReviewServingRebuildChunkLease(
    {chunkId: running.chunkId, leaseExpiresAt: '2026-06-16T14:20:00.000Z', leaseOwner: 'worker-other'},
    database,
  )
  const extended = await heartbeatReviewServingRebuildChunkLease(
    {chunkId: running.chunkId, leaseExpiresAt: '2026-06-16T14:30:00.000Z', leaseOwner: 'worker-heartbeat'},
    database,
  )

  expect(mismatch).toBeNull()
  expect(extended).toMatchObject({leaseExpiresAt: '2026-06-16T14:30:00.000Z', leaseOwner: 'worker-heartbeat'})
  expect(rows.get(running.chunkId)?.leaseExpiresAt).toBe('2026-06-16T14:30:00.000Z')
  expect(statements.join('\n')).toContain("AND status = 'running'")
  expect(statements.join('\n')).toContain("AND lease_owner = 'worker-heartbeat'")
})

test('validation mismatch marks the claimed chunk failed for retry', async () => {
  const {database, rows} = createFakeChunkManifestDatabase([getChunkRowFromIdentity(baseChunkIdentity, [])])

  await claimReviewServingRebuildChunk(
    {
      ...baseChunkIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-3',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )
  const rejection = await getPromiseRejection(
    writeReviewServingRebuildChunkOutput(
      {
        ...baseChunkIdentity,
        leaseOwner: 'worker-3',
        validateOutput: async () => {
          return {actualChecksum: 'bad-checksum', actualCount: 24, expectedChecksum: 'checksum-v3', expectedCount: 25}
        },
        writeOutput: async () => {},
      },
      database,
    ),
  )

  expect(getErrorMessage(rejection)).toContain('chunk validation failed')
  expect(rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))?.status).toBe('failed')
  expect(rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))?.lastError).toContain('chunk validation failed')
})

test('validation mismatch rolls back chunk output before marking the chunk failed', async () => {
  const {database, outputWrites, rows} = createFakeChunkManifestDatabase([
    getChunkRowFromIdentity(baseChunkIdentity, []),
  ])

  await claimReviewServingRebuildChunk(
    {
      ...baseChunkIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-rollback',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )
  const rejection = await getPromiseRejection(
    writeReviewServingRebuildChunkOutput(
      {
        ...baseChunkIdentity,
        leaseOwner: 'worker-rollback',
        validateOutput: async () => {
          return {actualChecksum: 'bad-checksum', actualCount: 24, expectedChecksum: 'checksum-v3', expectedCount: 25}
        },
        writeOutput: async (tx) => {
          await tx.run('INSERT INTO mart.fake_chunk_output VALUES (24)')
        },
      },
      database,
    ),
  )
  const failedRow = rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))

  expect(getErrorMessage(rejection)).toContain('chunk validation failed')
  expect(outputWrites).toEqual([])
  expect(failedRow?.lastError).toContain('chunk validation failed')
  expect(failedRow?.status).toBe('failed')
})

test('idempotent rebuild output writes outside the completion transaction for safe lease retries', async () => {
  const running = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    leaseExpiresAt: '2026-06-16T14:05:00.000Z',
    leaseOwner: 'worker-idempotent',
    status: 'running' as const,
  }
  const {database, outputWrites, rows} = createFakeChunkManifestDatabase([running])
  const rejection = await getPromiseRejection(
    writeReviewServingRebuildChunkOutput(
      {
        ...baseChunkIdentity,
        leaseOwner: 'worker-idempotent',
        validateOutput: async () => {
          return {actualChecksum: 'bad-checksum', actualCount: 24, expectedChecksum: 'checksum-v3', expectedCount: 25}
        },
        writeMode: 'idempotent-output',
        writeOutput: async (tx) => {
          await tx.run('DELETE FROM mart.fake_chunk_output WHERE article_id BETWEEN 1 AND 25')
          await tx.run('INSERT INTO mart.fake_chunk_output VALUES (24)')
        },
      },
      database,
    ),
  )
  const failedRow = rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))

  expect(getErrorMessage(rejection)).toContain('chunk validation failed')
  expect(outputWrites).toEqual([
    'DELETE FROM mart.fake_chunk_output WHERE article_id BETWEEN 1 AND 25',
    'INSERT INTO mart.fake_chunk_output VALUES (24)',
  ])
  expect(failedRow?.lastError).toContain('chunk validation failed')
  expect(failedRow?.status).toBe('failed')
})

test('idempotent rebuild output can split writes into independent transactions', async () => {
  const running = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    leaseExpiresAt: '2026-06-16T14:05:00.000Z',
    leaseOwner: 'worker-idempotent-batches',
    status: 'running' as const,
  }
  const {database, outputWrites, rows} = createFakeChunkManifestDatabase([running])

  const completed = await writeReviewServingRebuildChunkOutput(
    {
      ...baseChunkIdentity,
      leaseOwner: 'worker-idempotent-batches',
      validateOutput: async () => {
        return {
          actualChecksum: 'checksum-batched',
          actualCount: 2,
          expectedChecksum: 'checksum-batched',
          expectedCount: 2,
        }
      },
      writeMode: 'idempotent-output',
      writeOutput: async (outputDatabase) => {
        if (!('transaction' in outputDatabase)) {
          throw new Error('idempotent output writer did not receive a transaction-capable database')
        }

        await outputDatabase.transaction(async (tx) => {
          await tx.run('DELETE FROM mart.fake_chunk_output WHERE article_id BETWEEN 1 AND 1')
          await tx.run('INSERT INTO mart.fake_chunk_output VALUES (1)')
        })
        await outputDatabase.transaction(async (tx) => {
          await tx.run('DELETE FROM mart.fake_chunk_output WHERE article_id BETWEEN 2 AND 2')
          await tx.run('INSERT INTO mart.fake_chunk_output VALUES (2)')
        })
      },
    },
    database,
  )

  expect(outputWrites).toEqual([
    'DELETE FROM mart.fake_chunk_output WHERE article_id BETWEEN 1 AND 1',
    'INSERT INTO mart.fake_chunk_output VALUES (1)',
    'DELETE FROM mart.fake_chunk_output WHERE article_id BETWEEN 2 AND 2',
    'INSERT INTO mart.fake_chunk_output VALUES (2)',
  ])
  expect(completed).toMatchObject({checksum: 'checksum-batched', status: 'completed'})
  expect(rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))?.status).toBe('completed')
})

test('validation mismatch rejects after exhausting retries to a request terminal state', async () => {
  const retryIdentity = {
    ...baseChunkIdentity,
    requestId: 'rebuild:validation-terminal',
  } satisfies ReviewServingRebuildChunkIdentity
  const running = {
    ...getChunkRowFromIdentity(retryIdentity, []),
    leaseOwner: 'worker-validation-terminal',
    retryCount: 1,
    status: 'running' as const,
  }
  const {database, rows} = createFakeChunkManifestDatabase([running])
  const chunkId = getReviewServingRebuildChunkId(retryIdentity)

  const rejection = await getPromiseRejection(
    writeReviewServingRebuildChunkOutput(
      {
        ...retryIdentity,
        leaseOwner: 'worker-validation-terminal',
        validateOutput: async () => {
          return {actualChecksum: 'bad-checksum', actualCount: 24, expectedChecksum: 'checksum-v3', expectedCount: 25}
        },
        writeOutput: async () => {},
      },
      database,
    ),
  )

  expect(getErrorMessage(rejection)).toContain('chunk validation failed')
  expect(rows.get(chunkId)).toMatchObject({
    admissionState: 'blocked_over_budget',
    leaseOwner: null,
    retryCount: 2,
    status: 'blocked_over_budget',
  })
})

test('failed rebuild chunks record retry backoff and exhaust to the request terminal state', async () => {
  const retryIdentity = {
    ...baseChunkIdentity,
    requestId: 'rebuild:retry-policy',
  } satisfies ReviewServingRebuildChunkIdentity
  const running = {
    ...getChunkRowFromIdentity(retryIdentity, []),
    leaseOwner: 'worker-retry',
    status: 'running' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([running])
  const chunkId = getReviewServingRebuildChunkId(retryIdentity)

  const failed = await markReviewServingRebuildChunkFailed(
    {chunkId, error: 'temporary oom', leaseOwner: 'worker-retry', now: '2026-06-16T14:00:00.000Z'},
    database,
  )
  const exhausted = await markReviewServingRebuildChunkFailed(
    {chunkId, error: 'temporary oom again', now: '2026-06-16T14:02:00.000Z'},
    database,
  )

  expect(failed).toMatchObject({retryAfter: '2026-06-16T14:02:00.000Z', retryCount: 1, status: 'failed'})
  expect(exhausted).toMatchObject({
    admissionState: 'blocked_over_budget',
    retryAfter: null,
    retryCount: 2,
    status: 'blocked_over_budget',
  })
  expect(rows.get(chunkId)?.lastError).toBe('temporary oom again')
  expect(statements.join('\n')).toContain('FROM app.review_rebuild_request')
  expect(statements.join('\n')).toContain('retry_after')
})

test('expired running rebuild chunk leases are reclaimed without retry delay', async () => {
  const retryIdentity = {
    ...baseChunkIdentity,
    requestId: 'rebuild:expired-lease-retry-policy',
  } satisfies ReviewServingRebuildChunkIdentity
  const expired = {
    ...getChunkRowFromIdentity(retryIdentity, []),
    leaseExpiresAt: '2026-06-16T13:59:00.000Z',
    leaseOwner: 'worker-dead',
    status: 'running' as const,
  }
  const {database, rows, statements} = createFakeChunkManifestDatabase([expired])
  const chunkId = getReviewServingRebuildChunkId(retryIdentity)

  const claimed = await claimReviewServingRebuildChunk(
    {
      ...retryIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-retry',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )

  expect(claimed).toMatchObject({leaseOwner: 'worker-retry', retryAfter: null, retryCount: 0, status: 'running'})
  expect(rows.get(chunkId)).toMatchObject({
    lastError: null,
    leaseOwner: 'worker-retry',
    retryAfter: null,
    retryCount: 0,
    status: 'running',
  })
  const claimStatement = statements.find((statement) => {
    return statement.includes('UPDATE app.review_rebuild_chunk_manifest AS manifest')
  })

  expect(claimStatement).toContain("manifest.status = 'running'")
  expect(claimStatement).toContain('manifest.lease_expires_at IS NULL')
  expect(claimStatement).not.toContain('FROM app.review_rebuild_chunk_manifest prerequisite')
})

test('failed rebuild chunk retry claims tolerate duplicate request policy rows', async () => {
  const retryIdentity = {
    ...baseChunkIdentity,
    requestId: 'rebuild:duplicate-policy',
  } satisfies ReviewServingRebuildChunkIdentity
  const failed = {
    ...getChunkRowFromIdentity(retryIdentity, []),
    retryAfter: '2026-06-16T13:59:00.000Z',
    retryCount: 1,
    status: 'failed' as const,
  }
  const {database, statements} = createFakeChunkManifestDatabase([failed])

  await claimReviewServingRebuildChunk(
    {
      ...retryIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-retry',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )

  const claimStatement = statements.find((statement) => {
    return statement.includes('UPDATE app.review_rebuild_chunk_manifest AS manifest')
  })

  expect(claimStatement).toContain('MAX(TRY_CAST(json_extract_string(policy.retry_policy_json')
  expect(claimStatement).not.toContain('WHERE policy.request_id = manifest.request_id\n            LIMIT 1')
})

test('changed maintained input digest creates a different chunk and avoids stale completed skips', async () => {
  const completed = {
    ...getChunkRowFromIdentity(baseChunkIdentity, []),
    checksum: 'checksum-v1',
    completedAt: '2026-06-16T14:00:00.000Z',
    status: 'completed' as const,
  }
  const changedIdentity = {...baseChunkIdentity, inputDigest: 'digest-v2'} satisfies ReviewServingRebuildChunkIdentity
  const {database} = createFakeChunkManifestDatabase([completed])

  await upsertReviewServingRebuildChunkManifests([changedIdentity], database)

  const isComplete = await isReviewServingRebuildChunkComplete(changedIdentity, database)

  expect(isComplete).toBe(false)
  expect(getReviewServingRebuildChunkId(changedIdentity)).not.toBe(getReviewServingRebuildChunkId(baseChunkIdentity))
})
