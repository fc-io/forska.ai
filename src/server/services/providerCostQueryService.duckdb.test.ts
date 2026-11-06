import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {getAppDatabaseService} from './appDatabaseService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('provider-cost-query-service')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

type TokenUseFixture = {
  cacheCreation: number | null
  cacheRead: number | null
  completion: number
  connectionId: string | null
  finishedAt: string | null
  id: string
  jobId: string
  modelName: string | null
  prompt: number
  providerKind: string | null
  thinking: number | null
}

let database: ReturnType<typeof getAppDatabaseService> | null = null
let services: {
  cost: typeof import('./providerCostQueryService.ts')
  quota: typeof import('./providerQuotaReadingService.ts')
  tokenUse: typeof import('./tokenUseQueryService.ts')
} | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getServices = () => {
  if (services === null) {
    throw new Error('Services not initialized')
  }

  return services
}

const getReader = () => {
  return {queryJson: getDatabase().queryJson}
}

const getTokenUseValues = (fixture: TokenUseFixture) => {
  return {
    cache_creation_input_tokens: fixture.cacheCreation,
    cache_read_input_tokens: fixture.cacheRead,
    finished_at: fixture.finishedAt ? new Date(fixture.finishedAt) : null,
    id: fixture.id,
    judgment_job_id: fixture.jobId,
    model_id: fixture.modelName ? `model-${fixture.modelName}` : null,
    model_name: fixture.modelName,
    provider_connection_id: fixture.connectionId,
    provider_kind: fixture.providerKind,
    requests: 1,
    started_at: fixture.finishedAt ? new Date(fixture.finishedAt) : null,
    thinking_tokens: fixture.thinking,
    total_completion_tokens: fixture.completion,
    total_prompt_tokens: fixture.prompt,
    total_tokens: fixture.prompt + fixture.completion,
  }
}

const opusFixture = {connectionId: 'conn-claude', jobId: 'job-1', providerKind: 'claude-code'}

const fixtures: TokenUseFixture[] = [
  {
    ...opusFixture,
    cacheCreation: 600,
    cacheRead: 300,
    completion: 200,
    finishedAt: '2026-11-06T10:15:00Z',
    id: 'a',
    modelName: 'claude-opus-5-5',
    prompt: 1000,
    thinking: 50,
  },
  {
    ...opusFixture,
    cacheCreation: null,
    cacheRead: null,
    completion: 100,
    finishedAt: '2026-11-06T10:59:59.999Z',
    id: 'b',
    modelName: 'claude-opus-5-5',
    prompt: 500,
    thinking: null,
  },
  {
    ...opusFixture,
    cacheCreation: 0,
    cacheRead: 100,
    completion: 10,
    finishedAt: '2026-11-06T10:30:00Z',
    id: 'c',
    modelName: 'claude-opus-4-8',
    prompt: 100,
    thinking: 0,
  },
  {
    ...opusFixture,
    cacheCreation: 100,
    cacheRead: 0,
    completion: 0,
    finishedAt: '2026-11-06T11:00:00Z',
    id: 'g',
    modelName: 'claude-opus-5-5',
    prompt: 100,
    thinking: 0,
  },
  {
    cacheCreation: null,
    cacheRead: 40,
    completion: 20,
    connectionId: 'conn-codex',
    finishedAt: '2026-11-06T11:20:00Z',
    id: 'd',
    jobId: 'job-1',
    modelName: 'gpt-5.5',
    prompt: 80,
    providerKind: 'codex',
    thinking: 5,
  },
  {
    cacheCreation: null,
    cacheRead: null,
    completion: 1,
    connectionId: null,
    finishedAt: '2026-11-06T11:40:00Z',
    id: 'e',
    jobId: 'job-1',
    modelName: null,
    prompt: 9,
    providerKind: null,
    thinking: null,
  },
  {
    ...opusFixture,
    cacheCreation: 0,
    cacheRead: 0,
    completion: 1,
    finishedAt: '2026-11-06T10:20:00Z',
    id: 'f',
    jobId: 'job-2',
    modelName: 'claude-opus-5-5',
    prompt: 1,
    thinking: 0,
  },
  {
    ...opusFixture,
    cacheCreation: 0,
    cacheRead: 0,
    completion: 1,
    finishedAt: null,
    id: 'no-finish',
    modelName: 'claude-opus-5-5',
    prompt: 1,
    thinking: 0,
  },
]

const reading = (limitKind: string, observedAt: string, utilizationPercent: number, connectionId = 'conn-claude') => {
  return {
    isActive: limitKind === 'weekly_all' ? true : null,
    limitKind,
    observedAt: new Date(observedAt),
    providerConnectionId: connectionId,
    providerKind: 'claude-code',
    rawJson: {utilization: utilizationPercent},
    resetsAt: new Date('2026-11-13T20:00:00Z'),
    scopeJson: limitKind === 'weekly_all' ? {group: 'weekly'} : null,
    utilizationPercent,
  }
}

beforeAll(async () => {
  const [migrateModule, databaseModule, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateModule.migrateDuckdb()
  database = databaseModule.getAppDatabaseService()
  services = {
    cost: await import('./providerCostQueryService.ts'),
    quota: await import('./providerQuotaReadingService.ts'),
    tokenUse: await import('./tokenUseQueryService.ts'),
  }

  await getDatabase().run(`
    INSERT INTO app.provider_token_weight (
      provider_kind, model_name_pattern, input_weight, cache_creation_weight, cache_read_weight, output_weight,
      thinking_weight, effective_from
    )
    VALUES
      ('claude-code', 'claude-opus-4-%', 1, 1.25, 0.2, 5, 5, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
      ('claude-code', 'claude-opus-5-5', 1, 2, 0.05, 5, 5, TIMESTAMPTZ '2026-11-06 11:00:00+00')
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('the batched insert writes the breakdown and identity columns and replays idempotently', async () => {
  const values = fixtures.map(getTokenUseValues)
  const first = await getServices().tokenUse.getTokenUseQueryService().insertTokenUsesOnce(values)
  const replay = await getServices().tokenUse.getTokenUseQueryService().insertTokenUsesOnce(values)
  const conflict = await getServices()
    .tokenUse.getTokenUseQueryService()
    .insertTokenUsesOnce([{...getTokenUseValues(fixtures[0] as TokenUseFixture), cache_read_input_tokens: 301}])

  expect(first.conflicts).toEqual([])
  expect(replay.conflicts).toEqual([])
  expect(
    conflict.conflicts.map((error) => {
      return error.mismatch
    }),
  ).toEqual(['cache_read_input_tokens'])
  expect(
    await getDatabase().queryJson(`
      SELECT id, cache_creation_input_tokens::INTEGER AS cc, cache_read_input_tokens::INTEGER AS cr,
        thinking_tokens::INTEGER AS thinking,
        model_id AS modelId, model_name AS modelName, provider_kind AS providerKind,
        provider_connection_id AS connectionId
      FROM app.token_use
      WHERE id IN ('a', 'b', 'e')
      ORDER BY id
    `),
  ).toEqual([
    {
      cc: 600,
      connectionId: 'conn-claude',
      cr: 300,
      id: 'a',
      modelId: 'model-claude-opus-5-5',
      modelName: 'claude-opus-5-5',
      providerKind: 'claude-code',
      thinking: 50,
    },
    {
      cc: null,
      connectionId: 'conn-claude',
      cr: null,
      id: 'b',
      modelId: 'model-claude-opus-5-5',
      modelName: 'claude-opus-5-5',
      providerKind: 'claude-code',
      thinking: null,
    },
    {
      cc: null,
      connectionId: null,
      cr: null,
      id: 'e',
      modelId: null,
      modelName: null,
      providerKind: null,
      thinking: null,
    },
  ])
})

test('hourly cost uses the exact weight, the longest pattern, the effective weight and NULL without a weight', async () => {
  await getServices().quota.insertProviderQuotaReadings({
    readings: [
      reading('seven_day', '2026-11-06T10:05:00Z', 10),
      reading('weekly_all', '2026-11-06T10:05:00Z', 10),
      reading('seven_day', '2026-11-06T10:35:00Z', 12),
      reading('weekly_all', '2026-11-06T10:35:00Z', 12),
      reading('seven_day', '2026-11-06T11:10:00Z', 15),
      reading('weekly_all', '2026-11-06T11:10:00Z', 15),
      reading('seven_day', '2026-11-06T10:10:00Z', 50, 'conn-unused'),
    ],
  })

  const result = await getServices().cost.getProviderCostByHour({
    query: {from: null, jobId: 'job-1', to: null},
    reader: getReader(),
  })

  expect(
    result.hours.map((hour) => {
      return [hour.hourStart, hour.providerKind, hour.modelName, hour.costWeightedTokens, hour.weightPattern]
    }),
  ).toEqual([
    ['2026-11-06T10:00:00.000Z', 'claude-code', 'claude-opus-4-8', 70, 'claude-opus-4-%'],
    ['2026-11-06T10:00:00.000Z', 'claude-code', 'claude-opus-5-5', 2865, 'claude-opus-5-5'],
    ['2026-11-06T11:00:00.000Z', 'claude-code', 'claude-opus-5-5', 200, 'claude-opus-5-5'],
    ['2026-11-06T11:00:00.000Z', 'codex', 'gpt-5.5', null, null],
    ['2026-11-06T11:00:00.000Z', null, null, null, null],
  ])
  expect(result.hours[1]).toMatchObject({
    cacheCreationInputTokens: 600,
    cacheReadInputTokens: 300,
    completionTokens: 300,
    promptTokens: 1500,
    requests: 2,
    thinkingTokens: 50,
    tokenUseRows: 2,
    totalTokens: 1800,
    weightEffectiveFrom: '2026-01-01T00:00:00.000Z',
  })
  expect(result.hours[2]?.weightEffectiveFrom).toBe('2026-11-06T11:00:00.000Z')
  expect(
    result.quota.map((hour) => {
      return [
        hour.hourStart,
        hour.providerConnectionId,
        hour.limitKind,
        hour.readings,
        hour.firstUtilizationPercent,
        hour.lastUtilizationPercent,
      ]
    }),
  ).toEqual([
    ['2026-11-06T10:00:00.000Z', 'conn-claude', 'seven_day', 2, 10, 12],
    ['2026-11-06T10:00:00.000Z', 'conn-claude', 'weekly_all', 2, 10, 12],
    ['2026-11-06T11:00:00.000Z', 'conn-claude', 'seven_day', 1, 15, 15],
    ['2026-11-06T11:00:00.000Z', 'conn-claude', 'weekly_all', 1, 15, 15],
  ])
})

test('from is inclusive, to is exclusive, rows without finished_at and other jobs are left out', async () => {
  const result = await getServices().cost.getProviderCostByHour({
    query: {from: new Date('2026-11-06T10:15:00Z'), jobId: null, to: new Date('2026-11-06T11:00:00Z')},
    reader: getReader(),
  })

  expect(
    result.hours.map((hour) => {
      return [hour.modelName, hour.tokenUseRows, hour.promptTokens]
    }),
  ).toEqual([
    ['claude-opus-4-8', 1, 100],
    ['claude-opus-5-5', 3, 1501],
  ])
  expect(
    result.quota.map((hour) => {
      return [hour.limitKind, hour.readings]
    }),
  ).toEqual([
    ['seven_day', 1],
    ['weekly_all', 1],
  ])
})

test('the owner-side default reader runs the same query at background priority', async () => {
  const result = await getServices().cost.getProviderCostByHour({query: {from: null, jobId: 'job-2', to: null}})

  expect(
    result.hours.map((hour) => {
      return [hour.modelName, hour.costWeightedTokens]
    }),
  ).toEqual([['claude-opus-5-5', 6]])
})

test('the latest poll gives the job panel headline and older or other readings are ignored', async () => {
  const readings = await getServices().quota.getLatestProviderQuotaReadings({
    now: new Date('2026-11-06T12:00:00Z'),
    providerConnectionId: 'conn-claude',
    reader: getReader(),
  })

  expect(
    readings.map((entry) => {
      return [entry.limitKind, entry.utilizationPercent, entry.observedAt]
    }),
  ).toEqual([
    ['seven_day', 15, '2026-11-06T11:10:00.000Z'],
    ['weekly_all', 15, '2026-11-06T11:10:00.000Z'],
  ])
  expect(getServices().quota.getProviderQuotaHeadlines(readings)).toEqual([
    {
      label: 'Claude Max weekly',
      limitKind: 'seven_day',
      observedAt: '2026-11-06T11:10:00.000Z',
      resetsAt: '2026-11-13T20:00:00.000Z',
      utilizationPercent: 15,
    },
  ])
  expect(
    await getServices().quota.getLatestProviderQuotaReadings({
      now: new Date('2026-11-07T11:10:00.001Z'),
      providerConnectionId: 'conn-claude',
      reader: getReader(),
    }),
  ).toEqual([])
})

test('codex headlines name the window from its duration', () => {
  const codexReading = (limitKind: string, windowDurationMins: number | null) => {
    return {
      isActive: null,
      limitKind,
      observedAt: '2026-11-06T11:00:00.000Z',
      providerConnectionId: 'conn-codex',
      providerKind: 'codex',
      resetsAt: null,
      scopeJson: {limitId: limitKind.split(':')[0], limitName: 'Reserve', windowDurationMins},
      utilizationPercent: 7,
    }
  }

  expect(
    getServices()
      .quota.getProviderQuotaHeadlines([
        codexReading('codex:primary', 300),
        codexReading('codex:secondary', 10_080),
        codexReading('reserve:secondary', 10_080),
        codexReading('codex:other', null),
      ])
      .map((headline) => {
        return headline.label
      }),
  ).toEqual(['Codex 5-hour', 'Codex weekly', 'Codex weekly (Reserve)'])
})
