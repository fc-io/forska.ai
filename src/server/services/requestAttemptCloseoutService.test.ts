import {rmSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  rmSync(filePath, {force: true, recursive: true})
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

test('request attempt closeout projection is idempotent and preserves earliest source tuple on later conflict', () => {
  const duckdbPath = `/tmp/f1-request-attempt-closeout-service-${Date.now()}.duckdb`
  const runResult = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {projectRequestAttemptCloseoutsForTokenUse} = await import('./src/server/services/requestAttemptCloseoutService.ts')

        const parseJsonValue = (value) => {
          return typeof value === 'string' ? parseJsonValue(JSON.parse(value)) : value
        }
        const getRows = async (db) => {
          return db.queryJson(\`
            SELECT
              token_use_id AS tokenUseId,
              request_attempt_id AS requestAttemptId,
              provider_key AS providerKey,
              closeout_kind AS closeoutKind,
              durable_closeout_kind AS durableCloseoutKind,
              durable_closeout_id AS durableCloseoutId,
              TO_JSON(durable_closeout_ref_json) AS durableCloseoutRefJson,
              epoch_ms(closed_at) AS closedAtMs,
              CAST(updated_at AS VARCHAR) AS updatedAt
            FROM app.request_attempt_closeout
            ORDER BY request_attempt_id
          \`)
        }
        const getSourceRef = (row) => {
          return parseJsonValue(row.durableCloseoutRefJson)
        }
        const providerKey = 'provider:openai:default'
        const idempotentSourceRef = {id: 'source-ref-a', kind: 'token_use', jobId: 'job-a', queueRecordId: 'queue-a'}
        const idempotentAttempt = {
          closeoutKind: 'token_use',
          durableCloseoutRef: idempotentSourceRef,
          finishedAt: '2026-05-03T12:00:05.000Z',
          lifecycleState: 'completedRequest',
          outcome: 'success',
          providerKey,
          requestAttemptId: 'attempt-idempotent',
        }
        const nonTerminalAttempt = {
          closeoutKind: 'persistence',
          finishedAt: '2026-05-03T12:00:06.000Z',
          lifecycleState: 'persistingCompletion',
          outcome: 'success',
          providerKey,
          requestAttemptId: 'attempt-non-terminal',
        }
        const conflictEarlySourceRef = {id: 'source-ref-earliest', kind: 'token_use', jobId: 'job-conflict'}
        const conflictLaterSourceRef = {
          id: 'source-ref-later',
          kind: 'token_use',
          jobId: 'job-conflict',
          requestAttemptId: 'attempt-conflict',
        }
        const conflictEarlyAttempt = {
          closeoutKind: 'token_use',
          durableCloseoutRef: conflictEarlySourceRef,
          finishedAt: '2026-05-03T12:00:05.000Z',
          lifecycleState: 'completedRequest',
          outcome: 'success',
          providerKey,
          requestAttemptId: 'attempt-conflict',
        }
        const conflictLaterAttempt = {
          ...conflictEarlyAttempt,
          durableCloseoutRef: conflictLaterSourceRef,
          finishedAt: '2026-05-03T12:00:06.000Z',
        }

        await migrateDuckdb()
        const db = getAppDatabaseService()
        const missingResult = await projectRequestAttemptCloseoutsForTokenUse({
          runner: db,
          tokenUse: {
            requestAttemptsJson: null,
            tokenUseCreatedAt: '2026-05-03T12:00:01.000Z',
            tokenUseId: 'token-use-missing',
          },
        })

        await db.transaction(async (tx) => {
          await projectRequestAttemptCloseoutsForTokenUse({
            runner: tx,
            tokenUse: {
              requestAttemptsJson: JSON.stringify([idempotentAttempt, nonTerminalAttempt]),
              tokenUseCreatedAt: '2026-05-03T12:00:01.000Z',
              tokenUseFinishedAt: '2026-05-03T12:00:04.000Z',
              tokenUseId: 'token-use-idempotent',
              tokenUseStartedAt: '2026-05-03T12:00:02.000Z',
            },
          })
          await projectRequestAttemptCloseoutsForTokenUse({
            runner: tx,
            tokenUse: {
              requestAttemptsJson: JSON.stringify([idempotentAttempt, nonTerminalAttempt]),
              tokenUseCreatedAt: '2026-05-03T12:00:01.000Z',
              tokenUseFinishedAt: '2026-05-03T12:00:04.000Z',
              tokenUseId: 'token-use-idempotent',
              tokenUseStartedAt: '2026-05-03T12:00:02.000Z',
            },
          })
        })
        await projectRequestAttemptCloseoutsForTokenUse({
          runner: db,
          tokenUse: {
            requestAttemptsJson: JSON.stringify([conflictEarlyAttempt]),
            tokenUseCreatedAt: '2026-05-03T12:00:01.000Z',
            tokenUseId: 'token-use-conflict-earliest',
          },
        })
        const rowsAfterEarlyConflict = await getRows(db)
        const conflictRowAfterEarly = rowsAfterEarlyConflict.find((row) => {
          return row.requestAttemptId === 'attempt-conflict'
        })

        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
        await projectRequestAttemptCloseoutsForTokenUse({
          runner: db,
          tokenUse: {
            requestAttemptsJson: JSON.stringify([conflictLaterAttempt]),
            tokenUseCreatedAt: '2026-05-03T12:00:01.000Z',
            tokenUseId: 'token-use-conflict-later',
          },
        })

        const rows = await getRows(db)
        const idempotentRow = rows.find((row) => {
          return row.requestAttemptId === 'attempt-idempotent'
        })
        const conflictRow = rows.find((row) => {
          return row.requestAttemptId === 'attempt-conflict'
        })

        console.log(
          JSON.stringify({
            conflictRow,
            conflictRowAfterEarly,
            conflictSourceRef: conflictRow ? getSourceRef(conflictRow) : null,
            idempotentRow,
            idempotentSourceRef: idempotentRow ? getSourceRef(idempotentRow) : null,
            missingResult,
            rowCount: rows.length,
          }),
        )
        await db.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '3001',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '3000',
      },
    },
  )

  try {
    if (runResult.exitCode !== 0) {
      throw new Error(
        runResult.stderr.toString() || runResult.stdout.toString() || 'request attempt closeout service test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runResult.stdout.toString())) as {
      conflictRow: {closedAtMs: number | string; tokenUseId: string; updatedAt: string} | null
      conflictRowAfterEarly: {updatedAt: string} | null
      conflictSourceRef: unknown
      idempotentRow: {tokenUseId: string} | null
      idempotentSourceRef: unknown
      missingResult: {attempted: number; projected: number}
      rowCount: number
    }

    expect(result.missingResult).toEqual({attempted: 0, projected: 0})
    expect(result.rowCount).toBe(2)
    expect(result.idempotentRow?.tokenUseId).toBe('token-use-idempotent')
    expect(result.idempotentSourceRef).toEqual({
      id: 'source-ref-a',
      jobId: 'job-a',
      kind: 'token_use',
      queueRecordId: 'queue-a',
    })
    expect(result.conflictRow?.tokenUseId).toBe('token-use-conflict-earliest')
    expect(Number(result.conflictRow?.closedAtMs)).toBe(new Date('2026-05-03T12:00:05.000Z').getTime())
    expect(result.conflictSourceRef).toEqual({id: 'source-ref-earliest', jobId: 'job-conflict', kind: 'token_use'})
    expect(new Date(result.conflictRow?.updatedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(result.conflictRowAfterEarly?.updatedAt ?? 0).getTime(),
    )
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
