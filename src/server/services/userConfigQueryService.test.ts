import {afterAll, beforeAll, expect, test} from 'bun:test'

import {localUserDefaults} from '../../utils/localUser.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {createAppQueryService} from './appQueryServiceCore.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f2-user-config-model-ref')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let database: {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
} | null = null
let userConfigQueryService: typeof import('./userConfigQueryService.ts').userConfigQueryService | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  const userConfigModule = await import('./userConfigQueryService.ts')

  database = getAppDatabaseService()
  userConfigQueryService = userConfigModule.userConfigQueryService
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

const seedDoclingModelFixture = async (params: {
  connectionId: string
  configJson?: string
  connectionEnabled?: boolean
  modelEnabled?: boolean
  modelId: string
}) => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
    VALUES (
      '${params.connectionId}',
      'docling',
      '${params.connectionId}',
      ${params.connectionEnabled === false ? 'FALSE' : 'TRUE'},
      'none',
      'http://127.0.0.1:5001/v1',
      ${params.configJson ? `CAST('${params.configJson}' AS JSON)` : 'NULL'}
    );

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES (
      '${params.modelId}',
      '${params.connectionId}',
      '${params.modelId}',
      '${params.modelId}',
      '${params.modelId}',
      'manual',
      ${params.modelEnabled === false ? 'FALSE' : 'TRUE'}
    );
  `)
}

const seedUserConfig = async (fullTextConversionModelId: string | null) => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  await database.run(`
    DELETE FROM app.user_config;

    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id)
    VALUES (
      '${localUserDefaults.id}',
      '${localUserDefaults.name}',
      '${localUserDefaults.email}',
      NULL,
      ${fullTextConversionModelId ? `'${fullTextConversionModelId}'` : 'NULL'}
    );
  `)
}

test('full text conversion model config ignores missing and non-selectable configured models', async () => {
  if (!database || !userConfigQueryService) {
    throw new Error('Test dependencies not initialized')
  }

  await seedDoclingModelFixture({connectionId: 'config-valid-connection', modelId: 'config-valid-model'})
  await seedUserConfig('config-valid-model')

  const validConfig = await userConfigQueryService.getFullTextConversionModelConfig()

  expect(validConfig).toMatchObject({
    baseURL: 'http://127.0.0.1:5001/v1',
    modelId: 'config-valid-model',
    modelName: 'config-valid-model',
    providerKind: 'docling',
  })

  await database.run(`
    UPDATE app.provider_connection
    SET config_json = CAST('{"archived":true,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    WHERE id = 'config-valid-connection'
  `)
  expect(await userConfigQueryService.getFullTextConversionModelConfig()).toBeNull()

  await database.run(`
    UPDATE app.provider_connection
    SET config_json = CAST('{"archived":false,"disabledModelIds":["config-valid-model"],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    WHERE id = 'config-valid-connection'
  `)
  expect(await userConfigQueryService.getFullTextConversionModelConfig()).toBeNull()

  await database.run(`
    UPDATE app.provider_connection
    SET config_json = NULL
    WHERE id = 'config-valid-connection';

    UPDATE app.model
    SET enabled = FALSE
    WHERE id = 'config-valid-model';
  `)
  expect(await userConfigQueryService.getFullTextConversionModelConfig()).toBeNull()

  await database.run(`
    UPDATE app.model
    SET enabled = TRUE
    WHERE id = 'config-valid-model';

    UPDATE app.provider_connection
    SET enabled = FALSE
    WHERE id = 'config-valid-connection';
  `)
  expect(await userConfigQueryService.getFullTextConversionModelConfig()).toBeNull()

  await database.run(`
    DELETE FROM app.model
    WHERE id = 'config-valid-model';
  `)
  expect(await userConfigQueryService.getFullTextConversionModelConfig()).toBeNull()
})

test('user config update rejects archived or config-disabled conversion models', async () => {
  if (!database || !userConfigQueryService) {
    throw new Error('Test dependencies not initialized')
  }

  await seedDoclingModelFixture({
    configJson: '{"archived":true,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}',
    connectionId: 'update-archived-connection',
    modelId: 'update-archived-model',
  })
  await seedDoclingModelFixture({
    configJson:
      '{"archived":false,"disabledModelIds":["update-disabled-model"],"manualWorkerUrls":[],"workerUrlMode":"manual"}',
    connectionId: 'update-disabled-connection',
    modelId: 'update-disabled-model',
  })
  await seedUserConfig(null)

  const archivedError = await userConfigQueryService
    .updateUserConfig({
      maintenanceWorkerDuckdbMemoryLimit: null,
      email: localUserDefaults.email,
      fullTextConversionModelId: 'update-archived-model',
      name: localUserDefaults.name,
      projectMartLargeRebuildBatchSize: null,
      projectMartLargeRebuildMaxCyclesPerWake: null,
      projectMartLargeRebuildMaxWakeMs: null,
      projectMartLargeRebuildPollIntervalMs: null,
      projectMartLargeRebuildTuningMode: 'automatic',
      unpaywallEmail: null,
    })
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })
  const disabledError = await userConfigQueryService
    .updateUserConfig({
      maintenanceWorkerDuckdbMemoryLimit: null,
      email: localUserDefaults.email,
      fullTextConversionModelId: 'update-disabled-model',
      name: localUserDefaults.name,
      projectMartLargeRebuildBatchSize: null,
      projectMartLargeRebuildMaxCyclesPerWake: null,
      projectMartLargeRebuildMaxWakeMs: null,
      projectMartLargeRebuildPollIntervalMs: null,
      projectMartLargeRebuildTuningMode: 'automatic',
      unpaywallEmail: null,
    })
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })

  expect(archivedError).toBeInstanceOf(Error)
  expect((archivedError as Error | null)?.message).toContain('Selected PDF conversion model is not available')
  expect(disabledError).toBeInstanceOf(Error)
  expect((disabledError as Error | null)?.message).toContain('Selected PDF conversion model is not available')
})

test('article conversion model provenance remains readable after model deletion', async () => {
  if (!database) {
    throw new Error('Test database not initialized')
  }

  await seedDoclingModelFixture({connectionId: 'article-ref-connection', modelId: 'article-ref-model'})
  await database.run(`
    INSERT INTO app.article (
      id,
      article_title,
      full_text,
      full_text_html,
      full_text_conversion_status,
      full_text_conversion_model_id,
      full_text_conversion_metadata
    ) VALUES (
      'article-ref-article',
      'Article Ref Article',
      'converted text',
      '<p>converted text</p>',
      'success',
      'article-ref-model',
      CAST('{"modelId":"article-ref-model"}' AS JSON)
    );

    DELETE FROM app.model
    WHERE id = 'article-ref-model';
  `)

  const appQueryService = createAppQueryService(database)
  const [article] = await appQueryService.getFullArticlesByIds(['article-ref-article'])

  expect(article?.fullTextConversionModelId).toBe('article-ref-model')
  expect(article?.fullTextConversionMetadata).toEqual({modelId: 'article-ref-model'})
})
