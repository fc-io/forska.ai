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

test('admin append metrics route returns append lane metrics', () => {
  const duckdbPath = `/tmp/f1-admin-append-metrics-route-${Date.now()}.duckdb`
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {Elysia} = await import('elysia')
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
        const {adminInvestigateRoutes} = await import('./src/server/routes/AdminInvestigateRoutes.ts')

        await migrateDuckdb()

        const database = getAppDatabaseService()
        const now = new Date()
        const connectionId = 'connection-route-test'
        const modelId = 'model-route-test'
        const promptId = 'prompt-route-test'
        const articleId = 'article-route-test'

        await database.run(\`
          INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
          VALUES ('\${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
        \`)
        await database.run(\`
          INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
          VALUES ('\${modelId}', '\${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
        \`)
        await database.run(\`
          INSERT INTO app.prompt (id, original_text, content_hash)
          VALUES ('\${promptId}', 'Prompt', 'prompt-route-test-hash')
        \`)
        await database.run(\`
          INSERT INTO app.article (id, article_title)
          VALUES ('\${articleId}', 'Route Test Article')
        \`)
        await database.appendJudgments([
          {
            answeredOriginal: 'yes',
            answeredOriginalAsArray: ['yes'],
            articleId,
            chunkingStrategy: null,
            confidenceOriginal: 50,
            createdAt: now,
            explanation: 'route test',
            id: 'judgment-route-test',
            isAnswered: true,
            modelId,
            projectId: null,
            promptId,
            quotes: ['quote'],
            snapshotProjectId: null,
            snapshotProjectModelName: null,
            updatedAt: now,
            useAbstract: true,
            useFulltext: false,
            useFulltextNoImages: false,
            useTitle: true,
          },
        ])

        const app = new Elysia().use(adminInvestigateRoutes)
        const response = await app.handle(new Request('http://localhost/api/admin/duckdb-append-metrics'))
        console.log(await response.text())
        await database.close()
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
    if (runRoute.exitCode !== 0) {
      throw new Error(
        runRoute.stderr.toString() || runRoute.stdout.toString() || 'Admin append metrics route test failed',
      )
    }

    const responseBody = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
      laneCount: number
      lastInsertedRows: number | null
      queueDepth: number
      rowsAttempted: number
      rowsInserted: number
      rowsSkipped: number
    }

    expect(responseBody.laneCount).toBe(2)
    expect(responseBody.lastInsertedRows).toBe(1)
    expect(responseBody.queueDepth).toBe(0)
    expect(responseBody.rowsAttempted).toBe(1)
    expect(responseBody.rowsInserted).toBe(1)
    expect(responseBody.rowsSkipped).toBe(0)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.writer.lock`)
    removeFileIfExists(`${duckdbPath}.writer.history.json`)
  }
})
