import {existsSync, mkdirSync, rmSync} from 'node:fs'
import {dirname} from 'node:path'

export const projectRoot = process.cwd()

export const defaultLargeRebuildCommandTestEnv = {
  ...process.env,
  API_SERVER_PORT: '39107',
  RUN_SERVER_FULL_TEXT_CONVERSION_CRON: 'false',
  RUN_SERVER_FULL_TEXT_FETCHING: 'false',
  SERVER_DUCKDB_OWNER_URL: '',
  SERVER_ROLE: 'maintenance-worker',
  VITE_PORT: '39917',
}

export const getLastJsonLine = (output: string) => {
  const [lastLine = ''] = output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return (line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))
    })
    .slice(-1)

  if (lastLine === '') {
    throw new Error(`Expected JSON output but received: ${output}`)
  }

  return lastLine
}

const removePathIfExists = (path: string) => {
  if (existsSync(path)) {
    rmSync(path, {force: true, recursive: true})
  }
}

const prepareDuckdbPath = (duckdbPath: string) => {
  mkdirSync(dirname(duckdbPath), {recursive: true})
  removePathIfExists(duckdbPath)
  removePathIfExists(`${duckdbPath}.wal`)
}

const getProjectSeedSql = (projects: Array<{archived?: boolean; projectId: string}>) => {
  return projects
    .map((project) => {
      const archivedSql = project.archived === true ? 'TRUE' : 'FALSE'

      return `
        INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
        VALUES ('connection-${project.projectId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1');

        INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
        VALUES (
          'model-${project.projectId}',
          'connection-${project.projectId}',
          'Qwen/Qwen3.5-35B-A3B',
          'Qwen/Qwen3.5-35B-A3B',
          'Qwen 35B',
          'manual',
          TRUE
        );

        INSERT INTO app.project (id, name, archived, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
        VALUES (
          '${project.projectId}',
          'Project ${project.projectId}',
          ${archivedSql},
          'model-${project.projectId}',
          TRUE,
          TRUE,
          FALSE,
          FALSE
        );
      `
    })
    .join('\n')
}

export const migrateLargeRebuildCommandDatabase = (duckdbPath: string) => {
  prepareDuckdbPath(duckdbPath)

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        await migrateDuckdb()
        await getAppDatabaseService().close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'command database migration failed')
  }
}

export const seedLargeRebuildCommandProjectDatabase = ({
  duckdbPath,
  projects,
}: {
  duckdbPath: string
  projects: Array<{archived?: boolean; projectId: string}>
}) => {
  prepareDuckdbPath(duckdbPath)

  const result = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
        const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')

        await migrateDuckdb()
        const database = getAppDatabaseService()
        await database.run(${JSON.stringify(getProjectSeedSql(projects))})
        await database.close()
      `,
    ],
    {cwd: projectRoot, env: {...defaultLargeRebuildCommandTestEnv, DUCKDB_PATH: duckdbPath}},
  )

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || 'command project seed failed')
  }
}
