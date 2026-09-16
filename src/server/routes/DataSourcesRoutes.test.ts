import {readFileSync} from 'node:fs'

import {expect, mock, test} from 'bun:test'

type StructuredFileConfigResponse = {
  assetPath: string
  boundaryDisplayPath: string
  boundaryPointer: string
  format: 'json'
  kind: 'structured_file'
  sourceFileName: string
  version: 1
}

type CovidencePackageConfigResponse = {
  files: Array<{
    assetPath: string
    fileRole: 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
    format: 'csv' | 'ris'
    sourceFileName: string
  }>
  kind: 'covidence_import'
  mode: 'title_abstract' | 'full_text'
  version: 1
}

type DataSourceResponseEntry = {
  archived: boolean
  covidencePackageConfig: CovidencePackageConfigResponse | null
  createdAt: string
  dateFrom: null
  dateTo: null
  description: string
  id: string
  immutable: boolean
  importRoute: string
  itemsAfterLastImport: number
  lastImportAt: string
  linkedProjectId: string | null
  linkedPromptIds: string[]
  reimportable: boolean
  structuredFileConfig: StructuredFileConfigResponse | null
  title: string
  trackingEnabled: boolean
  trackingReconcileScheduleMonths: number[]
  trackingState: null | {
    activeCursor: string | null
    activeReconciliationAgeMonths: number | null
    activeRunKind: string | null
    activeWindowEnd: string | null
    activeWindowStart: string | null
    failureCount: number
    granularity: string
    highWaterCompletedAt: string | null
    lastAttemptAt: string | null
    lastError: string | null
    lastReconciliationCompletedAt: string | null
    lastSuccessAt: string | null
    nextRunAfter: string | null
    pendingReconciliationCount: number
  }
  trackingSupported: boolean
  updatedAt: string
}

type DataSourceListResponse = {data: DataSourceResponseEntry[]}
type DataSourceDetailResponse = {data: DataSourceResponseEntry}
type MockQueryRow = {
  archived: boolean
  createdAt: string
  cursor: string | null
  dateFrom: null | string
  dateTo: null | string
  description: string
  id: string
  importRoute: string
  itemsAfterLastImport: number
  lastImportAt: string
  title: string
  updatedAt: string
  trackingActiveCursor?: string | null
  trackingActiveReconciliationAgeMonths?: number | null
  trackingActiveRunKind?: string | null
  trackingActiveWindowEnd?: string | null
  trackingActiveWindowStart?: string | null
  trackingEnabled?: boolean
  trackingFailureCount?: number | null
  trackingGranularity?: string | null
  trackingHighWaterCompletedAt?: string | null
  trackingLastAttemptAt?: string | null
  trackingLastError?: string | null
  trackingLastReconciliationCompletedAt?: string | null
  trackingLastSuccessAt?: string | null
  trackingNextRunAfter?: string | null
  trackingPendingReconciliationCount?: number | null
  trackingReconcileScheduleMonths?: unknown
}

const structuredFileConfig: StructuredFileConfigResponse = {
  assetPath: 'assets/structured_file_imports/upload.json',
  boundaryDisplayPath: '$.records[]',
  boundaryPointer: '/records',
  format: 'json',
  kind: 'structured_file',
  sourceFileName: 'upload.json',
  version: 1,
}

const covidencePackageConfig: CovidencePackageConfigResponse = {
  files: [
    {
      assetPath: 'assets/covidence_imports/datasource-2/all-all.csv',
      fileRole: 'all',
      format: 'csv',
      sourceFileName: 'all.csv',
    },
    {
      assetPath: 'assets/covidence_imports/datasource-2/irrelevant-irrelevant.csv',
      fileRole: 'irrelevant',
      format: 'csv',
      sourceFileName: 'irrelevant.csv',
    },
    {
      assetPath: 'assets/covidence_imports/datasource-2/full_text-full_text.ris',
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    },
  ],
  kind: 'covidence_import',
  mode: 'title_abstract',
  version: 1,
}

const structuredRow: MockQueryRow = {
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  cursor: JSON.stringify(structuredFileConfig),
  dateFrom: null,
  dateTo: null,
  description: 'Created from upload',
  id: 'datasource-1',
  importRoute: 'imported-file:Created datasource',
  itemsAfterLastImport: 2,
  lastImportAt: '2026-01-02T00:00:00.000Z',
  title: 'Created datasource',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

const covidenceRow: MockQueryRow = {
  archived: false,
  createdAt: '2026-02-01T00:00:00.000Z',
  cursor: JSON.stringify(covidencePackageConfig),
  dateFrom: null,
  dateTo: null,
  description: 'Imported from Covidence',
  id: 'datasource-2',
  importRoute: 'covidence:datasource-2',
  itemsAfterLastImport: 4,
  lastImportAt: '2026-02-02T00:00:00.000Z',
  title: 'Covidence datasource',
  updatedAt: '2026-02-02T00:00:00.000Z',
}

const trackedRow: MockQueryRow = {
  archived: false,
  createdAt: '2026-03-01T00:00:00.000Z',
  cursor: null,
  dateFrom: '2026-03-01T00:00:00.000Z',
  dateTo: null,
  description: 'Tracked PubMed source',
  id: 'datasource-tracked',
  importRoute: '/api/datasources/import/pubmed',
  itemsAfterLastImport: 7,
  lastImportAt: '2026-03-03T00:00:00.000Z',
  title: 'Tracked PubMed',
  trackingActiveCursor: 'cursor-after-page',
  trackingActiveReconciliationAgeMonths: null,
  trackingActiveRunKind: 'incremental',
  trackingActiveWindowEnd: '2026-03-03T00:00:00.000Z',
  trackingActiveWindowStart: '2026-03-02T00:00:00.000Z',
  trackingEnabled: true,
  trackingFailureCount: 1,
  trackingGranularity: 'day',
  trackingHighWaterCompletedAt: '2026-03-02T00:00:00.000Z',
  trackingLastAttemptAt: '2026-03-03T01:00:00.000Z',
  trackingLastError: 'provider timeout',
  trackingLastReconciliationCompletedAt: '2026-03-02T02:00:00.000Z',
  trackingLastSuccessAt: '2026-03-03T00:00:00.000Z',
  trackingNextRunAfter: '2026-03-04T00:00:00.000Z',
  trackingPendingReconciliationCount: 2,
  trackingReconcileScheduleMonths: [3, 12],
  updatedAt: '2026-03-03T00:00:00.000Z',
}

const routeHarnessState: {
  changeRows: Array<Record<string, unknown>>
  covidenceProjectLinks: Array<{importRoute: string; projectId: string}>
  covidencePromptLinks: Array<{importRoute: string; promptId: string}>
  queryStatements: string[]
  reconciliationWorkRows: Array<Record<string, unknown>>
  row: MockQueryRow
  runStatements: string[]
  transactionCallCount: number
} = {
  changeRows: [],
  covidenceProjectLinks: [],
  covidencePromptLinks: [],
  queryStatements: [],
  reconciliationWorkRows: [],
  row: structuredRow,
  runStatements: [],
  transactionCallCount: 0,
}

const getMockTrackingStateRow = () => {
  return {
    activeCursor: routeHarnessState.row.trackingActiveCursor ?? null,
    activeReconciliationAgeMonths: routeHarnessState.row.trackingActiveReconciliationAgeMonths ?? null,
    activeRunKind: routeHarnessState.row.trackingActiveRunKind ?? null,
    activeWindowEnd: routeHarnessState.row.trackingActiveWindowEnd ?? null,
    activeWindowStart: routeHarnessState.row.trackingActiveWindowStart ?? null,
    createdAt: routeHarnessState.row.createdAt,
    dataSourceId: routeHarnessState.row.id,
    failureCount: routeHarnessState.row.trackingFailureCount ?? 0,
    granularity: routeHarnessState.row.trackingGranularity ?? 'day',
    highWaterCompletedAt: routeHarnessState.row.trackingHighWaterCompletedAt ?? null,
    lastAttemptAt: routeHarnessState.row.trackingLastAttemptAt ?? null,
    lastError: routeHarnessState.row.trackingLastError ?? null,
    lastImportRunId: null,
    lastReconciliationCompletedAt: routeHarnessState.row.trackingLastReconciliationCompletedAt ?? null,
    lastReconciliationSchedulerAt: null,
    lastSuccessAt: routeHarnessState.row.trackingLastSuccessAt ?? null,
    leaseExpiresAt: null,
    leaseOwner: null,
    nextRunAfter: routeHarnessState.row.trackingNextRunAfter ?? null,
    route: routeHarnessState.row.importRoute,
    updatedAt: routeHarnessState.row.updatedAt,
  }
}

const queryJson = async (statement: string) => {
  routeHarnessState.queryStatements.push(statement)

  return statement.includes('INSERT INTO app.data_source_tracking_state')
    || (statement.includes('UPDATE app.data_source_tracking_state') && statement.includes('RETURNING'))
    ? [getMockTrackingStateRow()]
    : statement.includes('INNER JOIN app.project_prompt')
      ? routeHarnessState.covidencePromptLinks
      : statement.includes('FROM app.project_import_route')
        ? routeHarnessState.covidenceProjectLinks
        : statement.includes('FROM app.data_source data_source')
          ? [routeHarnessState.row]
          : statement.includes('FROM app.data_source_reconciliation_work')
            ? routeHarnessState.reconciliationWorkRows
            : statement.includes('FROM app.data_source_article_change_log')
              ? routeHarnessState.changeRows
              : statement.includes('INSERT INTO app.data_source')
                ? [routeHarnessState.row]
                : statement.includes(`WHERE data_source.id = '${routeHarnessState.row.id}'`)
                    || statement.includes(`WHERE id = '${routeHarnessState.row.id}'`)
                  ? [routeHarnessState.row]
                  : [routeHarnessState.row]
}

const run = async (statement: string) => {
  routeHarnessState.runStatements.push(statement)
}

void mock.module(new URL('../services/appDatabaseService.ts', import.meta.url).href, () => {
  return {
    getAppDatabaseService: () => {
      return {
        queryJson,
        run,
        transaction: async <T>(operation: (runner: {queryJson: typeof queryJson; run: typeof run}) => Promise<T>) => {
          routeHarnessState.transactionCallCount += 1
          return operation({queryJson, run})
        },
      }
    },
  }
})

const runDataSourcesRoute = async (params: {
  changeRows?: Array<Record<string, unknown>>
  covidenceProjectLinks?: Array<{importRoute: string; projectId: string}>
  covidencePromptLinks?: Array<{importRoute: string; promptId: string}>
  reconciliationWorkRows?: Array<Record<string, unknown>>
  requestInit?: RequestInit
  row: MockQueryRow
  url: string
}) => {
  routeHarnessState.covidenceProjectLinks = params.covidenceProjectLinks ?? []
  routeHarnessState.covidencePromptLinks = params.covidencePromptLinks ?? []
  routeHarnessState.reconciliationWorkRows = params.reconciliationWorkRows ?? []
  routeHarnessState.changeRows = params.changeRows ?? []
  routeHarnessState.row = params.row
  routeHarnessState.queryStatements = []
  routeHarnessState.runStatements = []
  routeHarnessState.transactionCallCount = 0

  const {Elysia} = await import('elysia')
  const {dataSourcesRoutes} = (await import(
    './DataSourcesRoutes.ts?test=' + Date.now()
  )) as typeof import('./DataSourcesRoutes.ts')
  const app = new Elysia().use(dataSourcesRoutes)
  const response = await app.handle(new Request(params.url, params.requestInit))
  const responseText = await response.text()
  let body: unknown = responseText

  try {
    body = responseText ? JSON.parse(responseText) : null
  } catch {
    body = responseText
  }

  return {
    body,
    queryStatements: routeHarnessState.queryStatements,
    runStatements: routeHarnessState.runStatements,
    status: response.status,
    transactionCallCount: routeHarnessState.transactionCallCount,
  }
}

test('covidence project link lookup returns one bounded row per import route', () => {
  const routeText = readFileSync('src/server/routes/DataSourcesRoutes.ts', 'utf8')

  expect(routeText).toContain('SELECT DISTINCT ON (ir.route)')
  expect(routeText).toContain('ORDER BY ir.route ASC, pir.project_id ASC')
  expect(routeText).toContain(
    "getDataSourcesWorkloadContext({maxResultRows: importRoutes.length, operation: 'covidenceProjectLinks'})",
  )
})

test('covidence prompt link lookup bounds rows per import route in SQL before budget enforcement', () => {
  const routeText = readFileSync('src/server/routes/DataSourcesRoutes.ts', 'utf8')

  expect(routeText).toContain('INNER JOIN LATERAL (')
  expect(routeText).toContain('WHERE pir.import_route_id = selected_import_route.id')
  expect(routeText).toContain('LIMIT ${covidencePromptLinksPerImportRouteLimit}')
  expect(routeText).toContain('maxResultRows: importRoutes.length * covidencePromptLinksPerImportRouteLimit')
})

test('datasource lists are not silently truncated by a hard SQL limit', () => {
  const routeText = readFileSync('src/server/routes/DataSourcesRoutes.ts', 'utf8')
  const listActiveSql = routeText.slice(
    routeText.indexOf("operation: 'listActive'") - 500,
    routeText.indexOf("operation: 'listActive'") + 120,
  )
  const listArchivedSql = routeText.slice(
    routeText.indexOf("operation: 'listArchived'") - 500,
    routeText.indexOf("operation: 'listArchived'") + 120,
  )

  expect(listActiveSql).not.toContain('LIMIT')
  expect(listActiveSql).not.toContain('maxResultRows')
  expect(listArchivedSql).not.toContain('LIMIT')
  expect(listArchivedSql).not.toContain('maxResultRows')
})

test('active datasource list keeps the unpaginated product contract explicit', () => {
  const routeText = readFileSync('src/server/routes/DataSourcesRoutes.ts', 'utf8')
  const listActiveRoute = routeText.slice(
    routeText.indexOf(".get('/api/datasources'"),
    routeText.indexOf(".get('/api/datasources/archived'"),
  )

  expect(listActiveRoute).toContain('ORDER BY data_source.created_at DESC')
  expect(listActiveRoute).toContain("getDataSourcesWorkloadContext({operation: 'listActive'})")
  expect(listActiveRoute).not.toContain('maxResultRows')
  expect(listActiveRoute).not.toContain('LIMIT')
})

test('datasource list responses omit raw cursor while including structured file config', async () => {
  const parsed = (await runDataSourcesRoute({row: structuredRow, url: 'http://localhost/api/datasources'})) as {
    body: DataSourceListResponse
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body.data).toHaveLength(1)
  expect(parsed.body).toEqual({
    data: [
      {
        archived: false,
        covidencePackageConfig: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        dateFrom: null,
        dateTo: null,
        description: 'Created from upload',
        id: 'datasource-1',
        immutable: true,
        importRoute: 'imported-file:Created datasource',
        itemsAfterLastImport: 2,
        lastImportAt: '2026-01-02T00:00:00.000Z',
        linkedProjectId: null,
        linkedPromptIds: [],
        reimportable: false,
        structuredFileConfig,
        title: 'Created datasource',
        trackingEnabled: false,
        trackingReconcileScheduleMonths: [3, 12, 24, 36],
        trackingState: null,
        trackingSupported: false,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  })
  expect(Object.hasOwn(parsed.body.data[0] as object, 'cursor')).toBe(false)
})

test('datasource detail responses omit raw cursor while including structured file config', async () => {
  const parsed = (await runDataSourcesRoute({
    row: structuredRow,
    url: 'http://localhost/api/datasources/datasource-1',
  })) as {body: DataSourceDetailResponse; status: number}

  expect(parsed.status).toBe(200)
  expect(parsed.body).toEqual({
    data: {
      archived: false,
      covidencePackageConfig: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      dateFrom: null,
      dateTo: null,
      description: 'Created from upload',
      id: 'datasource-1',
      immutable: true,
      importRoute: 'imported-file:Created datasource',
      itemsAfterLastImport: 2,
      lastImportAt: '2026-01-02T00:00:00.000Z',
      linkedProjectId: null,
      linkedPromptIds: [],
      reimportable: false,
      structuredFileConfig,
      title: 'Created datasource',
      trackingEnabled: false,
      trackingReconcileScheduleMonths: [3, 12, 24, 36],
      trackingState: null,
      trackingSupported: false,
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  })
  expect(Object.hasOwn(parsed.body.data, 'cursor')).toBe(false)
})

test('tracked datasource responses include compact tracking state without exposing cursor', async () => {
  const parsed = (await runDataSourcesRoute({
    row: trackedRow,
    url: 'http://localhost/api/datasources/datasource-tracked',
  })) as {body: DataSourceDetailResponse; status: number}

  expect(parsed.status).toBe(200)
  expect(parsed.body.data.trackingEnabled).toBe(true)
  expect(parsed.body.data.trackingSupported).toBe(true)
  expect(parsed.body.data.trackingReconcileScheduleMonths).toEqual([3, 12])
  expect(parsed.body.data.trackingState).toEqual({
    activeCursor: 'cursor-after-page',
    activeReconciliationAgeMonths: null,
    activeRunKind: 'incremental',
    activeWindowEnd: '2026-03-03T00:00:00.000Z',
    activeWindowStart: '2026-03-02T00:00:00.000Z',
    failureCount: 1,
    granularity: 'day',
    highWaterCompletedAt: '2026-03-02T00:00:00.000Z',
    lastAttemptAt: '2026-03-03T01:00:00.000Z',
    lastError: 'provider timeout',
    lastReconciliationCompletedAt: '2026-03-02T02:00:00.000Z',
    lastSuccessAt: '2026-03-03T00:00:00.000Z',
    nextRunAfter: '2026-03-04T00:00:00.000Z',
    pendingReconciliationCount: 2,
  })
  expect(Object.hasOwn(parsed.body.data, 'cursor')).toBe(false)
})

test('covidence datasource responses expose package config and linked project and prompt ids', async () => {
  const parsed = (await runDataSourcesRoute({
    covidenceProjectLinks: [{importRoute: 'covidence:datasource-2', projectId: 'project-covidence-1'}],
    covidencePromptLinks: [
      {importRoute: 'covidence:datasource-2', promptId: 'prompt-covidence-1'},
      {importRoute: 'covidence:datasource-2', promptId: 'prompt-covidence-2'},
    ],
    row: covidenceRow,
    url: 'http://localhost/api/datasources/datasource-2',
  })) as {body: DataSourceDetailResponse; status: number}

  expect(parsed.status).toBe(200)
  expect(parsed.body).toEqual({
    data: {
      archived: false,
      covidencePackageConfig,
      createdAt: '2026-02-01T00:00:00.000Z',
      dateFrom: null,
      dateTo: null,
      description: 'Imported from Covidence',
      id: 'datasource-2',
      immutable: true,
      importRoute: 'covidence:datasource-2',
      itemsAfterLastImport: 4,
      lastImportAt: '2026-02-02T00:00:00.000Z',
      linkedProjectId: 'project-covidence-1',
      linkedPromptIds: ['prompt-covidence-1', 'prompt-covidence-2'],
      reimportable: true,
      structuredFileConfig: null,
      title: 'Covidence datasource',
      trackingEnabled: false,
      trackingReconcileScheduleMonths: [3, 12, 24, 36],
      trackingState: null,
      trackingSupported: false,
      updatedAt: '2026-02-02T00:00:00.000Z',
    },
  })
  expect(Object.hasOwn(parsed.body.data, 'cursor')).toBe(false)
})

test('manual tracking reconciliation endpoint schedules full-range work', async () => {
  const finiteTrackedRow = {...trackedRow, dateFrom: '2026-03-01T12:30:00.000Z', dateTo: '2026-03-04T00:00:00.000Z'}
  const workRow = {
    ageMonths: null,
    completedAt: null,
    cursor: null,
    dataSourceId: trackedRow.id,
    failureCount: 0,
    id: 'manual-reconciliation-work-1',
    importRunId: null,
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    periodEnd: '2026-03-05T00:00:00.000Z',
    periodStart: '2026-03-01T00:00:00.000Z',
    route: '/api/datasources/import/pubmed',
    runKind: 'manual_full_range',
    scheduledAt: '2026-03-05T00:00:00.000Z',
    spoolWindowId: null,
    startedAt: null,
    status: 'queued',
    updatedAt: '2026-03-05T00:00:00.000Z',
  }
  const parsed = (await runDataSourcesRoute({
    reconciliationWorkRows: [workRow],
    requestInit: {method: 'POST'},
    row: finiteTrackedRow,
    url: 'http://localhost/api/datasources/datasource-tracked/tracking/reconcile',
  })) as {
    body: {data: {dataSource: DataSourceResponseEntry; work: {id: string; runKind: string; status: string}}}
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body.data.dataSource.trackingEnabled).toBe(true)
  expect(parsed.body.data.work).toMatchObject({
    id: 'manual-reconciliation-work-1',
    runKind: 'manual_full_range',
    status: 'queued',
  })
  expect(readFileSync('src/server/routes/DataSourcesRoutes.ts', 'utf8')).toContain(
    'const periodStart = getUtcDayStart(dateFrom)',
  )
})

test('tracking-enabled datasource create inserts the row and tracking state in one transaction', async () => {
  const parsed = (await runDataSourcesRoute({
    requestInit: {
      body: JSON.stringify({
        dateFrom: '2026-03-01',
        importRoute: '/api/datasources/import/pubmed',
        title: 'Tracked PubMed',
        trackingEnabled: true,
        trackingReconcileScheduleMonths: [12, 3, 12],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    },
    row: trackedRow,
    url: 'http://localhost/api/datasources',
  })) as {body: DataSourceDetailResponse; queryStatements: string[]; status: number; transactionCallCount: number}

  expect(parsed.status).toBe(200)
  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.body.data.trackingEnabled).toBe(true)
  expect(parsed.queryStatements.join('\n')).toContain('INSERT INTO app.data_source')
  expect(parsed.queryStatements.join('\n')).toContain('INSERT INTO app.data_source_tracking_state')
  expect(parsed.queryStatements.join('\n')).toContain("CAST('[3,12]' AS JSON)")
})

test('datasource create rejects reconciliation schedule months outside the safe bound', async () => {
  const parsed = (await runDataSourcesRoute({
    requestInit: {
      body: JSON.stringify({
        dateFrom: '2026-03-01',
        importRoute: '/api/datasources/import/pubmed',
        title: 'Tracked PubMed',
        trackingEnabled: true,
        trackingReconcileScheduleMonths: [3, 100000000],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    },
    row: trackedRow,
    url: 'http://localhost/api/datasources',
  })) as {body: string; status: number; transactionCallCount: number}

  expect(parsed.status).toBe(500)
  expect(parsed.body).toContain('Reconciliation schedule months must be integers between 1 and 120')
  expect(parsed.transactionCallCount).toBe(0)
})

test('datasource patch rewinds tracking and invalidates stale reconciliation work when bounds change', async () => {
  const parsed = (await runDataSourcesRoute({
    requestInit: {
      body: JSON.stringify({
        dateFrom: '2026-02-01',
        dateTo: '2026-03-02',
        trackingReconcileScheduleMonths: [3, 12, 24],
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    },
    row: trackedRow,
    url: 'http://localhost/api/datasources/datasource-tracked',
  })) as {runStatements: string[]; status: number; transactionCallCount: number}
  const statements = parsed.runStatements.join('\n')

  expect(parsed.status).toBe(200)
  expect(parsed.transactionCallCount).toBe(1)
  expect(statements).toContain('UPDATE app.data_source_tracking_state')
  expect(statements).toContain('high_water_completed_at = NULL')
  expect(statements).toContain('last_reconciliation_scheduler_at = NULL')
  expect(statements).toContain('DELETE FROM app.data_source_reconciliation_work')
  expect(statements).toContain("period_start < TIMESTAMPTZ '2026-02-01T00:00:00.000Z'")
  expect(statements).toContain("period_end > TIMESTAMPTZ '2026-03-03T00:00:00.000Z'")
})

test('datasource patch rewinds disabled tracking state when bounds change before re-enable', async () => {
  const disabledTrackedRow = {...trackedRow, trackingEnabled: false}
  const parsed = (await runDataSourcesRoute({
    requestInit: {
      body: JSON.stringify({dateFrom: '2026-02-01'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    },
    row: disabledTrackedRow,
    url: 'http://localhost/api/datasources/datasource-tracked',
  })) as {runStatements: string[]; status: number; transactionCallCount: number}
  const statements = parsed.runStatements.join('\n')

  expect(parsed.status).toBe(200)
  expect(parsed.transactionCallCount).toBe(1)
  expect(statements).toContain('UPDATE app.data_source_tracking_state')
  expect(statements).toContain('high_water_completed_at = NULL')
  expect(statements).toContain('active_window_start = NULL')
  expect(statements).toContain('DELETE FROM app.data_source_reconciliation_work')
  expect(statements).toContain("period_start < TIMESTAMPTZ '2026-02-01T00:00:00.000Z'")
})

test('tracking changes endpoint returns filtered source change rows', async () => {
  const parsed = (await runDataSourcesRoute({
    changeRows: [
      {
        articleId: 'article-1',
        changeKind: 'source_record_deleted',
        changedFields: JSON.stringify({status: ['active', 'deleted']}),
        createdAt: '2026-03-05T00:00:00.000Z',
        dataSourceId: trackedRow.id,
        detectedAt: '2026-03-05T00:00:00.000Z',
        externalArticleId: 'pmid:1',
        id: 'change-1',
        importRouteId: 'import-route-1',
        importRunId: 'manual-reconciliation-work-1',
        nextSnapshot: JSON.stringify({}),
        nextSourceRecordHash: null,
        previousSnapshot: JSON.stringify({title: 'Old title'}),
        previousSourceRecordHash: 'hash-old',
        route: '/api/datasources/import/pubmed',
        runKind: 'manual_full_range',
        sourceRecordKey: 'pmid:1',
      },
    ],
    row: trackedRow,
    url: 'http://localhost/api/datasources/datasource-tracked/tracking/changes?changeKind=source_record_deleted&runKind=manual_full_range',
  })) as {
    body: {
      data: {
        after: string | null
        hasMore: boolean
        items: Array<{changeKind: string; runKind: string; sourceRecordKey: string}>
        limit: number
        nextCursor: string | null
      }
    }
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body.data.limit).toBe(50)
  expect(parsed.body.data.after).toBeNull()
  expect(parsed.body.data.nextCursor).toBeNull()
  expect(parsed.body.data.hasMore).toBe(false)
  expect(parsed.body.data.items).toHaveLength(1)
  expect(parsed.body.data.items[0]).toMatchObject({
    changeKind: 'source_record_deleted',
    runKind: 'manual_full_range',
    sourceRecordKey: 'pmid:1',
  })
})

test('tracking changes endpoint returns pagination metadata and requests one lookahead row', async () => {
  const changeRows = Array.from({length: 3}, (_, index) => {
    return {
      articleId: `article-${index + 1}`,
      changeKind: 'source_record_changed',
      changedFields: JSON.stringify({}),
      createdAt: '2026-03-05T00:00:00.000Z',
      dataSourceId: trackedRow.id,
      detectedAt: '2026-03-05T00:00:00.000Z',
      externalArticleId: `pmid:${index + 1}`,
      id: `change-${index + 1}`,
      importRouteId: 'import-route-1',
      importRunId: 'import-run-1',
      nextSnapshot: JSON.stringify({}),
      nextSourceRecordHash: `hash-next-${index + 1}`,
      previousSnapshot: JSON.stringify({}),
      previousSourceRecordHash: `hash-prev-${index + 1}`,
      route: '/api/datasources/import/pubmed',
      runKind: 'incremental',
      sourceRecordKey: `pmid:${index + 1}`,
    }
  })
  const parsed = (await runDataSourcesRoute({
    changeRows,
    row: trackedRow,
    url: 'http://localhost/api/datasources/datasource-tracked/tracking/changes?limit=2',
  })) as {
    body: {data: {hasMore: boolean; items: Array<{id: string}>; limit: number; nextCursor: string | null}}
    queryStatements: string[]
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body.data.items).toHaveLength(2)
  expect(parsed.body.data.hasMore).toBe(true)
  expect(typeof parsed.body.data.nextCursor).toBe('string')
  expect(parsed.body.data.limit).toBe(2)
  expect(parsed.queryStatements.join('\n')).toContain('LIMIT 3')
  expect(parsed.queryStatements.join('\n')).not.toContain('OFFSET')
})

test('tracking changes endpoint pages by opaque cursor without offset pagination', async () => {
  const after = Buffer.from(
    JSON.stringify({createdAt: '2026-03-05T00:00:00.000Z', detectedAt: '2026-03-05T00:00:00.000Z', id: 'change-2'}),
    'utf8',
  ).toString('base64url')

  const parsed = (await runDataSourcesRoute({
    changeRows: [],
    row: trackedRow,
    url: `http://localhost/api/datasources/datasource-tracked/tracking/changes?limit=2&after=${after}`,
  })) as {
    body: {
      data: {
        after: string | null
        hasMore: boolean
        items: Array<{id: string}>
        limit: number
        nextCursor: string | null
      }
    }
    queryStatements: string[]
    status: number
  }
  const statements = parsed.queryStatements.join('\n')

  expect(parsed.status).toBe(200)
  expect(parsed.body.data.after).toBe(after)
  expect(parsed.body.data.nextCursor).toBeNull()
  expect(statements).toContain("detected_at < TIMESTAMPTZ '2026-03-05T00:00:00.000Z'")
  expect(statements).toContain("id > 'change-2'")
  expect(statements).not.toContain('OFFSET')
})

test('structured file datasource patch rejects non-archive edits', async () => {
  const parsed = (await runDataSourcesRoute({
    requestInit: {
      body: JSON.stringify({title: 'Edited title'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    },
    row: structuredRow,
    url: 'http://localhost/api/datasources/datasource-1',
  })) as {body: string; status: number; transactionCallCount: number}

  expect(parsed.status).toBe(500)
  expect(parsed.body).toContain('Imported XML/JSON data sources are immutable and can only be archived')
  expect(parsed.transactionCallCount).toBe(0)
})

test('covidence datasource patch rejects non-archive edits', async () => {
  const parsed = (await runDataSourcesRoute({
    requestInit: {
      body: JSON.stringify({title: 'Edited title'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    },
    row: covidenceRow,
    url: 'http://localhost/api/datasources/datasource-2',
  })) as {body: string; status: number; transactionCallCount: number}

  expect(parsed.status).toBe(500)
  expect(parsed.body).toContain('Imported XML/JSON data sources are immutable and can only be archived')
  expect(parsed.transactionCallCount).toBe(0)
})
