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

const getClock = (statements: readonly string[]) => {
  return new Date(2026, 5, 16, 14, statements.length).toISOString()
}

const getChunkRowFromIdentity = (
  input: ReviewServingRebuildChunkIdentity,
  statements: readonly string[],
): FakeChunkRow => {
  return {
    ...input,
    checksum: null,
    chunkId: getReviewServingRebuildChunkId(input),
    completedAt: null,
    createdAt: getClock(statements),
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    startedAt: null,
    status: 'pending',
    updatedAt: getClock(statements),
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
      checksum: strings[9] ?? null,
      chunkEndKey: strings[6] ?? '',
      chunkId,
      chunkStartKey: strings[5] ?? '',
      completedAt: existing?.completedAt ?? null,
      createdAt: existing?.createdAt ?? getClock(statements),
      inputDigest: strings[4] ?? null,
      inputWatermark: Number(statement.match(/input_watermark[\s\S]*?,\s*(\d+),\s*'[^']*',/u)?.[1] ?? 0),
      lastError: existing?.status === 'completed' ? existing.lastError : null,
      leaseExpiresAt: existing?.status === 'completed' ? existing.leaseExpiresAt : null,
      leaseOwner: existing?.status === 'completed' ? existing.leaseOwner : null,
      outputBaseGeneration: Number(statement.match(/output_base_generation[\s\S]*?'[^']*',\s*(\d+),/u)?.[1] ?? 0),
      projectId: strings[1] ?? null,
      projectionComponent: (strings[2] ?? 'display') as FakeChunkRow['projectionComponent'],
      projectionIdentity: strings[3] ?? '',
      startedAt: existing?.startedAt ?? null,
      status: (existing?.status === 'completed'
        ? existing.status
        : (strings[8] ?? 'pending')) as FakeChunkRow['status'],
      updatedAt: getClock(statements),
    }

    rows.set(chunkId, row)
  }
  const claimChunk = (statement: string) => {
    const chunkId = getWhereLiteral(statement, 'chunk_id') ?? ''
    const existing = rows.get(chunkId)
    const strings = getSqlStrings(statement)
    const leaseOwner = strings[1] ?? ''
    const leaseExpiresAt = strings[2] ?? null
    const canClaim = existing?.status === 'pending' || existing?.status === 'failed' || existing?.status === 'running'

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

    if (statement.includes("status = 'failed'")) {
      failChunk(statement)
    }

    if (statement.includes("status = 'completed'")) {
      completeChunk(statement)
    }

    if (statement.includes('INSERT INTO mart.fake_chunk_output')) {
      outputWrites.push(statement)
    }
  }
  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && statement.includes('chunk_id =')) {
      const chunkId = getWhereLiteral(statement, 'chunk_id') ?? ''
      const row = rows.get(chunkId)
      return (row === undefined ? [] : [row]) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest')) {
      if (statement.includes('ORDER BY updated_at ASC')) {
        const claimable = [...rows.values()].find((row) => {
          return row.status === 'pending' || row.status === 'failed' || row.status === 'running'
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

  expect(next).toEqual({...baseChunkIdentity, checksum: null})
  expect(statements.join('\n')).toContain("status IN ('pending', 'failed')")
  expect(statements.join('\n')).toContain("project_id IS NOT DISTINCT FROM 'project-1'")
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
