import {mkdirSync, rmSync} from 'node:fs'

import {afterAll, afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

import type {ProjectTransferSessionRecord} from '../../db/schemaTypes.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'

type RouteTestApp = {handle: (request: Request) => Promise<Response> | Response}
type PlaceholderResponseBody = {data: null; error: string}
type SourceProjectRow = {deletePendingAt: unknown; id: string}

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const exportPackageModulePath = new URL('../services/projectTransfer/projectTransferExportPackage.ts', import.meta.url)
  .pathname
const sessionRepositoryModulePath = new URL(
  '../services/projectTransfer/projectTransferSessionRepository.ts',
  import.meta.url,
).pathname

const textEncoder = new TextEncoder()
const futureDate = new Date('2035-01-01T00:00:00.000Z')
const pastDate = new Date('2020-01-01T00:00:00.000Z')
const bodyMethods = new Set(['PATCH', 'POST', 'PUT'])
const csvExportRoute = {method: 'POST', samplePath: '/api/projects/project-1/export'} as const
const implementedExportEndpoints = new Set(['download-export', 'export-project', 'get-export'])
const readySessionId = 'export-ready'
const readyPackagePath = `tmp/project-transfer/export/${readySessionId}/package.zip`

const getMetadata = (overrides: Record<string, unknown> = {}) => {
  return {
    byteLength: 8,
    checksumSha256: 'a'.repeat(64),
    downloadUrl: '/api/projects/export/export-1/download',
    expiresAt: futureDate.toISOString(),
    filename: 'project-transfer-project-1-fingerprint.zip',
    packageFingerprint: 'fingerprint-1',
    ...overrides,
  }
}

const getInlineExportResult = () => {
  const packageBytes = textEncoder.encode('zip-body')

  return {
    executionMode: 'inline' as const,
    manifest: {},
    metadata: getMetadata({
      byteLength: packageBytes.byteLength,
      filename: 'project-transfer-project-1.zip',
      packageFingerprint: 'inline-fingerprint',
    }),
    packageBytes,
  }
}

const getBackgroundExportResult = () => {
  return {
    executionMode: 'background' as const,
    metadata: getMetadata({
      downloadUrl: '/api/projects/export/export-large/download',
      filename: 'project-transfer-project-1-large.zip',
    }),
    session: null,
    sessionId: 'export-large',
  }
}

const routeState: {
  exportResult: unknown
  projectRows: SourceProjectRow[]
  queryStatements: string[]
  sessions: Record<string, ProjectTransferSessionRecord | null>
} = {
  exportResult: getInlineExportResult(),
  projectRows: [{deletePendingAt: null, id: 'project-1'}],
  queryStatements: [],
  sessions: {},
}

const queryJsonMock = mock(async (statement: string) => {
  routeState.queryStatements.push(statement)

  return routeState.projectRows
})

const createProjectTransferExportMock = mock(async (_input: {projectId: string}) => {
  return routeState.exportResult
})

const getProjectTransferSessionMock = mock(async ({sessionId}: {sessionId: string}) => {
  return routeState.sessions[sessionId] ?? null
})

void mock.module(appDatabaseServiceModulePath, () => {
  return {
    getAppDatabaseService: () => {
      return {queryJson: queryJsonMock}
    },
  }
})

void mock.module(exportPackageModulePath, () => {
  return {createProjectTransferExport: createProjectTransferExportMock}
})

void mock.module(sessionRepositoryModulePath, () => {
  return {
    getProjectTransferSessionRepository: () => {
      return {getProjectTransferSession: getProjectTransferSessionMock}
    },
  }
})

const loadProjectTransferRoutes = async (): Promise<typeof import('./projectTransferRoutes.ts')> => {
  return (await import(
    `./projectTransferRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./projectTransferRoutes.ts')
}

const loadProductApiRoutes = async (): Promise<typeof import('./productApiRoutes.ts')> => {
  return (await import(
    `./productApiRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as typeof import('./productApiRoutes.ts')
}

const getProjectTransferApp = async () => {
  const {projectTransferRoutes} = await loadProjectTransferRoutes()

  return new Elysia().use(projectTransferRoutes)
}

const getRequestInit = (method: string): RequestInit => {
  return bodyMethods.has(method)
    ? {body: JSON.stringify({}), headers: {'content-type': 'application/json'}, method}
    : {method}
}

const getRouteResponse = async (app: RouteTestApp, path: string, method: string) => {
  return app.handle(new Request(`http://localhost${path}`, getRequestInit(method)))
}

const getPlaceholderBody = async (response: Response) => {
  return (await response.json()) as PlaceholderResponseBody
}

const getSessionRecord = (overrides: Partial<ProjectTransferSessionRecord> = {}): ProjectTransferSessionRecord => {
  return {
    commitId: null,
    completionPayloadJson: null,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    direction: 'export',
    errorJson: null,
    expiresAt: futureDate,
    heartbeatAt: null,
    id: 'export-1',
    ownerToken: null,
    packageFingerprint: null,
    planRevision: 0,
    planSummaryJson: null,
    progressJson: null,
    state: 'queued',
    terminalCleanupAt: null,
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

const getReadySessionRecord = (overrides: Partial<ProjectTransferSessionRecord> = {}) => {
  const metadata = getMetadata({
    byteLength: textEncoder.encode('download-body').byteLength,
    downloadUrl: `/api/projects/export/${readySessionId}/download`,
    filename: 'metadata-export.zip',
    packageFingerprint: 'ready-fingerprint',
  })

  return getSessionRecord({
    completionPayloadJson: {status: 'ready', ...metadata},
    id: readySessionId,
    packageFingerprint: metadata.packageFingerprint,
    state: 'ready',
    ...overrides,
  })
}

const expectCsvExportRouteValidationResponse = async (app: RouteTestApp, prefix = '') => {
  const response = await getRouteResponse(app, `${prefix}${csvExportRoute.samplePath}`, csvExportRoute.method)
  const body = (await response.json()) as {message: string; property: string; type: string}

  expect(response.status).toBe(422)
  expect(body).toMatchObject({message: 'Expected array', property: '/promptIds', type: 'validation'})
}

afterEach(() => {
  createProjectTransferExportMock.mockClear()
  getProjectTransferSessionMock.mockClear()
  queryJsonMock.mockClear()
  routeState.exportResult = getInlineExportResult()
  routeState.projectRows = [{deletePendingAt: null, id: 'project-1'}]
  routeState.queryStatements.length = 0
  routeState.sessions = {}
  rmSync(`tmp/project-transfer/export/${readySessionId}`, {force: true, recursive: true})
})

afterAll(() => {
  mock.restore()
})

test('project transfer export route returns an inline zip with server metadata headers', async () => {
  const app = await getProjectTransferApp()

  const response = await getRouteResponse(app, '/api/projects/project-1/export-project', 'POST')

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="project-transfer-project-1.zip"')
  expect(response.headers.get('content-length')).toBe('8')
  expect(response.headers.get('x-project-transfer-checksum-sha256')).toBe('a'.repeat(64))
  expect(response.headers.get('x-project-transfer-package-fingerprint')).toBe('inline-fingerprint')
  expect(await response.text()).toBe('zip-body')
  expect(createProjectTransferExportMock).toHaveBeenCalledWith({projectId: 'project-1'})
})

test('project transfer export route returns queued JSON for large exports without package bytes', async () => {
  routeState.exportResult = getBackgroundExportResult()
  const app = await getProjectTransferApp()

  const response = await getRouteResponse(app, '/api/projects/project-1/export-project', 'POST')
  const text = await response.text()
  const body = JSON.parse(text) as {
    data: {downloadUrl: string; expiresAt: string; exportId: string; filename: string; status: string}
    error: string | null
  }

  expect(response.status).toBe(202)
  expect(body).toEqual({
    data: {
      downloadUrl: '/api/projects/export/export-large/download',
      expiresAt: futureDate.toISOString(),
      exportId: 'export-large',
      filename: 'project-transfer-project-1-large.zip',
      status: 'queued',
    },
    error: null,
  })
  expect(text).not.toContain('zip-body')
})

test('project transfer export route allows archived projects and rejects missing or pending-delete projects before assembly', async () => {
  const app = await getProjectTransferApp()
  routeState.projectRows = [{deletePendingAt: null, id: 'archived-project'}]

  const archivedResponse = await getRouteResponse(app, '/api/projects/archived-project/export-project', 'POST')

  expect(archivedResponse.status).toBe(200)
  expect(createProjectTransferExportMock).toHaveBeenCalledWith({projectId: 'archived-project'})

  createProjectTransferExportMock.mockClear()
  routeState.projectRows = []

  const missingResponse = await getRouteResponse(app, '/api/projects/missing-project/export-project', 'POST')
  const missingBody = (await missingResponse.json()) as {data: null; error: string}

  expect(missingResponse.status).toBe(404)
  expect(missingBody.error).toBe('Project not found')
  expect(createProjectTransferExportMock).not.toHaveBeenCalled()

  routeState.projectRows = [{deletePendingAt: new Date('2030-01-01T00:00:00.000Z'), id: 'pending-delete'}]

  const pendingDeleteResponse = await getRouteResponse(app, '/api/projects/pending-delete/export-project', 'POST')
  const pendingDeleteBody = (await pendingDeleteResponse.json()) as {data: null; error: string}

  expect(pendingDeleteResponse.status).toBe(409)
  expect(pendingDeleteBody.error).toBe('Project is pending permanent deletion')
  expect(createProjectTransferExportMock).not.toHaveBeenCalled()
})

test('project transfer export polling returns pending progress and ready metadata', async () => {
  const app = await getProjectTransferApp()
  routeState.sessions['export-pending'] = getSessionRecord({
    id: 'export-pending',
    progressJson: {percent: 25, phase: 'export_assembly', status: 'running'},
    state: 'assembling',
  })
  routeState.sessions[readySessionId] = getReadySessionRecord()

  const pendingResponse = await getRouteResponse(app, '/api/projects/export/export-pending', 'GET')
  const pendingBody = (await pendingResponse.json()) as {
    data: {exportId: string; progress: {percent: number}; status: string}
    error: string | null
  }
  const readyResponse = await getRouteResponse(app, `/api/projects/export/${readySessionId}`, 'GET')
  const readyBody = (await readyResponse.json()) as {
    data: {byteLength: number; downloadUrl: string; exportId: string; filename: string; packageFingerprint: string}
    error: string | null
  }

  expect(pendingResponse.status).toBe(200)
  expect(pendingBody).toMatchObject({
    data: {exportId: 'export-pending', progress: {percent: 25}, status: 'assembling'},
    error: null,
  })
  expect(readyResponse.status).toBe(200)
  expect(readyBody).toMatchObject({
    data: {
      byteLength: 13,
      downloadUrl: `/api/projects/export/${readySessionId}/download`,
      exportId: readySessionId,
      filename: 'metadata-export.zip',
      packageFingerprint: 'ready-fingerprint',
    },
    error: null,
  })
})

test('project transfer export polling rejects missing, wrong-direction, failed, and expired sessions', async () => {
  const app = await getProjectTransferApp()
  routeState.sessions['import-session'] = getSessionRecord({
    direction: 'import',
    id: 'import-session',
    state: 'awaiting_upload',
  })
  routeState.sessions['failed-session'] = getSessionRecord({id: 'failed-session', state: 'failed'})
  routeState.sessions['expired-session'] = getSessionRecord({id: 'expired-session', state: 'expired'})
  routeState.sessions['ready-expired-session'] = getReadySessionRecord({
    expiresAt: pastDate,
    id: 'ready-expired-session',
  })

  const cases = [
    {error: 'Project transfer export session not found', id: 'missing-session', status: 404},
    {error: 'Project transfer session is not an export session', id: 'import-session', status: 409},
    {error: 'Project transfer export failed', id: 'failed-session', status: 409},
    {error: 'Project transfer export session expired', id: 'expired-session', status: 410},
    {error: 'Project transfer export session expired', id: 'ready-expired-session', status: 410},
  ]
  const responses = await Promise.all(
    cases.map(async (testCase) => {
      const response = await getRouteResponse(app, `/api/projects/export/${testCase.id}`, 'GET')
      const body = (await response.json()) as {data: null; error: string}

      return {body, status: response.status}
    }),
  )

  expect(responses).toEqual(
    cases.map((testCase) => {
      return {body: {data: null, error: testCase.error}, status: testCase.status}
    }),
  )
})

test('project transfer export download returns non-ready session JSON before touching artifacts', async () => {
  const app = await getProjectTransferApp()
  routeState.sessions['export.queued'] = getSessionRecord({id: 'export.queued', state: 'queued'})

  const response = await getRouteResponse(app, '/api/projects/export/export.queued/download', 'GET')
  const body = (await response.json()) as {data: {exportId: string; status: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({data: {exportId: 'export.queued', status: 'queued'}, error: null})
})

test('project transfer export download streams the ready package with metadata headers', async () => {
  const app = await getProjectTransferApp()
  mkdirSync(`tmp/project-transfer/export/${readySessionId}`, {recursive: true})
  await globalThis.Bun.write(readyPackagePath, 'download-body')
  routeState.sessions[readySessionId] = getReadySessionRecord()

  const response = await getRouteResponse(app, `/api/projects/export/${readySessionId}/download`, 'GET')

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="metadata-export.zip"')
  expect(response.headers.get('content-length')).toBe('13')
  expect(response.headers.get('x-project-transfer-checksum-sha256')).toBe('a'.repeat(64))
  expect(response.headers.get('x-project-transfer-package-fingerprint')).toBe('ready-fingerprint')
  expect(await response.text()).toBe('download-body')
})

test('project transfer export download rejects expired ready sessions before touching artifacts', async () => {
  const app = await getProjectTransferApp()
  routeState.sessions['export.expired'] = getReadySessionRecord({expiresAt: pastDate, id: 'export.expired'})

  const response = await getRouteResponse(app, '/api/projects/export/export.expired/download', 'GET')
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(410)
  expect(body.error).toBe('Project transfer export session expired')
})

test('project transfer import endpoints continue returning contract-safe placeholders', async () => {
  const {projectTransferRouteSpecs} = await loadProjectTransferRoutes()
  const app = await getProjectTransferApp()
  const importRoutes = projectTransferRouteSpecs.filter((route) => {
    return !implementedExportEndpoints.has(route.endpoint)
  })
  const responses = await Promise.all(
    importRoutes.map(async (route) => {
      const response = await getRouteResponse(app, route.samplePath, route.method)
      const body = await getPlaceholderBody(response)

      return {body, endpoint: route.endpoint, status: response.status}
    }),
  )

  expect(responses).toEqual(
    importRoutes.map((route) => {
      return {
        body: {data: null, error: `Project transfer ${route.endpoint} endpoint is not implemented yet`},
        endpoint: route.endpoint,
        status: 501,
      }
    }),
  )
})

test('product route composition keeps project transfer export before project id routes', async () => {
  const {getProductApiRoutes} = await loadProductApiRoutes()
  const app = getProductApiRoutes()

  const response = await getRouteResponse(app, '/api/projects/project-1/export-project', 'POST')

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(await response.text()).toBe('zip-body')
})

test('owner-private product route composition keeps project transfer export before project id routes', async () => {
  const {getProductApiRoutes} = await loadProductApiRoutes()
  const app = new Elysia({prefix: duckdbOwnerPrivateApiPrefix}).use(getProductApiRoutes())

  const response = await getRouteResponse(
    app,
    `${duckdbOwnerPrivateApiPrefix}/api/projects/project-1/export-project`,
    'POST',
  )

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(await response.text()).toBe('zip-body')
})

test('existing CSV project export route remains classified separately from project transfer export', async () => {
  const {getProductApiRoutes} = await loadProductApiRoutes()

  await expectCsvExportRouteValidationResponse(getProductApiRoutes())
})

test('owner-private existing CSV project export route remains classified separately from transfer export', async () => {
  const {getProductApiRoutes} = await loadProductApiRoutes()
  const app = new Elysia({prefix: duckdbOwnerPrivateApiPrefix}).use(getProductApiRoutes())

  await expectCsvExportRouteValidationResponse(app, duckdbOwnerPrivateApiPrefix)
})
