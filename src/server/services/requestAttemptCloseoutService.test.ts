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

test('maintenance rebuild truncates and rebuilds request attempt closeouts in bounded token-use batches', () => {
  const duckdbPath = `/tmp/f1-request-attempt-closeout-maintenance-rebuild-${Date.now()}.duckdb`
  const runResult = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {rebuildRequestAttemptCloseouts} = await import('./src/server/services/requestAttemptCloseoutService.ts')

        const quote = (value) => {
          return "'" + String(value).replaceAll("'", "''") + "'"
        }
        const timestampLiteral = (value) => {
          return 'TIMESTAMPTZ ' + quote(value)
        }
        const jsonLiteral = (value) => {
          return 'CAST(' + quote(JSON.stringify(value)) + ' AS JSON)'
        }
        const nullableJsonLiteral = (value) => {
          return value === null ? 'NULL' : jsonLiteral(value)
        }
        const getAttempt = ({durableId, finishedAt, requestAttemptId}) => {
          return {
            closeoutKind: 'token_use',
            durableCloseoutRef: {id: durableId, kind: 'token_use', jobId: 'job-maintenance-rebuild'},
            finishedAt,
            lifecycleState: 'completedRequest',
            outcome: 'success',
            providerKey: 'provider:maintenance-rebuild',
            requestAttemptId,
          }
        }
        const getInsertTokenUseSql = ({createdAt, finishedAt, id, requestAttempts, startedAt}) => {
          return [
            'INSERT INTO app.token_use (',
            'id, requests, total_prompt_tokens, total_completion_tokens, total_tokens, ',
            'started_at, finished_at, created_at, request_attempts_json',
            ') VALUES (',
            quote(id),
            ', 1, 1, 1, 1, ',
            timestampLiteral(startedAt),
            ', ',
            timestampLiteral(finishedAt),
            ', ',
            timestampLiteral(createdAt),
            ', ',
            nullableJsonLiteral(requestAttempts),
            ')',
          ].join('')
        }
        const insertTokenUse = async (input) => {
          await db.run(getInsertTokenUseSql(input))
        }

        await migrateDuckdb()
        const db = getAppDatabaseService()
        await insertTokenUse({
          createdAt: '2026-05-01T00:00:00.000Z',
          finishedAt: '2026-05-01T00:00:03.000Z',
          id: 'token-use-maintenance-a',
          requestAttempts: [getAttempt({
            durableId: 'durable-maintenance-a',
            finishedAt: '2026-05-01T00:00:05.000Z',
            requestAttemptId: 'attempt-maintenance-shared',
          })],
          startedAt: '2026-05-01T00:00:01.000Z',
        })
        await insertTokenUse({
          createdAt: '2026-05-01T00:00:00.000Z',
          finishedAt: '2026-05-01T00:00:04.000Z',
          id: 'token-use-maintenance-b',
          requestAttempts: [getAttempt({
            durableId: 'durable-maintenance-b',
            finishedAt: '2026-05-01T00:00:04.000Z',
            requestAttemptId: 'attempt-maintenance-b',
          })],
          startedAt: '2026-05-01T00:00:02.000Z',
        })
        await insertTokenUse({
          createdAt: '2026-05-01T00:00:01.000Z',
          finishedAt: '2026-05-01T00:00:07.000Z',
          id: 'token-use-maintenance-c',
          requestAttempts: [getAttempt({
            durableId: 'durable-maintenance-c',
            finishedAt: '2026-05-01T00:00:06.000Z',
            requestAttemptId: 'attempt-maintenance-shared',
          })],
          startedAt: '2026-05-01T00:00:03.000Z',
        })
        await insertTokenUse({
          createdAt: '2026-05-01T00:00:02.000Z',
          finishedAt: '2026-05-01T00:00:08.000Z',
          id: 'token-use-maintenance-empty',
          requestAttempts: null,
          startedAt: '2026-05-01T00:00:04.000Z',
        })
        await db.run(
          [
            'INSERT INTO app.request_attempt_closeout (',
            'token_use_id, token_use_created_at, request_attempt_id, provider_key, closeout_kind, ',
            'durable_closeout_kind, durable_closeout_id, durable_closeout_ref_json, closed_at',
            ') VALUES (',
            quote('stale-token-use'),
            ', ',
            timestampLiteral('2026-04-30T00:00:00.000Z'),
            ', ',
            quote('attempt-stale'),
            ', ',
            quote('provider:maintenance-rebuild'),
            ', ',
            quote('token_use'),
            ', ',
            quote('token_use'),
            ', ',
            quote('durable-stale'),
            ', ',
            jsonLiteral({id: 'durable-stale', kind: 'token_use'}),
            ', ',
            timestampLiteral('2026-04-30T00:00:01.000Z'),
            ')',
          ].join(''),
        )

        const result = await rebuildRequestAttemptCloseouts({
          batchSize: 2,
          cleanupDisabled: true,
          mode: 'maintenance',
          tokenUseWritersStopped: true,
        })
        const rows = await db.queryJson(\`
          SELECT
            request_attempt_id AS requestAttemptId,
            token_use_id AS tokenUseId,
            durable_closeout_id AS durableCloseoutId,
            epoch_ms(closed_at) AS closedAtMs
          FROM app.request_attempt_closeout
          ORDER BY request_attempt_id
        \`)

        console.log(JSON.stringify({result, rows}))
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
        runResult.stderr.toString() || runResult.stdout.toString() || 'maintenance closeout rebuild test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runResult.stdout.toString())) as {
      result: {
        attempted: number
        batches: number
        highWaterMark: unknown
        mode: string
        projected: number
        scanned: number
      }
      rows: Array<{
        closedAtMs: number | string
        durableCloseoutId: string
        requestAttemptId: string
        tokenUseId: string
      }>
    }

    expect(result.result).toEqual({
      attempted: 3,
      batches: 2,
      highWaterMark: null,
      mode: 'maintenance',
      projected: 2,
      scanned: 4,
    })
    expect(result.rows).toHaveLength(2)
    expect(
      result.rows.map((row) => {
        return row.requestAttemptId
      }),
    ).toEqual(['attempt-maintenance-b', 'attempt-maintenance-shared'])
    expect(
      result.rows.find((row) => {
        return row.requestAttemptId === 'attempt-maintenance-shared'
      })?.tokenUseId,
    ).toBe('token-use-maintenance-a')
    expect(
      result.rows.find((row) => {
        return row.requestAttemptId === 'attempt-maintenance-b'
      })?.durableCloseoutId,
    ).toBe('durable-maintenance-b')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})

test('online rebuild stages to a high-water mark and preserves live writer closeout rows during merge', () => {
  const duckdbPath = `/tmp/f1-request-attempt-closeout-online-rebuild-${Date.now()}.duckdb`
  const runResult = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {
          projectRequestAttemptCloseoutsForTokenUse,
          rebuildRequestAttemptCloseouts,
        } = await import('./src/server/services/requestAttemptCloseoutService.ts')

        const quote = (value) => {
          return "'" + String(value).replaceAll("'", "''") + "'"
        }
        const timestampLiteral = (value) => {
          return 'TIMESTAMPTZ ' + quote(value)
        }
        const jsonLiteral = (value) => {
          return 'CAST(' + quote(JSON.stringify(value)) + ' AS JSON)'
        }
        const getAttempt = ({durableId, finishedAt, providerKey, requestAttemptId}) => {
          return {
            closeoutKind: 'token_use',
            durableCloseoutRef: {id: durableId, kind: 'token_use', jobId: 'job-online-rebuild'},
            finishedAt,
            lifecycleState: 'completedRequest',
            outcome: 'success',
            providerKey,
            requestAttemptId,
          }
        }
        const getInsertTokenUseSql = ({createdAt, finishedAt, id, requestAttempts, startedAt}) => {
          return [
            'INSERT INTO app.token_use (',
            'id, requests, total_prompt_tokens, total_completion_tokens, total_tokens, ',
            'started_at, finished_at, created_at, request_attempts_json',
            ') VALUES (',
            quote(id),
            ', 1, 1, 1, 1, ',
            timestampLiteral(startedAt),
            ', ',
            timestampLiteral(finishedAt),
            ', ',
            timestampLiteral(createdAt),
            ', ',
            jsonLiteral(requestAttempts),
            ')',
          ].join('')
        }
        const insertTokenUse = async (input) => {
          await db.run(getInsertTokenUseSql(input))
        }
        const providerKey = 'provider:online-rebuild'
        const stagedConflictAttempt = getAttempt({
          durableId: 'durable-online-staged-conflict',
          finishedAt: '2026-05-02T12:00:20.000Z',
          providerKey,
          requestAttemptId: 'attempt-online-conflict',
        })
        const stagedOnlyAttempt = getAttempt({
          durableId: 'durable-online-staged-only',
          finishedAt: '2026-05-02T12:00:30.000Z',
          providerKey,
          requestAttemptId: 'attempt-online-staged-only',
        })
        const liveConflictAttempt = getAttempt({
          durableId: 'durable-online-live-conflict',
          finishedAt: '2026-05-02T12:00:10.000Z',
          providerKey,
          requestAttemptId: 'attempt-online-conflict',
        })
        const liveOnlyAttempt = getAttempt({
          durableId: 'durable-online-live-only',
          finishedAt: '2026-05-02T12:05:10.000Z',
          providerKey,
          requestAttemptId: 'attempt-online-live-only',
        })

        await migrateDuckdb()
        const db = getAppDatabaseService()
        await insertTokenUse({
          createdAt: '2026-05-02T12:00:00.000Z',
          finishedAt: '2026-05-02T12:00:21.000Z',
          id: 'token-use-online-old',
          requestAttempts: [stagedConflictAttempt],
          startedAt: '2026-05-02T12:00:01.000Z',
        })
        await insertTokenUse({
          createdAt: '2026-05-02T12:00:01.000Z',
          finishedAt: '2026-05-02T12:00:31.000Z',
          id: 'token-use-online-stage',
          requestAttempts: [stagedOnlyAttempt],
          startedAt: '2026-05-02T12:00:02.000Z',
        })

        let highWaterCaptured = false
        let writerInserted = false
        const writerAttempts = [liveConflictAttempt, liveOnlyAttempt]
        const runner = {
          queryJson: async (statement) => {
            const rows = await db.queryJson(statement)

            if (statement.includes('ORDER BY created_at DESC, id DESC')) {
              highWaterCaptured = true
            }

            return rows
          },
          run: async (statement) => {
            if (highWaterCaptured && !writerInserted && statement.includes('INSERT INTO app.request_attempt_closeout')) {
              writerInserted = true
              await insertTokenUse({
                createdAt: '2026-05-02T12:05:00.000Z',
                finishedAt: '2026-05-02T12:05:11.000Z',
                id: 'token-use-online-live',
                requestAttempts: writerAttempts,
                startedAt: '2026-05-02T12:05:01.000Z',
              })
              await projectRequestAttemptCloseoutsForTokenUse({
                runner: db,
                tokenUse: {
                  requestAttemptsJson: JSON.stringify(writerAttempts),
                  tokenUseCreatedAt: '2026-05-02T12:05:00.000Z',
                  tokenUseFinishedAt: '2026-05-02T12:05:11.000Z',
                  tokenUseId: 'token-use-online-live',
                  tokenUseStartedAt: '2026-05-02T12:05:01.000Z',
                },
              })
            }

            await db.run(statement)
          },
        }

        const result = await rebuildRequestAttemptCloseouts({batchSize: 1, mode: 'online', runner})
        const rows = await db.queryJson(\`
          SELECT
            request_attempt_id AS requestAttemptId,
            token_use_id AS tokenUseId,
            durable_closeout_id AS durableCloseoutId,
            epoch_ms(closed_at) AS closedAtMs
          FROM app.request_attempt_closeout
          ORDER BY request_attempt_id
        \`)

        console.log(JSON.stringify({result, rows, writerInserted}))
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
        runResult.stderr.toString() || runResult.stdout.toString() || 'online closeout rebuild test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runResult.stdout.toString())) as {
      result: {
        attempted: number
        batches: number
        highWaterMark: {createdAt: string; id: string} | null
        mode: string
        projected: number
        scanned: number
      }
      rows: Array<{
        closedAtMs: number | string
        durableCloseoutId: string
        requestAttemptId: string
        tokenUseId: string
      }>
      writerInserted: boolean
    }
    const conflictRow = result.rows.find((row) => {
      return row.requestAttemptId === 'attempt-online-conflict'
    })
    const liveOnlyRow = result.rows.find((row) => {
      return row.requestAttemptId === 'attempt-online-live-only'
    })
    const stagedOnlyRow = result.rows.find((row) => {
      return row.requestAttemptId === 'attempt-online-staged-only'
    })

    expect(result.writerInserted).toBe(true)
    expect(result.result).toEqual({
      attempted: 2,
      batches: 2,
      highWaterMark: {createdAt: '2026-05-02T12:00:01.000Z', id: 'token-use-online-stage'},
      mode: 'online',
      projected: 2,
      scanned: 2,
    })
    expect(result.rows).toHaveLength(3)
    expect(conflictRow?.tokenUseId).toBe('token-use-online-live')
    expect(conflictRow?.durableCloseoutId).toBe('durable-online-live-conflict')
    expect(Number(conflictRow?.closedAtMs)).toBe(new Date('2026-05-02T12:00:10.000Z').getTime())
    expect(liveOnlyRow?.tokenUseId).toBe('token-use-online-live')
    expect(stagedOnlyRow?.tokenUseId).toBe('token-use-online-stage')
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
