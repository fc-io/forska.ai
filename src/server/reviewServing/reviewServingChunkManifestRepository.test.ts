import {expect, test} from 'bun:test'

import {
  claimReviewServingRebuildChunk,
  getNextClaimableReviewServingRebuildChunk,
  getReviewServingRebuildChunkId,
  isReviewServingRebuildChunkComplete,
  markReviewServingRebuildChunkFailed,
  type ReviewServingChunkManifestRepositoryDatabase,
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

const shouldPreserveChunkStateOnUpsert = (row: FakeChunkRow | undefined) => {
  return row === undefined
    ? false
    : ['blocked_over_budget', 'completed', 'failed', 'quarantined', 'running'].includes(row.status)
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
      actualInputRows: existing?.actualInputRows ?? null,
      actualOutputBytes: existing?.actualOutputBytes ?? null,
      actualOutputRows: existing?.actualOutputRows ?? null,
      actualPayloadBytes: existing?.actualPayloadBytes ?? null,
      actualPromptCount: existing?.actualPromptCount ?? null,
      actualTempBytes: existing?.actualTempBytes ?? null,
      admissionState: preserveState
        ? existing?.admissionState
        : (existing?.admissionState ?? (strings.includes('blocked_over_budget') ? 'blocked_over_budget' : 'admitted')),
      budgetJson: existing?.budgetJson ?? {},
      checksum: preserveState ? (existing?.checksum ?? null) : (strings[9] ?? null),
      chunkEndKey: strings[6] ?? '',
      chunkId,
      chunkStartKey: strings[5] ?? '',
      completedAt: existing?.completedAt ?? null,
      createdAt: existing?.createdAt ?? getClock(statements),
      diagnosticsJson: existing?.diagnosticsJson ?? {},
      durationMs: existing?.durationMs ?? null,
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
      startedAt: existing?.startedAt ?? null,
      status: (preserveState ? existing.status : (strings[7] ?? 'pending')) as FakeChunkRow['status'],
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
  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')) {
      upsertChunk(statement)
    }

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && statement.match(/status\s*=\s*'running'/u) !== null
    ) {
      claimChunk(statement)
    }

    if (
      statement.includes('UPDATE app.review_rebuild_chunk_manifest')
      && statement.includes('last_error =')
      && statement.match(/retry_count\s*=\s*\d+/u) !== null
    ) {
      failChunk(statement)
    }

    if (
      statement.includes("SET\n        status = 'completed'")
      || statement.includes("SET\r\n        status = 'completed'")
    ) {
      completeChunk(statement)
    }

    if (statement.includes('INSERT INTO mart.fake_chunk_output')) {
      outputWrites.push(statement)
    }
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && hasChunkIdLiteralPredicate(statement)) {
      const chunkId = getChunkIdLiteral(statement)
      const row = claimedRows.get(chunkId) ?? rows.get(chunkId)
      return (row === undefined ? [] : [row]) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      if (statement.includes('claimable_chunk')) {
        const [claimable] = [...rows.values()]
          .filter((row) => {
            return (
              row.admissionState === 'admitted'
              && (row.status === 'pending' || row.status === 'failed' || row.status === 'running')
            )
          })
          .toSorted((left, right) => {
            return (
              left.updatedAt.localeCompare(right.updatedAt)
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
      return operation({queryJson, run})
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
  expect(joined).toContain("status IN ('completed', 'running', 'failed', 'blocked_over_budget', 'quarantined')")
})

test('next claimable chunk discovery returns maintained identity and checksum', async () => {
  const pending = getChunkRowFromIdentity(baseChunkIdentity, [])
  const {database, statements} = createFakeChunkManifestDatabase([pending])

  const next = await getNextClaimableReviewServingRebuildChunk(
    {now: '2026-06-16T14:00:00.000Z', projectId: 'project-1'},
    database,
  )

  expect(next).toEqual({...baseChunkIdentity, checksum: null, requestId: null})
  expect(statements.join('\n')).toContain("candidate.status = 'pending'")
  expect(statements.join('\n')).toContain("candidate.status = 'failed'")
  expect(statements.join('\n')).toContain("request.status IN ('admitted', 'running')")
  expect(statements.join('\n')).toContain('request.request_id = candidate.request_id')
  expect(statements.join('\n')).toContain("project_id IS NOT DISTINCT FROM 'project-1'")
  expect(statements.join('\n')).toContain('MIN(candidate.updated_at)')
  expect(statements.join('\n')).toContain('MIN(candidate.chunk_id)')
  expect(statements.join('\n')).not.toContain('ORDER BY updated_at ASC')
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

test('validation mismatch rolls back output writes and marks the claimed chunk failed for retry', async () => {
  const {database, rows, statements} = createFakeChunkManifestDatabase([getChunkRowFromIdentity(baseChunkIdentity, [])])

  await claimReviewServingRebuildChunk(
    {
      ...baseChunkIdentity,
      leaseExpiresAt: '2026-06-16T14:05:00.000Z',
      leaseOwner: 'worker-3',
      now: '2026-06-16T14:00:00.000Z',
    },
    database,
  )
  const failed = await writeReviewServingRebuildChunkOutput(
    {
      ...baseChunkIdentity,
      leaseOwner: 'worker-3',
      validateOutput: async () => {
        return {actualChecksum: 'bad-checksum', actualCount: 24, expectedChecksum: 'checksum-v3', expectedCount: 25}
      },
      writeOutput: async () => {},
    },
    database,
  )

  expect(failed).toMatchObject({status: 'failed'})
  expect(statements).toContain('SAVEPOINT review_serving_rebuild_chunk_output')
  expect(statements).toContain('ROLLBACK TO SAVEPOINT review_serving_rebuild_chunk_output')
  expect(statements).toContain('RELEASE SAVEPOINT review_serving_rebuild_chunk_output')
  expect(rows.get(getReviewServingRebuildChunkId(baseChunkIdentity))?.lastError).toContain('chunk validation failed')
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
