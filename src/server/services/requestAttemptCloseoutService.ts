import {randomUUID} from 'node:crypto'

import {
  getDurableTerminalRequestAttemptCloseoutProjectionRows,
  type JudgmentRequestAttemptCloseoutProjectionInput,
  type JudgmentRequestAttemptCloseoutProjectionRow,
  type JudgmentRequestAttemptJsonEntry,
  parseRequestAttempts,
} from '../cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

export type RequestAttemptCloseoutRunner = {run: (statement: string) => Promise<void>}
export type RequestAttemptCloseoutQueryRunner = RequestAttemptCloseoutRunner & {
  queryJson: <T>(statement: string) => Promise<T[]>
}
export type RequestAttemptCloseoutDatabaseRunner = RequestAttemptCloseoutQueryRunner & {
  transaction?: <T>(operation: (runner: RequestAttemptCloseoutQueryRunner) => Promise<T>) => Promise<T>
}

export type RequestAttemptCloseoutTokenUseInput = {
  requestAttemptsJson?: unknown
  tokenUseCreatedAt: JudgmentRequestAttemptCloseoutProjectionInput['tokenUseCreatedAt']
  tokenUseFinishedAt?: JudgmentRequestAttemptCloseoutProjectionInput['tokenUseFinishedAt']
  tokenUseId: string
  tokenUseStartedAt?: JudgmentRequestAttemptCloseoutProjectionInput['tokenUseStartedAt']
}

export type RequestAttemptCloseoutProjectionResult = {attempted: number; projected: number}

export type RequestAttemptCloseoutWriteRow = Omit<JudgmentRequestAttemptCloseoutProjectionRow, 'durableCloseoutRef'> & {
  durableCloseoutRefJson: unknown
}

export type RequestAttemptCloseoutRebuildCursor = {createdAt: string; id: string}
export type RequestAttemptCloseoutRebuildResult = {
  attempted: number
  batches: number
  highWaterMark: RequestAttemptCloseoutRebuildCursor | null
  mode: 'maintenance' | 'online'
  projected: number
  scanned: number
}
export type RequestAttemptCloseoutMaintenanceRebuildInput = {
  batchSize?: number
  cleanupDisabled: true
  mode: 'maintenance'
  runner?: RequestAttemptCloseoutDatabaseRunner
  tokenUseWritersStopped: true
}
export type RequestAttemptCloseoutOnlineRebuildInput = {
  batchSize?: number
  mode: 'online'
  runner?: RequestAttemptCloseoutDatabaseRunner
}
export type RequestAttemptCloseoutRebuildInput =
  | RequestAttemptCloseoutMaintenanceRebuildInput
  | RequestAttemptCloseoutOnlineRebuildInput
export type RequestAttemptCloseoutStartupBackfillResult = RequestAttemptCloseoutRebuildResult & {skipped: boolean}

type RequestAttemptCloseoutTokenUseRebuildRow = {
  createdAt: JudgmentRequestAttemptCloseoutProjectionInput['tokenUseCreatedAt']
  finishedAt: JudgmentRequestAttemptCloseoutProjectionInput['tokenUseFinishedAt']
  id: string
  requestAttemptsJson: unknown
  startedAt: JudgmentRequestAttemptCloseoutProjectionInput['tokenUseStartedAt']
}

type RequestAttemptCloseoutRebuildAccumulator = {
  attempted: number
  batches: number
  cursor: RequestAttemptCloseoutRebuildCursor | null
  scanned: number
}

type RequestAttemptCloseoutBackfillStateRow = {completedAt: unknown}

const requestAttemptCloseoutStartupBackfillStateId = 'initial-token-use-closeout-backfill'

const getJsonLiteral = (value: unknown): string => {
  return `CAST(${getSqlLiteral(JSON.stringify(value) ?? 'null')} AS JSON)`
}

const getTimestampValue = (value: string): Date => {
  return new Date(value)
}

const getTimestampSqlLiteral = (value: string): string => {
  return getTimestampLiteral(getTimestampValue(value))
}

const getRequestAttemptCloseoutRowKey = (row: RequestAttemptCloseoutWriteRow): string => {
  return `${row.requestAttemptId}\u0000${row.providerKey}`
}

const compareTimestampValues = (left: string, right: string): number => {
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  const bothDates = Number.isFinite(leftMs) && Number.isFinite(rightMs)

  return bothDates ? leftMs - rightMs : left.localeCompare(right)
}

const compareRequestAttemptCloseoutRows = (
  left: RequestAttemptCloseoutWriteRow,
  right: RequestAttemptCloseoutWriteRow,
): number => {
  const closedAtComparison = compareTimestampValues(left.closedAt, right.closedAt)
  const tokenUseCreatedAtComparison = compareTimestampValues(left.tokenUseCreatedAt, right.tokenUseCreatedAt)

  return closedAtComparison !== 0
    ? closedAtComparison
    : tokenUseCreatedAtComparison !== 0
      ? tokenUseCreatedAtComparison
      : left.tokenUseId.localeCompare(right.tokenUseId)
}

const getEarliestRequestAttemptCloseoutRows = (
  rows: RequestAttemptCloseoutWriteRow[],
): RequestAttemptCloseoutWriteRow[] => {
  const earliestRows = rows.reduce<Map<string, RequestAttemptCloseoutWriteRow>>((acc, row) => {
    const key = getRequestAttemptCloseoutRowKey(row)
    const existingRow = acc.get(key)
    const nextRow = existingRow && compareRequestAttemptCloseoutRows(existingRow, row) <= 0 ? existingRow : row

    acc.set(key, nextRow)
    return acc
  }, new Map())

  return [...earliestRows.values()].sort(compareRequestAttemptCloseoutRows)
}

const getRequestAttemptCloseoutWriteRows = (
  input: RequestAttemptCloseoutTokenUseInput,
): RequestAttemptCloseoutWriteRow[] => {
  const requestAttemptsJson = input.requestAttemptsJson
  const requestAttemptsInput =
    Array.isArray(requestAttemptsJson) || typeof requestAttemptsJson === 'string' || requestAttemptsJson == null
      ? (requestAttemptsJson as JudgmentRequestAttemptJsonEntry[] | string | null | undefined)
      : null
  const requestAttempts = parseRequestAttempts(requestAttemptsInput)

  return requestAttempts.flatMap((requestAttempt) => {
    const [row] = getDurableTerminalRequestAttemptCloseoutProjectionRows({
      requestAttempts: [requestAttempt],
      tokenUseCreatedAt: input.tokenUseCreatedAt,
      tokenUseFinishedAt: input.tokenUseFinishedAt,
      tokenUseId: input.tokenUseId,
      tokenUseStartedAt: input.tokenUseStartedAt,
    })

    return row ? [{...row, durableCloseoutRefJson: requestAttempt.durableCloseoutRef ?? row.durableCloseoutRef}] : []
  })
}

const requestAttemptCloseoutIncomingIsEarlierSql = `
  EXCLUDED.closed_at < closed_at
  OR (
    EXCLUDED.closed_at = closed_at
    AND EXCLUDED.token_use_created_at < token_use_created_at
  )
  OR (
    EXCLUDED.closed_at = closed_at
    AND EXCLUDED.token_use_created_at = token_use_created_at
    AND EXCLUDED.token_use_id < token_use_id
  )
`

const getRequestAttemptCloseoutValuesSql = (row: RequestAttemptCloseoutWriteRow): string => {
  return `(
    ${getSqlLiteral(row.tokenUseId)},
    ${getTimestampSqlLiteral(row.tokenUseCreatedAt)},
    ${getSqlLiteral(row.requestAttemptId)},
    ${getSqlLiteral(row.providerKey)},
    ${getSqlLiteral(row.closeoutKind)},
    ${getSqlLiteral(row.durableCloseoutKind)},
    ${getSqlLiteral(row.durableCloseoutId)},
    ${getJsonLiteral(row.durableCloseoutRefJson)},
    ${getTimestampSqlLiteral(row.closedAt)}
  )`
}

const getRequestAttemptCloseoutCaseSql = (column: string): string => {
  return `CASE WHEN ${requestAttemptCloseoutIncomingIsEarlierSql} THEN EXCLUDED.${column} ELSE ${column} END`
}

const requestAttemptCloseoutInsertColumnsSql = `
  token_use_id,
  token_use_created_at,
  request_attempt_id,
  provider_key,
  closeout_kind,
  durable_closeout_kind,
  durable_closeout_id,
  durable_closeout_ref_json,
  closed_at
`

const requestAttemptCloseoutUpdateAssignmentsSql = `
  token_use_id = ${getRequestAttemptCloseoutCaseSql('token_use_id')},
  token_use_created_at = ${getRequestAttemptCloseoutCaseSql('token_use_created_at')},
  closeout_kind = ${getRequestAttemptCloseoutCaseSql('closeout_kind')},
  durable_closeout_kind = ${getRequestAttemptCloseoutCaseSql('durable_closeout_kind')},
  durable_closeout_id = ${getRequestAttemptCloseoutCaseSql('durable_closeout_id')},
  durable_closeout_ref_json = ${getRequestAttemptCloseoutCaseSql('durable_closeout_ref_json')},
  closed_at = ${getRequestAttemptCloseoutCaseSql('closed_at')},
  updated_at = now()
`

const getUpsertRequestAttemptCloseoutRowsSql = ({
  rows,
  targetTableName,
}: {
  rows: RequestAttemptCloseoutWriteRow[]
  targetTableName: string
}): string => {
  return `
    INSERT INTO ${targetTableName} (${requestAttemptCloseoutInsertColumnsSql})
    VALUES ${rows.map(getRequestAttemptCloseoutValuesSql).join(', ')}
    ON CONFLICT(request_attempt_id, provider_key) DO UPDATE SET
      ${requestAttemptCloseoutUpdateAssignmentsSql}
  `
}

const getUpsertRequestAttemptCloseoutStagingSql = (stagingTableName: string): string => {
  return `
    INSERT INTO app.request_attempt_closeout (${requestAttemptCloseoutInsertColumnsSql})
    SELECT ${requestAttemptCloseoutInsertColumnsSql}
    FROM ${stagingTableName}
    ORDER BY closed_at, token_use_created_at, token_use_id
    ON CONFLICT(request_attempt_id, provider_key) DO UPDATE SET
      ${requestAttemptCloseoutUpdateAssignmentsSql}
  `
}

const getCreateRequestAttemptCloseoutStagingTableSql = (stagingTableName: string): string => {
  return `
    CREATE TEMP TABLE ${stagingTableName} (
      token_use_id VARCHAR NOT NULL,
      token_use_created_at TIMESTAMPTZ NOT NULL,
      request_attempt_id VARCHAR NOT NULL,
      provider_key VARCHAR NOT NULL,
      closeout_kind VARCHAR NOT NULL,
      durable_closeout_kind VARCHAR NOT NULL,
      durable_closeout_id VARCHAR,
      durable_closeout_ref_json JSON NOT NULL,
      closed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (request_attempt_id, provider_key)
    )
  `
}

const getRequestAttemptCloseoutStagingTableName = (): string => {
  return `temp_request_attempt_closeout_rebuild_${randomUUID().replaceAll('-', '_')}`
}

const getPositiveBatchSize = (batchSize: number | undefined): number => {
  return Math.max(1, Math.floor(batchSize ?? 1000))
}

const getRequestAttemptCloseoutRebuildCursor = (
  row: {createdAt: unknown; id: string} | undefined,
): RequestAttemptCloseoutRebuildCursor | null => {
  const createdAt = getDateValue(row?.createdAt)
  const id = typeof row?.id === 'string' ? row.id : ''

  return createdAt && id.trim().length > 0 ? {createdAt: createdAt.toISOString(), id} : null
}

const getRequestAttemptCloseoutRebuildCursorClause = (cursor: RequestAttemptCloseoutRebuildCursor | null): string => {
  return cursor
    ? `(
        created_at > ${getTimestampLiteral(new Date(cursor.createdAt))}
        OR (created_at = ${getTimestampLiteral(new Date(cursor.createdAt))} AND id > ${getSqlLiteral(cursor.id)})
      )`
    : 'TRUE'
}

const getRequestAttemptCloseoutRebuildHighWaterClause = (
  highWaterMark: RequestAttemptCloseoutRebuildCursor | null,
): string => {
  return highWaterMark
    ? `(
        created_at < ${getTimestampLiteral(new Date(highWaterMark.createdAt))}
        OR (created_at = ${getTimestampLiteral(new Date(highWaterMark.createdAt))} AND id <= ${getSqlLiteral(highWaterMark.id)})
      )`
    : 'TRUE'
}

const getRequestAttemptCloseoutTokenUseBatchSql = ({
  batchSize,
  cursor,
  highWaterMark,
}: {
  batchSize: number
  cursor: RequestAttemptCloseoutRebuildCursor | null
  highWaterMark: RequestAttemptCloseoutRebuildCursor | null
}): string => {
  return `
    SELECT
      id,
      TO_JSON(request_attempts_json) AS requestAttemptsJson,
      created_at AS createdAt,
      started_at AS startedAt,
      finished_at AS finishedAt
    FROM app.token_use
    WHERE ${getRequestAttemptCloseoutRebuildCursorClause(cursor)}
      AND ${getRequestAttemptCloseoutRebuildHighWaterClause(highWaterMark)}
    ORDER BY created_at, id
    LIMIT ${batchSize}
  `
}

const getRequestAttemptCloseoutHighWaterMark = async (
  runner: RequestAttemptCloseoutQueryRunner,
): Promise<RequestAttemptCloseoutRebuildCursor | null> => {
  const [row] = await runner.queryJson<{createdAt: unknown; id: string}>(`
    SELECT
      created_at AS createdAt,
      id
    FROM app.token_use
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)

  return getRequestAttemptCloseoutRebuildCursor(row)
}

const getRequestAttemptCloseoutTokenUseRows = async ({
  batchSize,
  cursor,
  highWaterMark,
  runner,
}: {
  batchSize: number
  cursor: RequestAttemptCloseoutRebuildCursor | null
  highWaterMark: RequestAttemptCloseoutRebuildCursor | null
  runner: RequestAttemptCloseoutQueryRunner
}): Promise<RequestAttemptCloseoutTokenUseRebuildRow[]> => {
  return runner.queryJson<RequestAttemptCloseoutTokenUseRebuildRow>(
    getRequestAttemptCloseoutTokenUseBatchSql({batchSize, cursor, highWaterMark}),
  )
}

const getRequestAttemptCloseoutRowsForTokenUseRows = (
  rows: RequestAttemptCloseoutTokenUseRebuildRow[],
): RequestAttemptCloseoutWriteRow[] => {
  return rows.flatMap((row) => {
    return getRequestAttemptCloseoutWriteRows({
      requestAttemptsJson: row.requestAttemptsJson,
      tokenUseCreatedAt: row.createdAt,
      tokenUseFinishedAt: row.finishedAt,
      tokenUseId: row.id,
      tokenUseStartedAt: row.startedAt,
    })
  })
}

const rebuildRequestAttemptCloseoutBatches = async ({
  accumulator,
  batchSize,
  highWaterMark,
  runner,
  targetTableName,
}: {
  accumulator: RequestAttemptCloseoutRebuildAccumulator
  batchSize: number
  highWaterMark: RequestAttemptCloseoutRebuildCursor | null
  runner: RequestAttemptCloseoutQueryRunner
  targetTableName: string
}): Promise<RequestAttemptCloseoutRebuildAccumulator> => {
  const tokenUseRows = await getRequestAttemptCloseoutTokenUseRows({
    batchSize,
    cursor: accumulator.cursor,
    highWaterMark,
    runner,
  })
  const rows = getRequestAttemptCloseoutRowsForTokenUseRows(tokenUseRows)
  const result = await upsertRequestAttemptCloseoutRowsIntoTable({rows, runner, targetTableName})
  const cursor = getRequestAttemptCloseoutRebuildCursor(tokenUseRows.at(-1))
  const nextAccumulator = {
    attempted: accumulator.attempted + result.attempted,
    batches: accumulator.batches + (tokenUseRows.length > 0 ? 1 : 0),
    cursor,
    scanned: accumulator.scanned + tokenUseRows.length,
  }

  return tokenUseRows.length === batchSize && cursor
    ? rebuildRequestAttemptCloseoutBatches({
        accumulator: nextAccumulator,
        batchSize,
        highWaterMark,
        runner,
        targetTableName,
      })
    : nextAccumulator
}

const getRequestAttemptCloseoutRowCount = async (
  runner: RequestAttemptCloseoutQueryRunner,
  tableName: string,
): Promise<number> => {
  const [row] = await runner.queryJson<{count: number | string | bigint}>(`
    SELECT COUNT(*) AS count
    FROM ${tableName}
  `)

  return Number(row?.count ?? 0)
}

const getInitialRequestAttemptCloseoutRebuildAccumulator = (): RequestAttemptCloseoutRebuildAccumulator => {
  return {attempted: 0, batches: 0, cursor: null, scanned: 0}
}

const getRequestAttemptCloseoutRebuildStats = (accumulator: RequestAttemptCloseoutRebuildAccumulator) => {
  return {attempted: accumulator.attempted, batches: accumulator.batches, scanned: accumulator.scanned}
}

const rebuildRequestAttemptCloseoutsIntoTable = async ({
  batchSize,
  highWaterMark,
  runner,
  targetTableName,
}: {
  batchSize: number
  highWaterMark: RequestAttemptCloseoutRebuildCursor | null
  runner: RequestAttemptCloseoutQueryRunner
  targetTableName: string
}): Promise<RequestAttemptCloseoutRebuildAccumulator> => {
  return rebuildRequestAttemptCloseoutBatches({
    accumulator: getInitialRequestAttemptCloseoutRebuildAccumulator(),
    batchSize,
    highWaterMark,
    runner,
    targetTableName,
  })
}

const rebuildRequestAttemptCloseoutsForMaintenanceTx = async ({
  batchSize,
  runner,
}: {
  batchSize: number
  runner: RequestAttemptCloseoutQueryRunner
}): Promise<RequestAttemptCloseoutRebuildResult> => {
  await runner.run('TRUNCATE app.request_attempt_closeout')
  const accumulator = await rebuildRequestAttemptCloseoutsIntoTable({
    batchSize,
    highWaterMark: null,
    runner,
    targetTableName: 'app.request_attempt_closeout',
  })
  const projected = await getRequestAttemptCloseoutRowCount(runner, 'app.request_attempt_closeout')
  const stats = getRequestAttemptCloseoutRebuildStats(accumulator)

  return {...stats, highWaterMark: null, mode: 'maintenance', projected}
}

const rebuildRequestAttemptCloseoutsForMaintenance = async (
  input: RequestAttemptCloseoutMaintenanceRebuildInput,
): Promise<RequestAttemptCloseoutRebuildResult> => {
  const runner = (input.runner ?? getAppDatabaseService()) as RequestAttemptCloseoutDatabaseRunner
  const batchSize = getPositiveBatchSize(input.batchSize)

  if (input.tokenUseWritersStopped !== true || input.cleanupDisabled !== true) {
    throw new Error(
      'request_attempt_closeout maintenance rebuild requires stopped token-use writers and disabled cleanup',
    )
  }

  return runner.transaction
    ? runner.transaction((tx) => {
        return rebuildRequestAttemptCloseoutsForMaintenanceTx({batchSize, runner: tx})
      })
    : rebuildRequestAttemptCloseoutsForMaintenanceTx({batchSize, runner})
}

const rebuildRequestAttemptCloseoutsOnline = async (
  input: RequestAttemptCloseoutOnlineRebuildInput,
): Promise<RequestAttemptCloseoutRebuildResult> => {
  const runner = (input.runner ?? getAppDatabaseService()) as RequestAttemptCloseoutDatabaseRunner
  const batchSize = getPositiveBatchSize(input.batchSize)
  const highWaterMark = await getRequestAttemptCloseoutHighWaterMark(runner)
  const stagingTableName = getRequestAttemptCloseoutStagingTableName()

  if (!highWaterMark) {
    return {attempted: 0, batches: 0, highWaterMark: null, mode: 'online', projected: 0, scanned: 0}
  }

  await runner.run(getCreateRequestAttemptCloseoutStagingTableSql(stagingTableName))

  try {
    const accumulator = await rebuildRequestAttemptCloseoutsIntoTable({
      batchSize,
      highWaterMark,
      runner,
      targetTableName: stagingTableName,
    })
    const projected = await getRequestAttemptCloseoutRowCount(runner, stagingTableName)
    const stats = getRequestAttemptCloseoutRebuildStats(accumulator)
    await runner.run(getUpsertRequestAttemptCloseoutStagingSql(stagingTableName))

    return {...stats, highWaterMark, mode: 'online', projected}
  } finally {
    await runner.run(`DROP TABLE IF EXISTS ${stagingTableName}`)
  }
}

const getSkippedRequestAttemptCloseoutStartupBackfillResult = (): RequestAttemptCloseoutStartupBackfillResult => {
  return {attempted: 0, batches: 0, highWaterMark: null, mode: 'online', projected: 0, scanned: 0, skipped: true}
}

const getRequestAttemptCloseoutBackfillCompleted = async (
  runner: RequestAttemptCloseoutQueryRunner,
): Promise<boolean> => {
  const [row] = await runner.queryJson<RequestAttemptCloseoutBackfillStateRow>(`
    SELECT completed_at AS completedAt
    FROM app.request_attempt_closeout_backfill_state
    WHERE id = ${getSqlLiteral(requestAttemptCloseoutStartupBackfillStateId)}
    LIMIT 1
  `)

  return Boolean(getDateValue(row?.completedAt))
}

const recordRequestAttemptCloseoutBackfillCompleted = async ({
  result,
  runner,
}: {
  result: RequestAttemptCloseoutRebuildResult
  runner: RequestAttemptCloseoutRunner
}): Promise<void> => {
  await runner.run(`
    INSERT INTO app.request_attempt_closeout_backfill_state (
      id,
      high_water_created_at,
      high_water_token_use_id,
      scanned,
      attempted,
      projected,
      batches,
      completed_at,
      updated_at
    ) VALUES (
      ${getSqlLiteral(requestAttemptCloseoutStartupBackfillStateId)},
      ${result.highWaterMark ? getTimestampSqlLiteral(result.highWaterMark.createdAt) : 'NULL'},
      ${getSqlLiteral(result.highWaterMark?.id ?? null)},
      ${getSqlLiteral(result.scanned)},
      ${getSqlLiteral(result.attempted)},
      ${getSqlLiteral(result.projected)},
      ${getSqlLiteral(result.batches)},
      current_timestamp,
      current_timestamp
    )
    ON CONFLICT(id) DO UPDATE SET
      high_water_created_at = EXCLUDED.high_water_created_at,
      high_water_token_use_id = EXCLUDED.high_water_token_use_id,
      scanned = EXCLUDED.scanned,
      attempted = EXCLUDED.attempted,
      projected = EXCLUDED.projected,
      batches = EXCLUDED.batches,
      completed_at = EXCLUDED.completed_at,
      updated_at = EXCLUDED.updated_at
  `)
}

const upsertRequestAttemptCloseoutRowsIntoTable = async ({
  rows,
  runner,
  targetTableName,
}: {
  rows: RequestAttemptCloseoutWriteRow[]
  runner: RequestAttemptCloseoutRunner
  targetTableName: string
}): Promise<RequestAttemptCloseoutProjectionResult> => {
  const earliestRows = getEarliestRequestAttemptCloseoutRows(rows)

  if (earliestRows.length > 0) {
    await runner.run(getUpsertRequestAttemptCloseoutRowsSql({rows: earliestRows, targetTableName}))
  }

  return {attempted: rows.length, projected: earliestRows.length}
}

export const upsertRequestAttemptCloseoutRows = async ({
  rows,
  runner,
}: {
  rows: RequestAttemptCloseoutWriteRow[]
  runner: RequestAttemptCloseoutRunner
}): Promise<RequestAttemptCloseoutProjectionResult> => {
  return upsertRequestAttemptCloseoutRowsIntoTable({rows, runner, targetTableName: 'app.request_attempt_closeout'})
}

export const projectRequestAttemptCloseoutsForTokenUse = async ({
  runner,
  tokenUse,
}: {
  runner: RequestAttemptCloseoutRunner
  tokenUse: RequestAttemptCloseoutTokenUseInput
}): Promise<RequestAttemptCloseoutProjectionResult> => {
  return upsertRequestAttemptCloseoutRows({rows: getRequestAttemptCloseoutWriteRows(tokenUse), runner})
}

export const rebuildRequestAttemptCloseouts = async (
  input: RequestAttemptCloseoutRebuildInput,
): Promise<RequestAttemptCloseoutRebuildResult> => {
  return input.mode === 'maintenance'
    ? rebuildRequestAttemptCloseoutsForMaintenance(input)
    : rebuildRequestAttemptCloseoutsOnline(input)
}

export const backfillRequestAttemptCloseoutsOnStartup = async ({
  batchSize,
  runner = getAppDatabaseService() as RequestAttemptCloseoutDatabaseRunner,
}: {
  batchSize?: number
  runner?: RequestAttemptCloseoutDatabaseRunner
} = {}): Promise<RequestAttemptCloseoutStartupBackfillResult> => {
  if (await getRequestAttemptCloseoutBackfillCompleted(runner)) {
    return getSkippedRequestAttemptCloseoutStartupBackfillResult()
  }

  const result = await rebuildRequestAttemptCloseoutsOnline({batchSize, mode: 'online', runner})

  await recordRequestAttemptCloseoutBackfillCompleted({result, runner})

  return {...result, skipped: false}
}
