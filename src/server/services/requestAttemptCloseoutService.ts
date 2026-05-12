import {
  getDurableTerminalRequestAttemptCloseoutProjectionRows,
  type JudgmentRequestAttemptCloseoutProjectionInput,
  type JudgmentRequestAttemptCloseoutProjectionRow,
  type JudgmentRequestAttemptJsonEntry,
  parseRequestAttempts,
} from '../cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'
import {getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

export type RequestAttemptCloseoutRunner = {run: (statement: string) => Promise<void>}

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

const getUpsertRequestAttemptCloseoutRowsSql = (rows: RequestAttemptCloseoutWriteRow[]): string => {
  return `
    INSERT INTO app.request_attempt_closeout (
      token_use_id,
      token_use_created_at,
      request_attempt_id,
      provider_key,
      closeout_kind,
      durable_closeout_kind,
      durable_closeout_id,
      durable_closeout_ref_json,
      closed_at
    )
    VALUES ${rows.map(getRequestAttemptCloseoutValuesSql).join(', ')}
    ON CONFLICT(request_attempt_id, provider_key) DO UPDATE SET
      token_use_id = ${getRequestAttemptCloseoutCaseSql('token_use_id')},
      token_use_created_at = ${getRequestAttemptCloseoutCaseSql('token_use_created_at')},
      closeout_kind = ${getRequestAttemptCloseoutCaseSql('closeout_kind')},
      durable_closeout_kind = ${getRequestAttemptCloseoutCaseSql('durable_closeout_kind')},
      durable_closeout_id = ${getRequestAttemptCloseoutCaseSql('durable_closeout_id')},
      durable_closeout_ref_json = ${getRequestAttemptCloseoutCaseSql('durable_closeout_ref_json')},
      closed_at = ${getRequestAttemptCloseoutCaseSql('closed_at')},
      updated_at = now()
  `
}

export const upsertRequestAttemptCloseoutRows = async ({
  rows,
  runner,
}: {
  rows: RequestAttemptCloseoutWriteRow[]
  runner: RequestAttemptCloseoutRunner
}): Promise<RequestAttemptCloseoutProjectionResult> => {
  const earliestRows = getEarliestRequestAttemptCloseoutRows(rows)

  if (earliestRows.length > 0) {
    await runner.run(getUpsertRequestAttemptCloseoutRowsSql(earliestRows))
  }

  return {attempted: rows.length, projected: earliestRows.length}
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
