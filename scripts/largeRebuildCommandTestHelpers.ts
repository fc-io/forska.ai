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

const rebuildSeedComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
  'search',
] as const

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

const getSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getRebuildComponentStateJson = (projectId: string) => {
  return JSON.stringify({
    optional: [],
    required: rebuildSeedComponents.map((component) => {
      return {baseGeneration: 1, component, patchWatermark: 1, projectionIdentity: `${component}:${projectId}`}
    }),
  })
}

const getProjectRebuildSeedSql = (project: {projectId: string; skipRebuildSeed?: boolean}) => {
  const componentStateJson = getRebuildComponentStateJson(project.projectId)
  const articleId = `article-${project.projectId}`
  const projectionManifestSql = rebuildSeedComponents
    .map((component) => {
      return `
        INSERT INTO app.review_projection_identity_manifest (
          manifest_id,
          project_id,
          projection_component,
          projection_identity,
          base_generation,
          patch_watermark,
          input_watermark,
          input_digest,
          definition_version,
          status
        ) VALUES (
          ${getSqlString(`${component}-manifest-${project.projectId}`)},
          ${getSqlString(project.projectId)},
          ${getSqlString(component)},
          ${getSqlString(`${component}:${project.projectId}`)},
          1,
          1,
          1,
          ${getSqlString(`${component}-digest-${project.projectId}`)},
          ${getSqlString(`${component}:v1`)},
          'active'
        );
      `
    })
    .join('\n')

  return project.skipRebuildSeed
    ? ''
    : `
        INSERT INTO app.article (id, article_title, article_created_at)
        VALUES (${getSqlString(articleId)}, ${getSqlString(`Article ${project.projectId}`)}, TIMESTAMPTZ '2026-06-20T00:00:00.000Z');

        INSERT INTO app.project_article (id, project_id, article_id)
        VALUES (${getSqlString(`project-article-${project.projectId}`)}, ${getSqlString(project.projectId)}, ${getSqlString(articleId)});

        ${projectionManifestSql}

        INSERT INTO app.review_serving_snapshot_manifest (
          project_id,
          snapshot_id,
          snapshot_status,
          review_config_hash,
          composed_identity_json,
          component_state_json,
          required_components_json,
          optional_components_json,
          source_watermarks_json,
          selected_import_snapshot_id,
          activated_at
        ) VALUES (
          ${getSqlString(project.projectId)},
          ${getSqlString(`snapshot-${project.projectId}`)},
          'active',
          ${getSqlString(`review-config-${project.projectId}`)},
          '{}'::JSON,
          ${getSqlString(componentStateJson)}::JSON,
          ${getSqlString(JSON.stringify(rebuildSeedComponents))}::JSON,
          '[]'::JSON,
          '{}'::JSON,
          ${getSqlString(`selected-import-${project.projectId}`)},
          TIMESTAMPTZ '2026-06-20T00:00:00.000Z'
        );
      `
}

const getProjectSeedSql = (projects: Array<{archived?: boolean; projectId: string; skipRebuildSeed?: boolean}>) => {
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

        ${getProjectRebuildSeedSql(project)}
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
  projects: Array<{archived?: boolean; projectId: string; skipRebuildSeed?: boolean}>
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
