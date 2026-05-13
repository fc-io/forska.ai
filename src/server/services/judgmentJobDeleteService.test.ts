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

test('deleteJudgmentJobSafelyTx removes request attempt closeouts before rebuilding token_use rows', () => {
  const duckdbPath = `/tmp/f1-judgment-job-delete-service-${Date.now()}.duckdb`
  const runResult = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {deleteJudgmentJobSafelyTx} = await import('./src/server/services/judgmentJobDeleteService.ts')
        const {insertJudgmentProviderTelemetryHistorySample} = await import('./src/server/services/judgmentProviderTelemetryHistoryService.ts')

        await migrateDuckdb()
        const db = getAppDatabaseService()
        await db.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('delete-service-connection', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await db.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('delete-service-model', 'delete-service-connection', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await db.run(\`
          INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
          VALUES ('delete-service-project', 'Delete Service Project', 'delete-service-model', TRUE, TRUE, FALSE, FALSE)
        \`)
        await db.run(\`
          INSERT INTO app.judgment_job (id, project_id, status)
          VALUES ('delete-service-job', 'delete-service-project', 'failed')
        \`)
        await db.run(\`
          INSERT INTO app.token_use (id, judgment_job_id, requests, total_prompt_tokens, total_completion_tokens, total_tokens)
          VALUES ('delete-service-token', 'delete-service-job', 1, 10, 5, 15)
        \`)
        await insertJudgmentProviderTelemetryHistorySample({
          sample: {
            aggregateCompleteness: 'complete',
            bottleneck: null,
            bottleneckSource: null,
            bottleneckSubreason: null,
            effectiveProviderLimit: 12,
            freshWorkerCount: 1,
            jobId: 'delete-service-job',
            normalRequestCapacity: 10,
            projectId: 'delete-service-project',
            providerAllocationVersion: 'allocation-v1',
            providerAvailableRequestLeases: 5,
            providerKey: 'provider-delete-service',
            providerLeasedLiveRequests: 5,
            providerLeasedPhysicalCalls: 5,
            providerLeasedProbeCalls: 0,
            providerLimit: 12,
            providerLimitVersion: 'limit-v1',
            providerProbeOccupancyVersion: 'probe-v1',
            providerRequestFillPct: null,
            sampledAt: new Date('2026-05-12T12:00:05.000Z'),
            staleWorkerCount: 0,
            targetRequestLiveCalls: 10,
            unavailableWorkerCount: 0,
            unallocatedTargetLiveCalls: 0,
          },
        })
        await db.run(\`
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
          VALUES (
            'delete-service-token',
            TIMESTAMPTZ '2026-01-01T00:00:00Z',
            'delete-service-request-attempt',
            'delete-service-provider',
            'token_use',
            'token_use',
            'delete-service-token',
            '{"id":"delete-service-token","kind":"token_use"}'::JSON,
            TIMESTAMPTZ '2026-01-01T00:00:01Z'
          )
        \`)

        const orderSnapshots = []
        const projectionDeleteStatements = []
        await db.transaction(async (tx) => {
          const tracingTx = {
            queryJson: async (statement) => {
              return tx.queryJson(statement)
            },
            run: async (statement) => {
              if (statement.includes('DELETE FROM app.request_attempt_closeout')) {
                projectionDeleteStatements.push(statement)
                await tx.run(statement)
                const [snapshot] = await tx.queryJson(\`
                  SELECT
                    'afterProjectionDelete' AS point,
                    (SELECT COUNT(*) FROM app.request_attempt_closeout)::INTEGER AS closeoutRows,
                    (SELECT COUNT(*) FROM app.token_use WHERE id = 'delete-service-token')::INTEGER AS tokenUseRows
                \`)
                orderSnapshots.push(snapshot)
                return
              }

              if (statement.trim() === 'DROP TABLE app.token_use') {
                const [snapshot] = await tx.queryJson(\`
                  SELECT
                    'beforeTokenUseDrop' AS point,
                    (SELECT COUNT(*) FROM app.request_attempt_closeout)::INTEGER AS closeoutRows,
                    (SELECT COUNT(*) FROM app.token_use WHERE id = 'delete-service-token')::INTEGER AS tokenUseRows
                \`)
                orderSnapshots.push(snapshot)
              }

              await tx.run(statement)
            },
          }

          await deleteJudgmentJobSafelyTx({jobId: 'delete-service-job', tx: tracingTx})
        })

        const [finalSnapshot] = await db.queryJson(\`
          SELECT
            (SELECT COUNT(*) FROM app.judgment_job WHERE id = 'delete-service-job')::INTEGER AS jobs,
            (SELECT COUNT(*) FROM app.request_attempt_closeout WHERE token_use_id = 'delete-service-token')::INTEGER AS closeouts,
            (SELECT COUNT(*) FROM app.judgment_job_provider_telemetry_sample WHERE job_id = 'delete-service-job')::INTEGER AS telemetrySamples,
            (SELECT COUNT(*) FROM app.token_use WHERE judgment_job_id = 'delete-service-job')::INTEGER AS tokens
        \`)
        console.log(JSON.stringify({
          finalSnapshot,
          orderSnapshots,
          projectionDeleteSql: projectionDeleteStatements[0] ?? ''
        }))
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
        runResult.stderr.toString() || runResult.stdout.toString() || 'judgment job delete service test failed',
      )
    }

    const result = JSON.parse(getLastJsonLine(runResult.stdout.toString())) as {
      finalSnapshot: {
        closeouts: number | string
        jobs: number | string
        telemetrySamples: number | string
        tokens: number | string
      }
      orderSnapshots: Array<{closeoutRows: number | string; point: string; tokenUseRows: number | string}>
      projectionDeleteSql: string
    }
    expect(result.projectionDeleteSql).toContain('DELETE FROM app.request_attempt_closeout')
    expect(result.projectionDeleteSql).toContain('token_use_id IN')
    expect(result.projectionDeleteSql).toContain('SELECT id')
    expect(result.projectionDeleteSql).toContain('FROM app.token_use')
    expect(result.projectionDeleteSql).toContain("WHERE judgment_job_id = 'delete-service-job'")
    expect(result.orderSnapshots).toEqual([
      {closeoutRows: 0, point: 'afterProjectionDelete', tokenUseRows: 1},
      {closeoutRows: 0, point: 'beforeTokenUseDrop', tokenUseRows: 1},
    ])
    expect(result.finalSnapshot).toEqual({closeouts: 0, jobs: 0, telemetrySamples: 0, tokens: 0})
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
