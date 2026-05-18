import {existsSync, unlinkSync} from 'node:fs'

import {expect, test} from 'bun:test'

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

test('getOrCreateImmutablePromptTx reuses referenced immutable prompts without updating the parent row', () => {
  const duckdbPath = `/tmp/forska-immutable-prompt-reuse-${Date.now()}.duckdb`
  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const [{getOrCreateImmutablePromptTx}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] = await Promise.all([
          import('./src/server/services/immutablePromptService.ts'),
          import('./src/server/services/appDatabaseService.ts'),
          import('./src/server/utils/duckdbService.ts'),
          import('./src/server/utils/serverRuntimeRole.ts'),
        ])

        resetDuckdbServiceForTests()
        resetServerRuntimeRoleForTests()

        const database = getAppDatabaseService()
        const promptInput = {
          archived: false,
          originalText: 'Shared immutable prompt',
          promptHeading: null,
          transformedText: null,
          type: 'llm',
        }

        await database.run('CREATE SCHEMA app')
        await database.run('CREATE TABLE app.prompt (id VARCHAR PRIMARY KEY, original_text VARCHAR NOT NULL, transformed_text VARCHAR, prompt_heading VARCHAR, type VARCHAR, content_hash VARCHAR, archived BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp, UNIQUE(content_hash))')
        await database.run('CREATE TABLE app.project_prompt (id VARCHAR PRIMARY KEY, prompt_id VARCHAR NOT NULL REFERENCES app.prompt(id))')

        const firstPromptId = await getOrCreateImmutablePromptTx(database, promptInput)
        await database.run("INSERT INTO app.project_prompt (id, prompt_id) VALUES ('project-prompt-1', '" + firstPromptId.replaceAll("'", "''") + "')")
        const secondPromptId = await getOrCreateImmutablePromptTx(database, promptInput)
        const [promptCount] = await database.queryJson('SELECT COUNT(*)::INTEGER AS count FROM app.prompt')

        console.log(JSON.stringify({firstPromptId, promptCount, secondPromptId}))
        await database.close()
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_SERVER_PORT: '39991',
        DUCKDB_PATH: duckdbPath,
        SERVER_ROLE: 'dev-single',
        VITE_PORT: '39992',
      },
    },
  )

  try {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || result.stdout.toString() || 'Failed to verify immutable prompt reuse')
    }

    const stdoutLines = result.stdout
      .toString()
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
    const parsed = JSON.parse(stdoutLines.at(-1) ?? '{}') as {
      firstPromptId: string
      promptCount: {count: number}
      secondPromptId: string
    }

    expect(parsed.firstPromptId).toBe(parsed.secondPromptId)
    expect(parsed.promptCount.count).toBe(1)
  } finally {
    removeFileIfExists(duckdbPath)
    removeFileIfExists(`${duckdbPath}.wal`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.lock`)
    removeFileIfExists(`${duckdbPath}.duckdb-owner.history.json`)
  }
})
