import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs'

import {afterAll, afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

import type {ProjectTransferSessionRecord} from '../../db/schemaTypes.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'

type RouteTestApp = {handle: (request: Request) => Promise<Response> | Response}
type PlaceholderResponseBody = {data: null; error: string}
type SourceProjectRow = {deletePendingAt: unknown; id: string}

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const analyzeModulePath = new URL('../services/projectTransfer/projectTransferAnalyze.ts', import.meta.url).pathname
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
const readySessionId = 'export-ready'
const readyPackagePath = `tmp/project-transfer/export/${readySessionId}/package.zip`
const uploadSessionId = 'import-upload'
const uploadPackagePath = `tmp/project-transfer/import/${uploadSessionId}/upload.zip`

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

const analyzeProjectTransferImportPackageMock = mock(async (input: {planRevision: number}) => {
  const planSummary = {
    blockerCount: 1,
    blockers: [
      {
        code: 'package_contract_blocker',
        message: 'Package contract requires a new package or target changes',
        resolutionKind: 'requires_new_package_or_target_changes',
        scope: 'manifest',
      },
    ],
    conflictCounts: {
      articleIdentifier: 0,
      dependency: 0,
      humanReview: 0,
      judgment: 0,
      packageContract: 1,
      projectPrompt: 0,
    },
    dependencyStatuses: {},
    overlapCounts: {exactDuplicateImports: 0, reusedArticles: 0},
    packageCounts: {
      articleImportRoutes: 0,
      articles: 1,
      assetManifest: 0,
      humanJudgmentSummaries: 0,
      humanJudgments: 0,
      importRoutes: 0,
      judgmentAssessments: 0,
      judgments: 0,
      models: 1,
      project: 1,
      projectArticles: 0,
      projectImportRoutes: 0,
      projectPrompts: 0,
      prompts: 0,
      providerConnections: 0,
      reviews: 0,
    },
    packageFingerprint: 'analyzed-fingerprint',
    packageWarnings: [],
    warningCount: 0,
  }

  return {
    analysis: {},
    packageFingerprint: 'analyzed-fingerprint',
    plan: {canCommit: false, planRevision: input.planRevision},
    planSummary,
  }
})

const getProjectTransferSessionMock = mock(async ({sessionId}: {sessionId: string}) => {
  return routeState.sessions[sessionId] ?? null
})

const getNow = (now?: Date) => {
  return now ?? new Date('2030-01-01T00:00:00.000Z')
}

const getStateMatches = (currentState: string, expectedState: string | string[]) => {
  return Array.isArray(expectedState) ? expectedState.includes(currentState) : currentState === expectedState
}

const getOwnerMatches = (currentOwner: string | null, expectedOwnerToken?: string | null) => {
  return expectedOwnerToken === undefined ? true : currentOwner === expectedOwnerToken
}

const getPlanRevisionMatches = (currentRevision: number, expectedPlanRevision?: number) => {
  return expectedPlanRevision === undefined ? true : currentRevision === expectedPlanRevision
}

const createProjectTransferSessionMock = mock(
  async (params: {
    direction: ProjectTransferSessionRecord['direction']
    expiresAt: Date
    id: string
    now?: Date
    packageFingerprint?: string | null
    state?: ProjectTransferSessionRecord['state']
  }) => {
    const record = getSessionRecord({
      createdAt: getNow(params.now),
      direction: params.direction,
      expiresAt: params.expiresAt,
      id: params.id,
      packageFingerprint: params.packageFingerprint ?? null,
      state: params.state ?? 'awaiting_upload',
      updatedAt: getNow(params.now),
    })
    routeState.sessions[params.id] = record

    return record
  },
)

const transitionProjectTransferSessionStateMock = mock(
  async (params: {
    error?: unknown
    expectedOwnerToken?: string | null
    expectedPlanRevision?: number
    expectedState: string | string[]
    nextOwnerToken?: string | null
    nextState: ProjectTransferSessionRecord['state']
    now?: Date
    packageFingerprint?: string | null
    planSummary?: unknown
    progress?: unknown
    sessionId: string
  }) => {
    const current = routeState.sessions[params.sessionId] ?? null

    if (
      current === null
      || !getStateMatches(current.state, params.expectedState)
      || !getOwnerMatches(current.ownerToken, params.expectedOwnerToken)
      || !getPlanRevisionMatches(current.planRevision, params.expectedPlanRevision)
    ) {
      return null
    }

    const now = getNow(params.now)
    const next = {
      ...current,
      errorJson: Object.hasOwn(params, 'error') ? params.error : current.errorJson,
      heartbeatAt: typeof params.nextOwnerToken === 'string' ? now : current.heartbeatAt,
      ownerToken: Object.hasOwn(params, 'nextOwnerToken') ? (params.nextOwnerToken ?? null) : current.ownerToken,
      packageFingerprint: Object.hasOwn(params, 'packageFingerprint')
        ? (params.packageFingerprint ?? null)
        : current.packageFingerprint,
      planSummaryJson: Object.hasOwn(params, 'planSummary') ? (params.planSummary ?? null) : current.planSummaryJson,
      progressJson: Object.hasOwn(params, 'progress') ? (params.progress ?? null) : current.progressJson,
      state: params.nextState,
      updatedAt: now,
    }
    routeState.sessions[params.sessionId] = next

    return next
  },
)

const updateProjectTransferSessionPlanRevisionMock = mock(
  async (params: {
    expectedOwnerToken?: string | null
    expectedPlanRevision: number
    nextState?: ProjectTransferSessionRecord['state']
    now?: Date
    planSummary: unknown
    sessionId: string
  }) => {
    const current = routeState.sessions[params.sessionId] ?? null

    if (
      current === null
      || !getOwnerMatches(current.ownerToken, params.expectedOwnerToken)
      || current.planRevision !== params.expectedPlanRevision
    ) {
      return null
    }

    const next = {
      ...current,
      planRevision: current.planRevision + 1,
      planSummaryJson: params.planSummary,
      state: params.nextState ?? current.state,
      updatedAt: getNow(params.now),
    }
    routeState.sessions[params.sessionId] = next

    return next
  },
)

const heartbeatProjectTransferSessionOwnerMock = mock(
  async (params: {leaseMs: number; now?: Date; ownerToken: string; sessionId: string}) => {
    const current = routeState.sessions[params.sessionId] ?? null

    if (current === null || current.ownerToken !== params.ownerToken) {
      return null
    }

    const next = {...current, heartbeatAt: getNow(params.now)}
    routeState.sessions[params.sessionId] = next

    return next
  },
)

const cancelProjectTransferImportSessionMock = mock(
  async (params: {
    error: unknown
    expectedOwnerToken?: string | null
    expectedState: ProjectTransferSessionRecord['state'][]
    nextState: 'cancelled' | 'expired'
    now?: Date
    ownerToken: string
    progress?: unknown
    sessionId: string
  }) => {
    const current = routeState.sessions[params.sessionId] ?? null

    if (
      current === null
      || !params.expectedState.includes(current.state)
      || !getOwnerMatches(current.ownerToken, params.expectedOwnerToken)
    ) {
      return null
    }

    const next = {
      ...current,
      errorJson: params.error,
      heartbeatAt: getNow(params.now),
      ownerToken: params.ownerToken,
      progressJson: params.progress ?? null,
      state: params.nextState,
      updatedAt: getNow(params.now),
    }
    routeState.sessions[params.sessionId] = next

    return next
  },
)

const markProjectTransferSessionTerminalCleanupCompleteMock = mock(
  async (params: {
    expectedOwnerToken?: string | null
    expectedState?: string | string[]
    now?: Date
    sessionId: string
  }) => {
    const current = routeState.sessions[params.sessionId] ?? null

    if (
      current === null
      || !getOwnerMatches(current.ownerToken, params.expectedOwnerToken)
      || (params.expectedState !== undefined && !getStateMatches(current.state, params.expectedState))
    ) {
      return null
    }

    const next = {...current, terminalCleanupAt: getNow(params.now)}
    routeState.sessions[params.sessionId] = next

    return next
  },
)

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

void mock.module(analyzeModulePath, () => {
  return {analyzeProjectTransferImportPackage: analyzeProjectTransferImportPackageMock}
})

void mock.module(sessionRepositoryModulePath, () => {
  return {
    getProjectTransferSessionRepository: () => {
      return {
        cancelProjectTransferImportSession: cancelProjectTransferImportSessionMock,
        createProjectTransferSession: createProjectTransferSessionMock,
        getProjectTransferSession: getProjectTransferSessionMock,
        heartbeatProjectTransferSessionOwner: heartbeatProjectTransferSessionOwnerMock,
        markProjectTransferSessionTerminalCleanupComplete: markProjectTransferSessionTerminalCleanupCompleteMock,
        transitionProjectTransferSessionState: transitionProjectTransferSessionStateMock,
        updateProjectTransferSessionPlanRevision: updateProjectTransferSessionPlanRevisionMock,
      }
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

const getUploadMetadata = (text: string) => {
  return {
    byteLength: textEncoder.encode(text).byteLength,
    checksumSha256: createHash('sha256').update(text).digest('hex'),
    fileName: 'upload.zip',
  }
}

const getImportSessionRecord = (overrides: Partial<ProjectTransferSessionRecord> = {}) => {
  return getSessionRecord({direction: 'import', id: 'import-session-1', state: 'awaiting_upload', ...overrides})
}

const expectCsvExportRouteValidationResponse = async (app: RouteTestApp, prefix = '') => {
  const response = await getRouteResponse(app, `${prefix}${csvExportRoute.samplePath}`, csvExportRoute.method)
  const body = (await response.json()) as {message: string; property: string; type: string}

  expect(response.status).toBe(422)
  expect(body).toMatchObject({message: 'Expected array', property: '/promptIds', type: 'validation'})
}

afterEach(() => {
  analyzeProjectTransferImportPackageMock.mockClear()
  cancelProjectTransferImportSessionMock.mockClear()
  createProjectTransferSessionMock.mockClear()
  createProjectTransferExportMock.mockClear()
  getProjectTransferSessionMock.mockClear()
  heartbeatProjectTransferSessionOwnerMock.mockClear()
  markProjectTransferSessionTerminalCleanupCompleteMock.mockClear()
  queryJsonMock.mockClear()
  transitionProjectTransferSessionStateMock.mockClear()
  updateProjectTransferSessionPlanRevisionMock.mockClear()
  routeState.exportResult = getInlineExportResult()
  routeState.projectRows = [{deletePendingAt: null, id: 'project-1'}]
  routeState.queryStatements.length = 0
  routeState.sessions = {}
  rmSync(`tmp/project-transfer/export/${readySessionId}`, {force: true, recursive: true})
  rmSync('tmp/project-transfer/import', {force: true, recursive: true})
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

test('project transfer import session creation returns public URLs without temp paths', async () => {
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/sessions', {
      body: JSON.stringify({sessionId: 'import-create'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const text = await response.text()
  const body = JSON.parse(text) as {
    data: {
      analyzeUrl: string
      expiresAt: string
      sessionUrl: string
      state: string
      uploadPath?: string
      uploadUrl: string
    }
    error: string | null
  }

  expect(response.status).toBe(201)
  expect(body.error).toBe(null)
  expect(body.data).toMatchObject({
    analyzeUrl: '/api/projects/import/import-create/analyze',
    sessionUrl: '/api/projects/import/import-create',
    state: 'awaiting_upload',
    uploadUrl: '/api/projects/import/import-create/upload',
  })
  expect(body.data.expiresAt).toContain('T')
  expect(text).not.toContain('uploadPath')
  expect(text).not.toContain('tmp/project-transfer')
  expect(createProjectTransferSessionMock).toHaveBeenCalled()
})

test('project transfer import upload streams to upload.zip and persists public metadata', async () => {
  routeState.sessions[uploadSessionId] = getImportSessionRecord({id: uploadSessionId})
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request(`http://localhost/api/projects/import/${uploadSessionId}/upload`, {
      body: textEncoder.encode('zip-body'),
      headers: {'content-type': 'application/zip'},
      method: 'PUT',
    }),
  )
  const text = await response.text()
  const body = JSON.parse(text) as {
    data: {state: string; upload: {byteLength: number; checksumSha256: string; fileName: string}; uploadPath?: string}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body.error).toBe(null)
  expect(body.data.state).toBe('queued')
  expect(body.data.upload).toEqual(getUploadMetadata('zip-body'))
  expect(readFileSync(uploadPackagePath, 'utf8')).toBe('zip-body')
  expect(text).not.toContain('uploadPath')
  expect(text).not.toContain('tmp/project-transfer')
})

test('project transfer import analyze claims queued uploads and writes an inline contract plan', async () => {
  routeState.sessions['import-analyze'] = getImportSessionRecord({
    id: 'import-analyze',
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/import-analyze/analyze', {
      body: JSON.stringify({}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {
    data: {
      blockers: string[]
      canCommit: boolean
      executionMode: string
      planRevision: number
      planSummary: {blockerCount: number}
      state: string
    }
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body.error).toBe(null)
  expect(body.data.state).toBe('awaiting_resolution')
  expect(body.data.executionMode).toBe('inline')
  expect(body.data.planRevision).toBe(1)
  expect(body.data.planSummary.blockerCount).toBe(1)
  expect(body.data.blockers).toHaveLength(1)
  expect(body.data.canCommit).toBe(false)
})

test('project transfer import analyze returns accepted for background-sized work', async () => {
  routeState.sessions['import-background-analyze'] = getImportSessionRecord({
    id: 'import-background-analyze',
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/import-background-analyze/analyze', {
      body: JSON.stringify({expandedBytes: 1024 * 1024 * 1024}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {executionMode: string; state: string}; error: string | null}

  expect(response.status).toBe(202)
  expect(body).toMatchObject({data: {executionMode: 'background', state: 'extracting'}, error: null})
})

test('project transfer import resolve remains a validated no-write shell and commit remains a placeholder', async () => {
  routeState.sessions['import-resolve'] = getImportSessionRecord({
    id: 'import-resolve',
    planRevision: 1,
    planSummaryJson: {
      blockerCount: 1,
      conflictCounts: {
        articleIdentifier: 0,
        dependency: 0,
        humanReview: 0,
        judgment: 0,
        packageContract: 0,
        projectPrompt: 0,
      },
      dependencyStatuses: {},
      overlapCounts: {exactDuplicateImports: 0, reusedArticles: 0},
      warningCount: 0,
    },
    state: 'awaiting_resolution',
  })
  const app = await getProjectTransferApp()

  const resolveResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-resolve/resolve-dependencies', {
      body: JSON.stringify({expectedPlanRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const resolveBody = (await resolveResponse.json()) as {data: {state: string}; error: string | null}
  const commitResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-resolve/commit', {
      body: JSON.stringify({expectedPlanRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const commitBody = await getPlaceholderBody(commitResponse)

  expect(resolveResponse.status).toBe(200)
  expect(resolveBody).toMatchObject({data: {state: 'awaiting_resolution'}, error: null})
  expect(commitResponse.status).toBe(501)
  expect(commitBody.error).toBe('Project transfer commit-import-session endpoint is not implemented yet')
})

test('project transfer import cancellation cleans temp artifacts and repeats idempotently', async () => {
  routeState.sessions[uploadSessionId] = getImportSessionRecord({
    errorJson: null,
    id: uploadSessionId,
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  mkdirSync(`tmp/project-transfer/import/${uploadSessionId}`, {recursive: true})
  await globalThis.Bun.write(uploadPackagePath, 'zip-body')
  const app = await getProjectTransferApp()

  const cancelResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${uploadSessionId}`, {
      body: JSON.stringify({reason: 'user_cancelled'}),
      headers: {'content-type': 'application/json'},
      method: 'DELETE',
    }),
  )
  const cancelBody = (await cancelResponse.json()) as {data: {state: string}; error: string | null}
  const repeatResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${uploadSessionId}`, {
      body: JSON.stringify({}),
      headers: {'content-type': 'application/json'},
      method: 'DELETE',
    }),
  )
  const repeatBody = (await repeatResponse.json()) as {data: {state: string}; error: string | null}

  expect(cancelResponse.status).toBe(200)
  expect(cancelBody).toMatchObject({data: {state: 'cancelled'}, error: null})
  expect(existsSync(uploadPackagePath)).toBe(false)
  expect(repeatResponse.status).toBe(200)
  expect(repeatBody).toMatchObject({data: {state: 'cancelled'}, error: null})
  expect(cancelProjectTransferImportSessionMock).toHaveBeenCalledTimes(1)
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
