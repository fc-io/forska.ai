import {expect, test} from 'bun:test'

import {
  claimReviewServingRebuildChunk,
  getNextClaimableReviewServingRebuildChunk,
  getReviewServingRebuildChunkId,
  isReviewServingRebuildChunkComplete,
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

const hasChunkIdLiteralPredicate = (statement: string) => {
  return statement.match(/chunk_id\s*=\s*'/u) !== null
}

const getClock = (statements: readonly string[]) => {
  return new Date(2026, 5, 16, 14, statements.length).toISOString()
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
    const row = {
      actualInputRows: existing?.actualInputRows ?? null,
      actualOutputBytes: existing?.actualOutputBytes ?? null,
      actualOutputRows: existing?.actualOutputRows ?? null,
      actualPayloadBytes: existing?.actualPayloadBytes ?? null,
      actualPromptCount: existing?.actualPromptCount ?? null,
      actualTempBytes: existing?.actualTempBytes ?? null,
      admissionState: (existing?.admissionState
        ?? (strings.includes('blocked_over_budget')
          ? 'blocked_over_budget'
          : 'admitted')) as FakeChunkRow['admissionState'],
      budgetJson: existing?.budgetJson ?? {},
      checksum: strings[9] ?? null,
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
      lastError: existing?.status === 'completed' ? existing.lastError : null,
      leaseExpiresAt: existing?.status === 'completed' ? existing.leaseExpiresAt : null,
      leaseOwner: existing?.status === 'completed' ? existing.leaseOwner : null,
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
      requestId: existing?.requestId ?? null,
      retryAfter: existing?.retryAfter ?? null,
      retryCount: existing?.retryCount ?? 0,
      snapshotCount: existing?.snapshotCount ?? 1,
      snapshotId: existing?.snapshotId ?? null,
      splitDepth: existing?.splitDepth ?? 0,
      startedAt: existing?.startedAt ?? null,
      status: (existing?.status === 'completed'
        ? existing.status
        : (strings[7] ?? 'pending')) as FakeChunkRow['status'],
      updatedAt: getClock(statements),
      workloadClass: existing?.workloadClass ?? null,
    }

    rows.set(chunkId, row)
  }
  const claimChunk = (statement: string) => {
    const chunkId = getWhereLiteral(statement, 'chunk_id') ?? ''
    const existing = rows.get(chunkId)
    const strings = getSqlStrings(statement)
    const leaseOwner = strings[1] ?? ''
    const leaseExpiresAt = strings[2] ?? null
    const canClaim =
      existing?.admissionState === 'admitted'
      && (existing.status === 'pending' || existing.status === 'failed' || existing.status === 'running')

    if (existing !== undefined && canClaim) {
      rows.set(chunkId, {
        ...existing,
        lastError: null,
        leaseExpiresAt,
        leaseOwner,
        startedAt: existing.startedAt ?? getClock(statements),
        status: 'running',
        updatedAt: getClock(statements),
      })
    }
  }
  const failChunk = (statement: string) => {
    const chunkId = getWhereLiteral(statement, 'chunk_id') ?? ''
    const existing = rows.get(chunkId)

    if (existing !== undefined && existing.status !== 'completed') {
      rows.set(chunkId, {
        ...existing,
        lastError: getSqlStrings(statement)[1] ?? getSqlStrings(statement)[0] ?? null,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: 'failed',
        updatedAt: getClock(statements),
      })
    }
  }
  const completeChunk = (statement: string) => {
    const chunkId = getWhereLiteral(statement, 'chunk_id') ?? ''
    const existing = rows.get(chunkId)

    if (existing?.status === 'running') {
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

    if (statement.includes("status = 'running'")) {
      claimChunk(statement)
    }

    if (statement.includes("SET\n      status = 'failed'") || statement.includes("SET\r\n      status = 'failed'")) {
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
      const chunkId = getWhereLiteral(statement, 'chunk_id') ?? ''
      const row = rows.get(chunkId)
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
