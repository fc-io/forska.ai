import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {
  PurgeReviewServingSnapshotsInput,
  ReviewServingSnapshotPurgeDatabase,
} from './reviewServingSnapshotPurge.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-snapshot-purge')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const reviewConfigHash = 'review-config'
const rowsPerTable = 2

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type ColumnRow = {columnDefault: string | null; columnName: string; dataType: string; isNullable: string}
type SnapshotKey = {projectId: string; snapshotId: string}
type SnapshotStatus = 'active' | 'candidate' | 'failed' | 'purging' | 'retired'

const getPurgeModule = () => {
  return import('./reviewServingSnapshotPurge.ts')
}

const getPurgedTables = async () => {
  const {reviewServingSnapshotPurgeBookkeepingTables, reviewServingSnapshotPurgeServingTables} = await getPurgeModule()

  return [
    ...reviewServingSnapshotPurgeServingTables.map((spec) => {
      return spec.table
    }),
    ...reviewServingSnapshotPurgeBookkeepingTables,
  ]
}

const getHoursAgoSql = (hours: number) => {
  return `current_timestamp - to_seconds(${Math.round(hours * 3_600)})`
}

const getGeneratedValueSql = (column: ColumnRow, valuePrefix: string) => {
  const dataType = column.dataType.toUpperCase()

  if (dataType.endsWith('[]')) {
    return `[]::${dataType}`
  }

  if (dataType === 'JSON') {
    return `'{}'::JSON`
  }

  if (dataType === 'BOOLEAN') {
    return 'FALSE'
  }

  if (dataType.startsWith('TIMESTAMP') || dataType === 'DATE') {
    return 'current_timestamp'
  }

  return dataType.includes('INT') || dataType === 'DOUBLE' || dataType === 'FLOAT' || dataType.startsWith('DECIMAL')
    ? 'r.i + 1'
    : `'${valuePrefix}-' || CAST(r.i AS VARCHAR)`
}

const insertGeneratedRows = async (input: {
  count: number
  overrides?: Record<string, string>
  projectId: string
  snapshotId: string
  table: string
  tag?: string
}) => {
  const [schemaName, tableName] = input.table.split('.')
  const columns = await getDatabase().queryJson<ColumnRow>(`
    SELECT
      column_name AS columnName,
      data_type AS dataType,
      is_nullable AS isNullable,
      column_default AS columnDefault
    FROM information_schema.columns
    WHERE table_schema = '${schemaName}' AND table_name = '${tableName}'
    ORDER BY ordinal_position
  `)
  const values = columns.flatMap((column) => {
    const override = input.overrides?.[column.columnName]

    if (override !== undefined) {
      return [[column.columnName, override]]
    }

    if (column.columnName === 'project_id') {
      return [[column.columnName, `'${input.projectId}'`]]
    }

    if (column.columnName === 'snapshot_id') {
      return [[column.columnName, `'${input.snapshotId}'`]]
    }

    return column.isNullable === 'NO' && column.columnDefault === null
      ? [[column.columnName, getGeneratedValueSql(column, `${input.snapshotId}-${input.tag ?? 'row'}`)]]
      : []
  })

  await getDatabase().run(`
    INSERT INTO ${input.table} (${values
      .map(([name]) => {
        return name
      })
      .join(', ')})
    SELECT ${values
      .map(([, value]) => {
        return value
      })
      .join(', ')}
    FROM range(${input.count}) AS r(i)
  `)
}

const snapshotRowOverridesByTable: Record<string, Record<string, string>> = {
  'app.review_rebuild_chunk_manifest': {request_id: 'NULL', status: `'completed'`},
  'mart.review_article_summary_bucket_v4': {ledger_status: `'published'`},
}

const insertSnapshotRows = async (input: SnapshotKey & {count?: number; tables?: readonly string[]; tag?: string}) => {
  const tables = input.tables ?? (await getPurgedTables())

  await tables.reduce<Promise<void>>(async (previous, table) => {
    await previous
    await insertGeneratedRows({
      count: input.count ?? rowsPerTable,
      overrides: snapshotRowOverridesByTable[table],
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      table,
      tag: input.tag,
    })
  }, Promise.resolve())
}

const insertSnapshot = async (
  input: SnapshotKey & {
    activatedHoursAgo?: number
    componentStateJson?: string
    failedHoursAgo?: number
    lastKnownGoodSnapshotId?: string
    reviewConfigHash?: string
    status: SnapshotStatus
    updatedHoursAgo: number
    withRows?: boolean
  },
) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, last_known_good_snapshot_id,
      created_at, updated_at, activated_at, failed_at
    ) VALUES (
      '${input.projectId}', '${input.snapshotId}', '${input.status}', '${input.reviewConfigHash ?? reviewConfigHash}',
      '{}', '${input.componentStateJson ?? '{"optional":[],"required":[]}'}', '[]', '[]', '{}',
      ${input.lastKnownGoodSnapshotId === undefined ? 'NULL' : `'${input.lastKnownGoodSnapshotId}'`},
      ${getHoursAgoSql(input.updatedHoursAgo + 1)}, ${getHoursAgoSql(input.updatedHoursAgo)},
      ${input.activatedHoursAgo === undefined ? 'NULL' : getHoursAgoSql(input.activatedHoursAgo)},
      ${input.failedHoursAgo === undefined ? 'NULL' : getHoursAgoSql(input.failedHoursAgo)}
    )
  `)

  if (input.withRows !== false) {
    await insertSnapshotRows(input)
  }
}

const getSnapshotStatus = async (input: SnapshotKey) => {
  const rows = await getDatabase().queryJson<{status: string}>(`
    SELECT snapshot_status AS status
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'
  `)

  return rows[0]?.status ?? null
}

const getSnapshotRowCounts = async (input: SnapshotKey) => {
  const tables = await getPurgedTables()
  const counts = await Promise.all(
    tables.map(async (table) => {
      const [row] = await getDatabase().queryJson<{count: number | string}>(`
        SELECT COUNT(*) AS count
        FROM ${table}
        WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'
      `)

      return [table, Number(row?.count ?? 0)] as const
    }),
  )

  return Object.fromEntries(counts)
}

const getUniformCounts = async (count: number) => {
  return Object.fromEntries(
    (await getPurgedTables()).map((table) => {
      return [table, count]
    }),
  )
}

const expectSnapshotKept = async (input: SnapshotKey & {status: SnapshotStatus}) => {
  expect(await getSnapshotStatus(input)).toBe(input.status)
  expect(await getSnapshotRowCounts(input)).toEqual(await getUniformCounts(rowsPerTable))
}

const expectSnapshotPurged = async (input: SnapshotKey) => {
  expect(await getSnapshotStatus(input)).toBeNull()
  expect(await getSnapshotRowCounts(input)).toEqual(await getUniformCounts(0))
}

const purgeProject = async (
  projectId: string,
  input: Omit<PurgeReviewServingSnapshotsInput, 'projectId'> = {},
  purgeDatabase: ReviewServingSnapshotPurgeDatabase = getDatabase(),
) => {
  const {purgeReviewServingSnapshots} = await getPurgeModule()

  return purgeReviewServingSnapshots({...input, projectId}, purgeDatabase)
}

const getOutcomes = (result: Awaited<ReturnType<typeof purgeProject>>) => {
  return result.snapshots.map((snapshot) => {
    return [snapshot.snapshotId, snapshot.outcome]
  })
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('purges unreferenced failed and retired snapshots from every serving table and their bookkeeping', async () => {
  const projectId = 'project-purge'
  const active = {projectId, snapshotId: 'snapshot-active'}
  const lastKnownGood = {projectId, snapshotId: 'snapshot-last-known-good'}
  const oldRetired = {projectId, snapshotId: 'snapshot-old-retired'}
  const failed = {projectId, snapshotId: 'snapshot-failed'}

  await insertSnapshot({
    ...active,
    activatedHoursAgo: 72,
    lastKnownGoodSnapshotId: lastKnownGood.snapshotId,
    status: 'active',
    updatedHoursAgo: 72,
  })
  await insertSnapshot({...lastKnownGood, activatedHoursAgo: 96, status: 'retired', updatedHoursAgo: 72})
  await insertSnapshot({...oldRetired, activatedHoursAgo: 120, status: 'retired', updatedHoursAgo: 96})
  await insertSnapshot({...failed, failedHoursAgo: 2, status: 'failed', updatedHoursAgo: 2})

  const {reviewServingSnapshotPurgeServingTables} = await getPurgeModule()
  const result = await purgeProject(projectId)

  expect(result.stopReason).toBe('complete')
  expect(getOutcomes(result)).toEqual([
    [oldRetired.snapshotId, 'purged'],
    [failed.snapshotId, 'purged'],
  ])
  expect(result.deletedRows).toBe(2 * rowsPerTable * reviewServingSnapshotPurgeServingTables.length)
  await expectSnapshotPurged(oldRetired)
  await expectSnapshotPurged(failed)
  await expectSnapshotKept({...active, status: 'active'})
  await expectSnapshotKept({...lastKnownGood, status: 'retired'})
  expect(getOutcomes(await purgeProject(projectId))).toEqual([])
})

test('keeps snapshots the reader or a promotion can still resolve and waits out the grace periods', async () => {
  const projectId = 'project-reachable'
  const scopedConfig = 'review-config-without-active'
  const settlingConfig = 'review-config-just-activated'
  const snapshots = {
    active: {projectId, snapshotId: 'snapshot-active'},
    activeLastKnownGoodFailed: {projectId, snapshotId: 'snapshot-active-lkg-failed'},
    candidate: {projectId, snapshotId: 'snapshot-candidate'},
    candidateLastKnownGood: {projectId, snapshotId: 'snapshot-candidate-lkg'},
    freshFailed: {projectId, snapshotId: 'snapshot-fresh-failed'},
    latestRetired: {projectId, snapshotId: 'snapshot-latest-retired'},
    olderRetired: {projectId, snapshotId: 'snapshot-older-retired'},
    recentlyRetired: {projectId, snapshotId: 'snapshot-recently-retired'},
    settlingActive: {projectId, snapshotId: 'snapshot-settling-active'},
    settlingLatestRetired: {projectId, snapshotId: 'snapshot-settling-latest-retired'},
    settlingRetired: {projectId, snapshotId: 'snapshot-settling-retired'},
  }

  await insertSnapshot({
    ...snapshots.active,
    activatedHoursAgo: 72,
    lastKnownGoodSnapshotId: snapshots.activeLastKnownGoodFailed.snapshotId,
    status: 'active',
    updatedHoursAgo: 72,
  })
  await insertSnapshot({
    ...snapshots.activeLastKnownGoodFailed,
    failedHoursAgo: 96,
    status: 'failed',
    updatedHoursAgo: 96,
  })
  await insertSnapshot({
    ...snapshots.candidate,
    lastKnownGoodSnapshotId: snapshots.candidateLastKnownGood.snapshotId,
    status: 'candidate',
    updatedHoursAgo: 48,
  })
  await insertSnapshot({
    ...snapshots.candidateLastKnownGood,
    activatedHoursAgo: 90,
    reviewConfigHash: 'review-config-candidate-lkg',
    status: 'retired',
    updatedHoursAgo: 80,
  })
  await insertSnapshot({
    ...snapshots.candidateLastKnownGood,
    snapshotId: 'snapshot-candidate-lkg-newer',
    activatedHoursAgo: 70,
    reviewConfigHash: 'review-config-candidate-lkg',
    status: 'retired',
    updatedHoursAgo: 60,
    withRows: false,
  })
  await insertSnapshot({...snapshots.freshFailed, failedHoursAgo: 0.9, status: 'failed', updatedHoursAgo: 0.9})
  await insertSnapshot({
    ...snapshots.latestRetired,
    activatedHoursAgo: 100,
    reviewConfigHash: scopedConfig,
    status: 'retired',
    updatedHoursAgo: 90,
  })
  await insertSnapshot({
    ...snapshots.olderRetired,
    activatedHoursAgo: 150,
    reviewConfigHash: scopedConfig,
    status: 'retired',
    updatedHoursAgo: 100,
  })
  await insertSnapshot({
    ...snapshots.recentlyRetired,
    activatedHoursAgo: 110,
    reviewConfigHash: scopedConfig,
    status: 'retired',
    updatedHoursAgo: 23,
  })
  await insertSnapshot({
    ...snapshots.settlingActive,
    activatedHoursAgo: 0.5,
    reviewConfigHash: settlingConfig,
    status: 'active',
    updatedHoursAgo: 0.5,
  })
  await insertSnapshot({
    ...snapshots.settlingLatestRetired,
    activatedHoursAgo: 50,
    reviewConfigHash: settlingConfig,
    status: 'retired',
    updatedHoursAgo: 0.5,
  })
  await insertSnapshot({
    ...snapshots.settlingRetired,
    activatedHoursAgo: 60,
    reviewConfigHash: settlingConfig,
    status: 'retired',
    updatedHoursAgo: 48,
  })

  const result = await purgeProject(projectId)

  expect(getOutcomes(result)).toEqual([[snapshots.olderRetired.snapshotId, 'purged']])
  await expectSnapshotPurged(snapshots.olderRetired)
  await expectSnapshotKept({...snapshots.active, status: 'active'})
  await expectSnapshotKept({...snapshots.activeLastKnownGoodFailed, status: 'failed'})
  await expectSnapshotKept({...snapshots.candidate, status: 'candidate'})
  await expectSnapshotKept({...snapshots.candidateLastKnownGood, status: 'retired'})
  await expectSnapshotKept({...snapshots.freshFailed, status: 'failed'})
  await expectSnapshotKept({...snapshots.latestRetired, status: 'retired'})
  await expectSnapshotKept({...snapshots.recentlyRetired, status: 'retired'})
  await expectSnapshotKept({...snapshots.settlingActive, status: 'active'})
  await expectSnapshotKept({...snapshots.settlingLatestRetired, status: 'retired'})
  await expectSnapshotKept({...snapshots.settlingRetired, status: 'retired'})
})

test('keeps snapshots that live pins, jobs and open rebuild requests name', async () => {
  const projectId = 'project-referenced'
  const failedSnapshot = (snapshotId: string) => {
    return {projectId, snapshotId}
  }
  const snapshots = {
    completedExport: failedSnapshot('snapshot-completed-pinned-export'),
    completedLatestExport: failedSnapshot('snapshot-completed-latest-export'),
    completedRequest: failedSnapshot('snapshot-completed-request'),
    expiredPin: failedSnapshot('snapshot-expired-pin'),
    livePin: failedSnapshot('snapshot-live-pin'),
    openRequest: failedSnapshot('snapshot-open-request'),
    openRequestIdentity: failedSnapshot('snapshot-open-request-identity'),
    pendingSearch: failedSnapshot('snapshot-pending-search'),
    requestlessPendingChunk: failedSnapshot('snapshot-requestless-pending-chunk'),
    retryableRequest: failedSnapshot('snapshot-retryable-request'),
    runningBulk: failedSnapshot('snapshot-running-bulk'),
  }
  const insertRequest = async (input: {identitySnapshotId?: string; requestId: string; status: string}) => {
    await insertGeneratedRows({
      count: 1,
      overrides: {
        admission_state: `'admitted'`,
        identity_json: `'${JSON.stringify({snapshotId: input.identitySnapshotId ?? null})}'::JSON`,
        request_id: `'${input.requestId}'`,
        requested_components_json: `'["display"]'::JSON`,
        retry_policy_json: `'{"maxAttempts":3}'::JSON`,
        status: `'${input.status}'`,
      },
      projectId,
      snapshotId: input.requestId,
      table: 'app.review_rebuild_request',
    })
  }
  const insertChunk = async (input: SnapshotKey & {requestId: string | null; retryCount?: number; status: string}) => {
    await insertGeneratedRows({
      count: 1,
      overrides: {
        admission_state: `'admitted'`,
        request_id: input.requestId === null ? 'NULL' : `'${input.requestId}'`,
        retry_count: String(input.retryCount ?? 0),
        status: `'${input.status}'`,
      },
      projectId,
      snapshotId: input.snapshotId,
      table: 'app.review_rebuild_chunk_manifest',
    })
  }
  const insertBulkJob = async (input: SnapshotKey & {kind: string; latest: boolean; status: string}) => {
    await insertGeneratedRows({
      count: 1,
      overrides: {
        job_kind: `'${input.kind}'`,
        latest_snapshot_semantics: input.latest ? 'TRUE' : 'FALSE',
        status: `'${input.status}'`,
      },
      projectId,
      snapshotId: input.snapshotId,
      table: 'app.review_bulk_operation_job',
    })
  }

  await Object.values(snapshots).reduce<Promise<void>>(async (previous, snapshot) => {
    await previous
    await insertSnapshot({...snapshot, failedHoursAgo: 3, status: 'failed', updatedHoursAgo: 3})
  }, Promise.resolve())
  await insertGeneratedRows({
    count: 1,
    overrides: {expires_at: getHoursAgoSql(-1), ref_count: '1', released_at: 'NULL'},
    ...snapshots.livePin,
    table: 'app.review_serving_snapshot_pin',
  })
  await insertGeneratedRows({
    count: 1,
    overrides: {expires_at: getHoursAgoSql(1), ref_count: '1', released_at: 'NULL'},
    ...snapshots.expiredPin,
    table: 'app.review_serving_snapshot_pin',
  })
  await insertGeneratedRows({
    count: 1,
    overrides: {status: `'pending'`},
    ...snapshots.pendingSearch,
    table: 'app.review_search_job',
  })
  await insertBulkJob({...snapshots.runningBulk, kind: 'review.pdf.selection', latest: true, status: 'running'})
  await insertBulkJob({
    ...snapshots.completedExport,
    kind: 'review.export.selection',
    latest: false,
    status: 'completed',
  })
  await insertBulkJob({
    ...snapshots.completedLatestExport,
    kind: 'review.export.selection',
    latest: true,
    status: 'completed',
  })
  await insertRequest({requestId: 'request-admitted', status: 'admitted'})
  await insertChunk({...snapshots.openRequest, requestId: 'request-admitted', status: 'completed'})
  await insertRequest({
    identitySnapshotId: snapshots.openRequestIdentity.snapshotId,
    requestId: 'requestless-bootstrap-open',
    status: 'admitted',
  })
  await insertRequest({requestId: 'request-retryable', status: 'failed'})
  await insertChunk({...snapshots.retryableRequest, requestId: 'request-retryable', retryCount: 1, status: 'failed'})
  await insertRequest({requestId: 'request-completed', status: 'completed'})
  await insertChunk({...snapshots.completedRequest, requestId: 'request-completed', status: 'completed'})
  await insertChunk({...snapshots.requestlessPendingChunk, requestId: null, status: 'pending'})

  const result = await purgeProject(projectId, {maxSnapshots: 20})

  expect(
    result.snapshots
      .map((snapshot) => {
        return snapshot.snapshotId
      })
      .sort(),
  ).toEqual(
    [snapshots.completedLatestExport, snapshots.completedRequest, snapshots.expiredPin].map((snapshot) => {
      return snapshot.snapshotId
    }),
  )
  await expectSnapshotPurged(snapshots.completedLatestExport)
  await expectSnapshotPurged(snapshots.completedRequest)
  await expectSnapshotPurged(snapshots.expiredPin)

  const keptCounts = await getUniformCounts(rowsPerTable)

  await [
    snapshots.completedExport,
    snapshots.livePin,
    snapshots.openRequestIdentity,
    snapshots.pendingSearch,
    snapshots.runningBulk,
  ].reduce<Promise<void>>(async (previous, snapshot) => {
    await previous
    expect(await getSnapshotStatus(snapshot)).toBe('failed')
    expect(await getSnapshotRowCounts(snapshot)).toEqual(keptCounts)
  }, Promise.resolve())
  await [snapshots.openRequest, snapshots.retryableRequest, snapshots.requestlessPendingChunk].reduce<Promise<void>>(
    async (previous, snapshot) => {
      await previous
      expect(await getSnapshotStatus(snapshot)).toBe('failed')
      expect(await getSnapshotRowCounts(snapshot)).toEqual({
        ...keptCounts,
        'app.review_rebuild_chunk_manifest': rowsPerTable + 1,
      })
    },
    Promise.resolve(),
  )
})

test('snapshots only closed requests name are purged, whatever their leftover chunks look like', async () => {
  const projectId = 'project-closed-requests'
  const snapshots = {
    closedBlocked: {projectId, snapshotId: 'snapshot-closed-blocked'},
    closedSuperseded: {projectId, snapshotId: 'snapshot-closed-superseded'},
    retryable: {projectId, snapshotId: 'snapshot-still-retryable'},
    terminalChunk: {projectId, snapshotId: 'snapshot-terminal-chunk'},
  }
  const insertFailedRequest = async (input: {admissionState: string; lastError: string; requestId: string}) => {
    await insertGeneratedRows({
      count: 1,
      overrides: {
        admission_state: `'${input.admissionState}'`,
        identity_json: `'{}'::JSON`,
        last_error: `'${input.lastError}'`,
        request_id: `'${input.requestId}'`,
        requested_components_json: `'["display"]'::JSON`,
        retry_policy_json: `'{"maxAttempts":3}'::JSON`,
        status: `'failed'`,
      },
      projectId,
      snapshotId: input.requestId,
      table: 'app.review_rebuild_request',
    })
  }
  const insertChunk = async (input: SnapshotKey & {requestId: string; status: string; tag: string}) => {
    await insertGeneratedRows({
      count: 1,
      overrides: {
        admission_state: `'admitted'`,
        request_id: `'${input.requestId}'`,
        retry_count: '0',
        status: `'${input.status}'`,
      },
      projectId,
      snapshotId: input.snapshotId,
      table: 'app.review_rebuild_chunk_manifest',
      tag: input.tag,
    })
  }

  await Object.values(snapshots).reduce<Promise<void>>(async (previous, snapshot) => {
    await previous
    await insertSnapshot({...snapshot, failedHoursAgo: 3, status: 'failed', updatedHoursAgo: 3})
  }, Promise.resolve())
  await insertFailedRequest({
    admissionState: 'admitted',
    lastError: 'superseded: project archived',
    requestId: 'request-closed-superseded',
  })
  await insertChunk({...snapshots.closedSuperseded, requestId: 'request-closed-superseded', status: 'failed', tag: 'a'})
  await insertFailedRequest({
    admissionState: 'blocked_over_budget',
    lastError: 'superseded: review config changed',
    requestId: 'request-closed-blocked',
  })
  await insertChunk({
    ...snapshots.closedBlocked,
    requestId: 'request-closed-blocked',
    status: 'blocked_over_budget',
    tag: 'a',
  })
  await insertFailedRequest({
    admissionState: 'admitted',
    lastError: 'Out of Memory',
    requestId: 'request-terminal-chunk',
  })
  await insertChunk({...snapshots.terminalChunk, requestId: 'request-terminal-chunk', status: 'failed', tag: 'a'})
  await insertChunk({...snapshots.terminalChunk, requestId: 'request-terminal-chunk', status: 'quarantined', tag: 'b'})
  await insertFailedRequest({admissionState: 'admitted', lastError: 'Out of Memory', requestId: 'request-retryable'})
  await insertChunk({...snapshots.retryable, requestId: 'request-retryable', status: 'failed', tag: 'a'})

  const result = await purgeProject(projectId, {maxSnapshots: 20})

  expect(
    result.snapshots
      .map((snapshot) => {
        return snapshot.snapshotId
      })
      .sort(),
  ).toEqual(
    [snapshots.closedBlocked, snapshots.closedSuperseded, snapshots.terminalChunk].map((snapshot) => {
      return snapshot.snapshotId
    }),
  )
  await expectSnapshotPurged(snapshots.closedBlocked)
  await expectSnapshotPurged(snapshots.closedSuperseded)
  await expectSnapshotPurged(snapshots.terminalChunk)
  expect(await getSnapshotStatus(snapshots.retryable)).toBe('failed')
})

test('a snapshot id a rebuild re-creates while it is purged keeps every row written for the new candidate', async () => {
  const projectId = 'project-recreated'
  const snapshot = {projectId, snapshotId: 'snapshot-recreated'}
  const {createCandidateReviewServingSnapshotManifest} = await import('./reviewServingManifestRepository.ts')
  const {reviewServingSnapshotPurgeBookkeepingTables, reviewServingSnapshotPurgeServingTables} = await getPurgeModule()
  const recreatedRowCount = 3
  let transactionCount = 0

  await insertSnapshot({...snapshot, failedHoursAgo: 2, status: 'failed', updatedHoursAgo: 2})

  const recreateSnapshot = async () => {
    await createCandidateReviewServingSnapshotManifest({
      ...snapshot,
      componentRequirements: {optionalComponents: [], requiredComponents: []},
      componentState: {optional: [], required: []},
      composedIdentity: {},
      reviewConfigHash,
      sourceWatermarks: {},
    })
    await insertSnapshotRows({...snapshot, count: recreatedRowCount, tag: 'recreated'})
  }
  const interceptingDatabase: ReviewServingSnapshotPurgeDatabase = {
    queryJson: (statement) => {
      return getDatabase().queryJson(statement)
    },
    run: (statement) => {
      return getDatabase().run(statement)
    },
    transaction: async (operation) => {
      const result = await getDatabase().transaction(operation)

      transactionCount += 1

      if (transactionCount === 3) {
        await recreateSnapshot()
      }

      return result
    },
  }

  const result = await purgeProject(projectId, {}, interceptingDatabase)
  const counts = await getSnapshotRowCounts(snapshot)
  const emptiedBeforeRecreation = new Set<string>([
    ...reviewServingSnapshotPurgeBookkeepingTables,
    ...reviewServingSnapshotPurgeServingTables.slice(0, 2).map((spec) => {
      return spec.table
    }),
  ])

  expect(getOutcomes(result)).toEqual([[snapshot.snapshotId, 'recreated']])
  expect(await getSnapshotStatus(snapshot)).toBe('candidate')
  expect(counts).toEqual(
    Object.fromEntries(
      Object.keys(counts).map((table) => {
        return [table, (emptiedBeforeRecreation.has(table) ? 0 : rowsPerTable) + recreatedRowCount]
      }),
    ),
  )
  expect(getOutcomes(await purgeProject(projectId))).toEqual([])
})

test('a bootstrap that re-creates a purging snapshot id stops the purge before it clones rows into it', async () => {
  const projectId = 'project-bootstrap'
  const snapshot = {projectId, snapshotId: 'snapshot-bootstrap'}
  const {
    getReviewServingSnapshotManifest,
    createCandidateReviewServingSnapshotManifest,
    releaseDeadReviewServingSnapshotManifest,
    retireObsoleteReviewServingSnapshotManifests,
    upsertReviewServingProjectionIdentityManifest,
  } = await import('./reviewServingManifestRepository.ts')
  const getAvailableComponentCount = async () => {
    const manifest = await getReviewServingSnapshotManifest(
      {...snapshot, componentStateMode: 'available'},
      getDatabase(),
    )

    return manifest === null ? null : manifest.componentState.required.length
  }

  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 0,
      definitionVersion: 'display:test',
      inputWatermark: 0,
      patchWatermark: 0,
      projectId,
      projectionComponent: 'display',
      projectionIdentity: `display:${projectId}`,
      reviewConfigHash,
      status: 'active',
    },
    getDatabase(),
  )
  await insertSnapshot({
    ...snapshot,
    componentStateJson: JSON.stringify({
      optional: [],
      required: [
        {baseGeneration: '0', component: 'display', patchWatermark: '0', projectionIdentity: `display:${projectId}`},
      ],
    }),
    failedHoursAgo: 2,
    status: 'failed',
    updatedHoursAgo: 2,
  })

  expect(await getAvailableComponentCount()).toBe(1)

  const partial = await purgeProject(projectId, {maxDeletedRows: 1})

  expect(partial.stopReason).toBe('rowBudget')
  expect(getOutcomes(partial)).toEqual([[snapshot.snapshotId, 'partial']])
  expect(await getSnapshotStatus(snapshot)).toBe('purging')
  expect(await getAvailableComponentCount()).toBe(0)

  await retireObsoleteReviewServingSnapshotManifests({keepSnapshotIds: [], projectId, reviewConfigHash}, getDatabase())

  expect(await getSnapshotStatus(snapshot)).toBe('purging')

  await releaseDeadReviewServingSnapshotManifest(snapshot, getDatabase())

  expect(await getSnapshotStatus(snapshot)).toBe('failed')

  await insertSnapshotRows({...snapshot, count: 5, tables: ['mart.review_title_search_serving_v4'], tag: 'clone'})

  expect(getOutcomes(await purgeProject(projectId))).toEqual([])
  expect((await getSnapshotRowCounts(snapshot))['mart.review_title_search_serving_v4']).toBe(5)

  await createCandidateReviewServingSnapshotManifest({
    ...snapshot,
    componentRequirements: {optionalComponents: [], requiredComponents: []},
    componentState: {optional: [], required: []},
    composedIdentity: {},
    reviewConfigHash,
    sourceWatermarks: {},
  })

  expect(await getSnapshotStatus(snapshot)).toBe('candidate')
  expect(getOutcomes(await purgeProject(projectId))).toEqual([])
  expect((await getSnapshotRowCounts(snapshot))['mart.review_title_search_serving_v4']).toBe(5)
})

test('each call is bounded by snapshots, deleted rows, time and foreground work and resumes a partial purge', async () => {
  const projectId = 'project-bounded'
  const first = {projectId, snapshotId: 'snapshot-bounded-a'}
  const second = {projectId, snapshotId: 'snapshot-bounded-b'}
  const third = {projectId, snapshotId: 'snapshot-bounded-c'}
  const indexedTable = 'mart.review_article_summary_rebuild_accumulator_chunk_v4'
  const indexedRowCount = 30_000
  let clockMs = 0

  await insertSnapshot({...first, failedHoursAgo: 5, status: 'failed', updatedHoursAgo: 5})
  await insertSnapshotRows({...first, count: indexedRowCount, tables: [indexedTable], tag: 'bulk'})
  await insertSnapshot({...second, failedHoursAgo: 4, status: 'failed', updatedHoursAgo: 4})
  await insertSnapshot({...third, failedHoursAgo: 3, status: 'failed', updatedHoursAgo: 3})

  const onlyFirst = await purgeProject(projectId, {maxSnapshots: 1})

  expect(getOutcomes(onlyFirst)).toEqual([[first.snapshotId, 'purged']])
  expect(onlyFirst.stopReason).toBe('complete')
  await expectSnapshotPurged(first)
  await expectSnapshotKept({...second, status: 'failed'})

  const rowBudget = await purgeProject(projectId, {maxDeletedRows: 1})

  expect(rowBudget.stopReason).toBe('rowBudget')
  expect(getOutcomes(rowBudget)).toEqual([[second.snapshotId, 'partial']])
  expect(await getSnapshotStatus(second)).toBe('purging')
  await expectSnapshotKept({...third, status: 'failed'})

  const timeBudget = await purgeProject(projectId, {
    budgetMs: 1_000,
    nowMs: () => {
      clockMs += 600

      return clockMs
    },
  })

  expect(timeBudget.stopReason).toBe('budget')
  expect(getOutcomes(timeBudget)).toEqual([[second.snapshotId, 'partial']])

  const yielded = await purgeProject(projectId, {
    shouldYield: () => {
      return true
    },
  })

  expect(yielded.stopReason).toBe('yield')
  expect(getOutcomes(yielded)).toEqual([[second.snapshotId, 'partial']])
  expect(await getSnapshotStatus(second)).toBe('purging')

  const resumed = await purgeProject(projectId)

  expect(getOutcomes(resumed)).toEqual([
    [second.snapshotId, 'purged'],
    [third.snapshotId, 'purged'],
  ])
  await expectSnapshotPurged(second)
  await expectSnapshotPurged(third)
})
