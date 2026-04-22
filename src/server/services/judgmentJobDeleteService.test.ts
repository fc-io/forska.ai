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

test('deleteJudgmentJobSafelyTx removes token_use dependents before deleting the job row', () => {
  const duckdbPath = `/tmp/f1-judgment-job-delete-service-${Date.now()}.duckdb`
  const runResult = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {deleteJudgmentJobSafelyTx} = await import('./src/server/services/judgmentJobDeleteService.ts')

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

        await db.transaction(async (tx) => {
          await deleteJudgmentJobSafelyTx({jobId: 'delete-service-job', tx})
        })

        const jobs = await db.queryJson(\`SELECT COUNT(*) AS count FROM app.judgment_job WHERE id = 'delete-service-job'\`)
        const tokens = await db.queryJson(\`SELECT COUNT(*) AS count FROM app.token_use WHERE judgment_job_id = 'delete-service-job'\`)
        console.log(JSON.stringify({jobs: jobs[0]?.count ?? 0, tokens: tokens[0]?.count ?? 0}))
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
      jobs: number | string
      tokens: number | string
    }
    expect(Number(result.jobs)).toBe(0)
    expect(Number(result.tokens)).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
