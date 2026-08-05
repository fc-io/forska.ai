import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'

import {afterEach, beforeEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

import type {ProjectTransferSessionRecord} from '../../db/schemaTypes.ts'
import {duckdbOwnerPrivateApiPrefix} from './apiRouteClassification.ts'

type RouteTestApp = {handle: (request: Request) => Promise<Response> | Response}
type SourceProjectRow = {deletePendingAt: unknown; id: string}

const analyzeModulePath = new URL('../services/projectTransfer/projectTransferAnalyze.ts', import.meta.url).pathname
const commitModulePath = new URL('../services/projectTransfer/projectTransferCommit.ts', import.meta.url).pathname
const exportModulePath = new URL('../services/projectTransfer/projectTransferExport.ts', import.meta.url).pathname
const exportPackageModulePath = new URL('../services/projectTransfer/projectTransferExportPackage.ts', import.meta.url)
  .pathname
const actualCommitModule = (await import(
  `${commitModulePath}?projectTransferRoutesActual=${Date.now()}-${Math.random()}`
)) as typeof import('../services/projectTransfer/projectTransferCommit.ts')
const dependencyResolutionModulePath = new URL(
  '../services/projectTransfer/projectTransferDependencyResolution.ts',
  import.meta.url,
).pathname
const sessionRepositoryModulePath = new URL(
  '../services/projectTransfer/projectTransferSessionRepository.ts',
  import.meta.url,
).pathname

const textEncoder = new TextEncoder()
const futureDate = new Date('2035-01-01T00:00:00.000Z')
const pastDate = new Date('2020-01-01T00:00:00.000Z')
const bodyMethods = new Set(['PATCH', 'POST', 'PUT'])
const csvExportRoute = {method: 'POST', samplePath: '/api/projects/project-1/export'} as const
const routeTestSessionPrefix = `routes-${process.pid}-${Date.now().toString(36)}-${Math.random()
  .toString(16)
  .slice(2, 8)}`
const getRouteTestSessionId = (name: string) => {
  return `${routeTestSessionPrefix}-${name}`
}
const getImportRootPath = (sessionId: string) => {
  return `tmp/project-transfer/import/${sessionId}`
}
const getExportRootPath = (sessionId: string) => {
  return `tmp/project-transfer/export/${sessionId}`
}
const getImportPlanPath = (sessionId: string) => {
  return `${getImportRootPath(sessionId)}/plan.json`
}
const getImportProgressPath = (sessionId: string) => {
  return `${getImportRootPath(sessionId)}/progress.json`
}
const getUploadPackagePath = (sessionId: string) => {
  return `${getImportRootPath(sessionId)}/upload.zip`
}
const getReadyPackagePath = (sessionId: string) => {
  return `${getExportRootPath(sessionId)}/package.zip`
}
const readySessionId = getRouteTestSessionId('export-ready')
const readyPackagePath = getReadyPackagePath(readySessionId)
const progressArtifactSessionId = getRouteTestSessionId('export-progress-artifact')
const uploadSessionId = getRouteTestSessionId('import-upload')
const uploadPackagePath = getUploadPackagePath(uploadSessionId)
const uploadArrayBufferSessionId = getRouteTestSessionId('import-upload-buffer')
const readOnlyGetSessionId = getRouteTestSessionId('import-read-only-get')
const progressArtifactImportSessionId = getRouteTestSessionId('import-progress-artifact')
const commitProgressArtifactImportSessionId = getRouteTestSessionId('import-commit-progress-artifact')
const completedArtifactImportSessionId = getRouteTestSessionId('import-completed-artifact')
const largeBackgroundAnalyzeSessionId = getRouteTestSessionId('import-large-background-analyze')
const missingArtifactsGetSessionId = getRouteTestSessionId('import-missing-get')
const resolveSessionId = getRouteTestSessionId('import-resolve')
const routeFlowSessionId = getRouteTestSessionId('route-flow')
const missingArtifactsResolveSessionId = getRouteTestSessionId('import-missing-resolve')
const resolveRaceSessionId = getRouteTestSessionId('import-resolve-race')
const artifactSessionIds = [
  readySessionId,
  progressArtifactSessionId,
  uploadSessionId,
  uploadArrayBufferSessionId,
  readOnlyGetSessionId,
  progressArtifactImportSessionId,
  commitProgressArtifactImportSessionId,
  completedArtifactImportSessionId,
  largeBackgroundAnalyzeSessionId,
  missingArtifactsGetSessionId,
  resolveSessionId,
  routeFlowSessionId,
  missingArtifactsResolveSessionId,
  resolveRaceSessionId,
] as const

const getFinalConflictCounts = (packageContractConflictCount = 0) => {
  return {
    articleConflictCount: 0,
    humanReviewFidelityConflictCount: 0,
    judgmentConflictCount: 0,
    packageContractConflictCount,
    projectPromptConflictCount: 0,
  }
}

const getFinalOverlapCounts = () => {
  return {
    currentReviewRowsSignatureHumanReviewCount: 0,
    currentReviewRowsSignatureJudgmentCount: 0,
    dirtiedExistingProjectCount: 0,
    duplicateImportMatchCount: 0,
    newArticleCount: 0,
    omittedArticleRouteLinkCount: 0,
    omittedRouteLinkCount: 0,
    reusedArticleAssetPromotionCount: 0,
    reusedArticleCount: 0,
    reusedArticleFieldFillCount: 0,
    reusedArticleUpdateCount: 0,
    reusedJudgmentCount: 0,
    routeArticleSnapshotLinkCount: 0,
    snapshotVerifiedJudgmentCount: 0,
    storedSignatureHumanReviewCount: 0,
    storedSignatureJudgmentCount: 0,
  }
}

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

const getDefaultAnalyzeResult = (planRevision: number) => {
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
    conflictCounts: getFinalConflictCounts(1),
    dependencyStatuses: {},
    overlapCounts: getFinalOverlapCounts(),
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

  return {analysis: {}, packageFingerprint: 'analyzed-fingerprint', plan: {canCommit: false, planRevision}, planSummary}
}

const routeState: {
  analyzeResult: unknown
  commitResult: unknown
  exportResult: unknown
  exportSummary: unknown
  projectRows: SourceProjectRow[]
  queryStatements: string[]
  resolveResult: unknown
  sessions: Record<string, ProjectTransferSessionRecord | null>
} = {
  analyzeResult: null,
  commitResult: null,
  exportResult: getInlineExportResult(),
  exportSummary: {
    articleCount: 2,
    humanJudgmentCount: 3,
    judgmentCount: 4,
    promptHumanJudgmentCount: 1,
    summaryHumanJudgmentCount: 2,
  },
  projectRows: [{deletePendingAt: null, id: 'project-1'}],
  queryStatements: [],
  resolveResult: {
    changed: true,
    plan: {},
    planSummary: {
      blockerCount: 0,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {'model:model-1': 'resolved', 'provider:provider-connection-1': 'resolved'},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    status: 'ok',
  },
  sessions: {},
}

const queryJsonMock = mock(async (statement: string) => {
  routeState.queryStatements.push(statement)

  return routeState.projectRows
})

const createProjectTransferExportMock = mock(
  async (_input: {projectId: string; rawArticleProvenanceMode?: 'include' | 'omit'}) => {
    return routeState.exportResult
  },
)
const getProjectTransferExportSummaryMock = mock(async (_projectId: string) => {
  return routeState.exportSummary
})

const analyzeProjectTransferImportPackageMock = mock(async (input: {planRevision: number}) => {
  return routeState.analyzeResult ?? getDefaultAnalyzeResult(input.planRevision)
})

const resolveProjectTransferDependenciesMock = mock(async (_input: unknown) => {
  return routeState.resolveResult
})

const writeProjectTransferDependencyPlanMock = mock(async (_input: unknown) => {})

const commitProjectTransferImportSessionMock = mock(async (input: {request: unknown; sessionId: string}) => {
  if (routeState.commitResult === null && !Object.hasOwn(routeState.sessions, input.sessionId)) {
    return actualCommitModule.commitProjectTransferImportSession(input)
  }

  const current = routeState.sessions[input.sessionId] ?? null

  return (
    routeState.commitResult
    ?? (current === null
      ? {error: 'Project transfer import session not found', status: 'error', statusCode: 404}
      : {
          completion: current.completionPayloadJson,
          history: null,
          session: current,
          status: 'completed',
          statusCode: 200,
        })
  )
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
    nextOwnerToken?: string | null
    nextState?: ProjectTransferSessionRecord['state']
    now?: Date
    packageFingerprint?: string | null
    planSummary: unknown
    progress?: unknown
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
      ownerToken: Object.hasOwn(params, 'nextOwnerToken') ? (params.nextOwnerToken ?? null) : current.ownerToken,
      packageFingerprint: Object.hasOwn(params, 'packageFingerprint')
        ? (params.packageFingerprint ?? null)
        : current.packageFingerprint,
      planRevision: current.planRevision + 1,
      planSummaryJson: params.planSummary,
      progressJson: Object.hasOwn(params, 'progress') ? (params.progress ?? null) : current.progressJson,
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

const updateProjectTransferSessionProgressMock = mock(
  async (params: {expectedOwnerToken?: string | null; now?: Date; progress: unknown; sessionId: string}) => {
    const current = routeState.sessions[params.sessionId] ?? null

    if (current === null || !getOwnerMatches(current.ownerToken, params.expectedOwnerToken)) {
      return null
    }

    const next = {...current, progressJson: params.progress, updatedAt: getNow(params.now)}
    routeState.sessions[params.sessionId] = next

    return next
  },
)

const installProjectTransferRouteMocks = () => {
  void mock.module(exportPackageModulePath, () => {
    return {createProjectTransferExport: createProjectTransferExportMock}
  })

  void mock.module(exportModulePath, () => {
    return {getProjectTransferExportSummary: getProjectTransferExportSummaryMock}
  })

  void mock.module(analyzeModulePath, () => {
    return {analyzeProjectTransferImportPackage: analyzeProjectTransferImportPackageMock}
  })

  void mock.module(commitModulePath, () => {
    return {
      commitProjectTransferImportSession: commitProjectTransferImportSessionMock,
      loadProjectTransferCommitArtifacts: actualCommitModule.loadProjectTransferCommitArtifacts,
      revalidateProjectTransferCommitPlan: actualCommitModule.revalidateProjectTransferCommitPlan,
    }
  })

  void mock.module(dependencyResolutionModulePath, () => {
    return {
      resolveProjectTransferDependencies: resolveProjectTransferDependenciesMock,
      writeProjectTransferDependencyPlan: writeProjectTransferDependencyPlanMock,
    }
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
          updateProjectTransferSessionProgress: updateProjectTransferSessionProgressMock,
        }
      },
    }
  })
}

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
  const {createProjectTransferRoutes} = await loadProjectTransferRoutes()

  return new Elysia().use(createProjectTransferRoutes({getExportSourceProject: getRouteTestExportSourceProject}))
}

const getRequestInit = (method: string, body: Record<string, unknown> = {}): RequestInit => {
  return bodyMethods.has(method)
    ? {body: JSON.stringify(body), headers: {'content-type': 'application/json'}, method}
    : {method}
}

const getRouteResponse = async (
  app: RouteTestApp,
  path: string,
  method: string,
  body: Record<string, unknown> = {},
) => {
  return app.handle(new Request(`http://localhost${path}`, getRequestInit(method, body)))
}

const getRouteTestExportSourceProject = async (projectId: string) => {
  const [project] = await queryJsonMock(`SELECT id FROM app.project WHERE id = '${projectId}' LIMIT 1`)

  return project ?? null
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

const resetProjectTransferRouteTestState = () => {
  analyzeProjectTransferImportPackageMock.mockClear()
  cancelProjectTransferImportSessionMock.mockClear()
  commitProjectTransferImportSessionMock.mockClear()
  createProjectTransferSessionMock.mockClear()
  createProjectTransferExportMock.mockClear()
  getProjectTransferSessionMock.mockClear()
  getProjectTransferExportSummaryMock.mockClear()
  heartbeatProjectTransferSessionOwnerMock.mockClear()
  markProjectTransferSessionTerminalCleanupCompleteMock.mockClear()
  queryJsonMock.mockClear()
  resolveProjectTransferDependenciesMock.mockClear()
  transitionProjectTransferSessionStateMock.mockClear()
  updateProjectTransferSessionPlanRevisionMock.mockClear()
  updateProjectTransferSessionProgressMock.mockClear()
  writeProjectTransferDependencyPlanMock.mockClear()
  routeState.exportResult = getInlineExportResult()
  routeState.exportSummary = {
    articleCount: 2,
    humanJudgmentCount: 3,
    judgmentCount: 4,
    promptHumanJudgmentCount: 1,
    summaryHumanJudgmentCount: 2,
  }
  routeState.commitResult = null
  routeState.analyzeResult = null
  routeState.projectRows = [{deletePendingAt: null, id: 'project-1'}]
  routeState.queryStatements.length = 0
  routeState.resolveResult = {
    changed: true,
    plan: {},
    planSummary: {
      blockerCount: 0,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {'model:model-1': 'resolved', 'provider:provider-connection-1': 'resolved'},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    status: 'ok',
  }
  routeState.sessions = {}
  for (const sessionId of artifactSessionIds) {
    rmSync(getExportRootPath(sessionId), {force: true, recursive: true})
    rmSync(getImportRootPath(sessionId), {force: true, recursive: true})
  }
}

beforeEach(async () => {
  installProjectTransferRouteMocks()
  const {setProjectTransferRoutesDependenciesForTests} = await import('./projectTransferRoutes.ts')
  setProjectTransferRoutesDependenciesForTests({getExportSourceProject: getRouteTestExportSourceProject})
  resetProjectTransferRouteTestState()
})

afterEach(async () => {
  resetProjectTransferRouteTestState()
  const {resetProjectTransferRoutesDependenciesForTests} = await import('./projectTransferRoutes.ts')
  resetProjectTransferRoutesDependenciesForTests()
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

test('project transfer export summary route returns export counts and default omit mode', async () => {
  const app = await getProjectTransferApp()

  const response = await getRouteResponse(app, '/api/projects/project-1/export-project', 'GET')
  const body = (await response.json()) as {data: Record<string, unknown>; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toEqual({
    data: {
      articleCount: 2,
      defaultRawArticleProvenanceMode: 'omit',
      humanJudgmentCount: 3,
      judgmentCount: 4,
      promptHumanJudgmentCount: 1,
      summaryHumanJudgmentCount: 2,
    },
    error: null,
  })
  expect(getProjectTransferExportSummaryMock).toHaveBeenCalledWith('project-1')
  expect(createProjectTransferExportMock).not.toHaveBeenCalled()
})

test('project transfer export route forwards raw article provenance mode', async () => {
  const app = await getProjectTransferApp()

  const response = await getRouteResponse(app, '/api/projects/project-1/export-project', 'POST', {
    rawArticleProvenanceMode: 'omit',
  })

  expect(response.status).toBe(200)
  expect(createProjectTransferExportMock).toHaveBeenCalledWith({
    projectId: 'project-1',
    rawArticleProvenanceMode: 'omit',
  })
})

test('project transfer export route rejects removed auto raw article provenance mode', async () => {
  const app = await getProjectTransferApp()

  const response = await getRouteResponse(app, '/api/projects/project-1/export-project', 'POST', {
    rawArticleProvenanceMode: 'auto',
  })
  const body = await response.text()

  expect(response.status).toBe(422)
  expect(body).toContain('rawArticleProvenanceMode')
  expect(createProjectTransferExportMock).not.toHaveBeenCalled()
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

test('project transfer export polling reads progress artifacts before the session repository', async () => {
  const app = await getProjectTransferApp()
  const progressPath = `${getExportRootPath(progressArtifactSessionId)}/progress.json`
  mkdirSync(getExportRootPath(progressArtifactSessionId), {recursive: true})
  writeFileSync(
    progressPath,
    JSON.stringify({
      expiresAt: futureDate.toISOString(),
      percent: 12,
      phase: 'export_assembly',
      startedAt: '2030-01-01T00:00:00.000Z',
      status: 'running',
      updatedAt: '2030-01-01T00:00:05.000Z',
      warningCount: 0,
    }),
  )

  const response = await getRouteResponse(app, `/api/projects/export/${progressArtifactSessionId}`, 'GET')
  const body = (await response.json()) as {
    data: {exportId: string; progress: {percent: number}; status: string}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {exportId: progressArtifactSessionId, progress: {percent: 12}, status: 'assembling'},
    error: null,
  })
  expect(getProjectTransferSessionMock).not.toHaveBeenCalled()
})

test('project transfer export polling rejects missing, wrong-direction, failed, and expired sessions', async () => {
  const app = await getProjectTransferApp()
  routeState.sessions['import-session'] = getSessionRecord({
    direction: 'import',
    id: 'import-session',
    state: 'awaiting_upload',
  })
  routeState.sessions['failed-session'] = getSessionRecord({
    errorJson: {message: 'Out of memory'},
    id: 'failed-session',
    state: 'failed',
  })
  routeState.sessions['expired-session'] = getSessionRecord({id: 'expired-session', state: 'expired'})
  routeState.sessions['ready-expired-session'] = getReadySessionRecord({
    expiresAt: pastDate,
    id: 'ready-expired-session',
  })

  const cases = [
    {error: 'Project transfer export session not found', id: 'missing-session', status: 404},
    {error: 'Project transfer session is not an export session', id: 'import-session', status: 409},
    {error: 'Project transfer export failed: Out of memory', id: 'failed-session', status: 409},
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
  mkdirSync(getExportRootPath(readySessionId), {recursive: true})
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

test('project transfer import endpoints reject expired sessions before mutation', async () => {
  routeState.sessions['import-expired-get'] = getImportSessionRecord({expiresAt: pastDate, id: 'import-expired-get'})
  routeState.sessions['import-expired-upload'] = getImportSessionRecord({
    expiresAt: pastDate,
    id: 'import-expired-upload',
  })
  routeState.sessions['import-expired-analyze'] = getImportSessionRecord({
    expiresAt: pastDate,
    id: 'import-expired-analyze',
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  const app = await getProjectTransferApp()

  const getResponse = await getRouteResponse(app, '/api/projects/import/import-expired-get', 'GET')
  const uploadResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-expired-upload/upload', {
      body: textEncoder.encode('zip-body'),
      headers: {'content-type': 'application/zip'},
      method: 'PUT',
    }),
  )
  const analyzeResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-expired-analyze/analyze', {
      body: JSON.stringify({expandedBytes: 0}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodies = await Promise.all([
    getResponse.json() as Promise<{data: null; error: string}>,
    uploadResponse.json() as Promise<{data: null; error: string}>,
    analyzeResponse.json() as Promise<{data: null; error: string}>,
  ])

  expect([getResponse.status, uploadResponse.status, analyzeResponse.status]).toEqual([410, 410, 410])
  expect(bodies).toEqual(
    [0, 1, 2].map(() => {
      return {data: null, error: 'Project transfer import session expired'}
    }),
  )
  expect(transitionProjectTransferSessionStateMock).not.toHaveBeenCalled()
  expect(analyzeProjectTransferImportPackageMock).not.toHaveBeenCalled()
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

test('project transfer import upload falls back when the request body has no reader', async () => {
  rmSync(getImportRootPath(uploadArrayBufferSessionId), {force: true, recursive: true})
  routeState.sessions[uploadArrayBufferSessionId] = getImportSessionRecord({id: uploadArrayBufferSessionId})
  const app = await getProjectTransferApp()
  const bytes = textEncoder.encode('zip-body')
  const request = new Request(`http://localhost/api/projects/import/${uploadArrayBufferSessionId}/upload`, {
    body: bytes,
    headers: {'content-type': 'application/zip'},
    method: 'PUT',
  })

  Object.defineProperty(request, 'arrayBuffer', {
    value: async () => {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  })
  Object.defineProperty(request, 'body', {value: {}})

  const response = await app.handle(request)
  const body = (await response.json()) as {
    data: {state: string; upload: {byteLength: number; checksumSha256: string; fileName: string}}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body.error).toBe(null)
  expect(body.data.state).toBe('queued')
  expect(body.data.upload).toEqual(getUploadMetadata('zip-body'))
})

test('project transfer import get ignores autoResolve query and remains read-only', async () => {
  routeState.sessions[readOnlyGetSessionId] = getImportSessionRecord({
    id: readOnlyGetSessionId,
    planRevision: 1,
    planSummaryJson: {
      blockerCount: 2,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {'model:model-1': 'missing', 'provider:provider-connection-1': 'missing'},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    state: 'awaiting_resolution',
  })
  mkdirSync(getImportRootPath(readOnlyGetSessionId), {recursive: true})
  await globalThis.Bun.write(getImportPlanPath(readOnlyGetSessionId), '{}')
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request(`http://localhost/api/projects/import/${readOnlyGetSessionId}?autoResolve=true`),
  )
  const body = (await response.json()) as {
    data: {planRevision: number; planSummary: {dependencyStatuses: Record<string, string>}; state: string}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {
      planRevision: 1,
      planSummary: {dependencyStatuses: {'model:model-1': 'missing', 'provider:provider-connection-1': 'missing'}},
      state: 'awaiting_resolution',
    },
    error: null,
  })
  expect(resolveProjectTransferDependenciesMock).not.toHaveBeenCalled()
  expect(writeProjectTransferDependencyPlanMock).not.toHaveBeenCalled()
})

test('project transfer import get caps bulky completed warning payloads', async () => {
  const completedWarningSessionId = getRouteTestSessionId('import-completed-warning-cap')
  const importWarnings = Array.from({length: 250}, (_, index) => {
    return {
      action: 'reused',
      code: index % 2 === 0 ? 'equivalentTargetJudgmentReused' : 'targetArticleImportRouteOmitted',
      message: `Warning ${index}`,
      scope: `warnings.${index}`,
      severity: 'info',
    }
  })
  routeState.sessions[completedWarningSessionId] = getImportSessionRecord({
    completionPayloadJson: {
      finalCounts: {warnings: importWarnings.length},
      importWarnings,
      packageFingerprint: 'fingerprint-warning-cap',
      projectId: 'imported-warning-cap-project',
      projectName: 'Imported Warning Cap Project',
      status: 'completed',
      targetProjectId: 'imported-warning-cap-project',
      targetProjectName: 'Imported Warning Cap Project',
      transferHistoryId: 'history-warning-cap',
    },
    id: completedWarningSessionId,
    state: 'completed',
  })
  const app = await getProjectTransferApp()

  const response = await getRouteResponse(app, `/api/projects/import/${completedWarningSessionId}`, 'GET')
  const body = (await response.json()) as {
    data: {completion: {finalCounts: {warnings: number}; importWarnings: Array<{code: string; details?: unknown}>}}
    error: string | null
  }
  const summaryWarning = body.data.completion.importWarnings.at(-1)

  expect(response.status).toBe(200)
  expect(body.error).toBe(null)
  expect(body.data.completion.finalCounts.warnings).toBe(250)
  expect(body.data.completion.importWarnings).toHaveLength(201)
  expect(summaryWarning?.code).toBe('postImportWarningsTruncated')
  expect(summaryWarning?.details).toMatchObject({
    codeCounts: {equivalentTargetJudgmentReused: 125, targetArticleImportRouteOmitted: 125},
    includedWarningCount: 200,
    omittedWarningCount: 50,
    totalWarningCount: 250,
  })
})

test('project transfer import get reads running progress artifacts before the session repository', async () => {
  const app = await getProjectTransferApp()
  mkdirSync(getImportRootPath(progressArtifactImportSessionId), {recursive: true})
  writeFileSync(
    getImportProgressPath(progressArtifactImportSessionId),
    JSON.stringify({
      expiresAt: futureDate.toISOString(),
      message: 'Analyzing target project state',
      phase: 'analyze',
      planRevision: 1,
      rowCountProcessed: 0,
      rowCountTotal: 89419,
      status: 'running',
      updatedAt: '2030-01-01T00:00:05.000Z',
      uploadMetadata: getUploadMetadata('zip-body'),
      warningCount: 3,
    }),
  )

  const response = await getRouteResponse(
    app,
    `/api/projects/import/${progressArtifactImportSessionId}?includePlan=true`,
    'GET',
  )
  const body = (await response.json()) as {
    data: {progress: {message: string}; state: string; upload: {byteLength: number}}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {
      progress: {message: 'Analyzing target project state'},
      state: 'analyzing',
      upload: {byteLength: getUploadMetadata('zip-body').byteLength},
    },
    error: null,
  })
  expect(getProjectTransferSessionMock).not.toHaveBeenCalled()
})

test('project transfer import get reads commit progress artifacts before the session repository', async () => {
  const app = await getProjectTransferApp()
  mkdirSync(getImportRootPath(commitProgressArtifactImportSessionId), {recursive: true})
  writeFileSync(
    getImportProgressPath(commitProgressArtifactImportSessionId),
    JSON.stringify({
      message: 'Writing imported project tables',
      phase: 'app_table_writes',
      planRevision: 2,
      rowCountProcessed: 1200,
      rowCountTotal: 89419,
      status: 'running',
      updatedAt: '2030-01-01T00:00:10.000Z',
      warningCount: 1,
    }),
  )

  const response = await getRouteResponse(app, `/api/projects/import/${commitProgressArtifactImportSessionId}`, 'GET')
  const body = (await response.json()) as {
    data: {canCommit: boolean; progress: {message: string; phase: string}; state: string}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {
      canCommit: false,
      progress: {message: 'Writing imported project tables', phase: 'app_table_writes'},
      state: 'committing',
    },
    error: null,
  })
  expect(getProjectTransferSessionMock).not.toHaveBeenCalled()
})

test('project transfer import get reads completed import artifacts before the session repository', async () => {
  const app = await getProjectTransferApp()
  mkdirSync(getImportRootPath(completedArtifactImportSessionId), {recursive: true})
  writeFileSync(
    getImportProgressPath(completedArtifactImportSessionId),
    JSON.stringify({
      message: 'Commit transaction completed',
      percent: 100,
      phase: 'commit',
      planRevision: 2,
      status: 'completed',
      updatedAt: '2030-01-01T00:00:10.000Z',
    }),
  )
  writeFileSync(
    `${getImportRootPath(completedArtifactImportSessionId)}/completion.json`,
    JSON.stringify({
      finalCounts: {warnings: 0},
      importWarnings: [],
      packageFingerprint: 'fingerprint-completed-artifact',
      projectId: 'completed-artifact-project',
      projectName: 'Completed Artifact Project',
      status: 'completed',
      targetProjectId: 'completed-artifact-project',
      targetProjectName: 'Completed Artifact Project',
      transferHistoryId: 'history-completed-artifact',
    }),
  )

  const response = await getRouteResponse(app, `/api/projects/import/${completedArtifactImportSessionId}`, 'GET')
  const body = (await response.json()) as {
    data: {completion: {targetProjectId: string}; progress: {message: string}; state: string}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {
      completion: {targetProjectId: 'completed-artifact-project'},
      progress: {message: 'Commit transaction completed'},
      state: 'completed',
    },
    error: null,
  })
  expect(getProjectTransferSessionMock).not.toHaveBeenCalled()
})

test('project transfer import get fails the session when dependency artifacts are missing', async () => {
  routeState.sessions[missingArtifactsGetSessionId] = getImportSessionRecord({
    id: missingArtifactsGetSessionId,
    planRevision: 1,
    planSummaryJson: {
      blockerCount: 2,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {'model:model-1': 'missing', 'provider:provider-connection-1': 'missing'},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    state: 'awaiting_resolution',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(new Request(`http://localhost/api/projects/import/${missingArtifactsGetSessionId}`))
  const body = (await response.json()) as {data: {error: {message: string}; state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {
      error: {
        message:
          'Project transfer import artifacts are unavailable. Create a new import session and upload the package again.',
      },
      state: 'failed',
    },
    error: null,
  })
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
      body: JSON.stringify({expandedBytes: 0}),
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
  expect(routeState.sessions['import-analyze']?.ownerToken).toBeNull()
  expect(routeState.sessions['import-analyze']?.packageFingerprint).toBe('analyzed-fingerprint')
  expect(routeState.sessions['import-analyze']?.progressJson).toMatchObject({phase: 'analyze', status: 'completed'})
  expect(transitionProjectTransferSessionStateMock).toHaveBeenCalledTimes(2)
  expect(updateProjectTransferSessionPlanRevisionMock).toHaveBeenCalledWith(
    expect.objectContaining({nextOwnerToken: null, packageFingerprint: 'analyzed-fingerprint'}),
  )
})

test('project transfer import analyze returns accepted when expanded size is unknown', async () => {
  routeState.sessions['import-background-analyze'] = getImportSessionRecord({
    id: 'import-background-analyze',
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/import-background-analyze/analyze', {
      body: JSON.stringify({}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {executionMode: string; state: string}; error: string | null}

  expect(response.status).toBe(202)
  expect(body).toMatchObject({data: {executionMode: 'background', state: 'extracting'}, error: null})
})

test('project transfer import analyze returns accepted for explicit large packages', async () => {
  routeState.sessions[largeBackgroundAnalyzeSessionId] = getImportSessionRecord({
    id: largeBackgroundAnalyzeSessionId,
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request(`http://localhost/api/projects/import/${largeBackgroundAnalyzeSessionId}/analyze`, {
      body: JSON.stringify({expandedBytes: 513 * 1024 * 1024, zipBytes: 129 * 1024 * 1024}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {
    data: {executionMode: string; ownerToken: string | null; progress: {phase: string; status: string}; state: string}
    error: string | null
  }

  expect(response.status).toBe(202)
  expect(body).toMatchObject({
    data: {executionMode: 'background', progress: {phase: 'package_scan', status: 'running'}, state: 'extracting'},
    error: null,
  })
  expect(typeof body.data.ownerToken).toBe('string')
})

test('project transfer import resolve updates the durable dependency plan and commit returns completed session data', async () => {
  routeState.sessions[resolveSessionId] = getImportSessionRecord({
    id: resolveSessionId,
    planRevision: 1,
    planSummaryJson: {
      blockerCount: 1,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    state: 'awaiting_resolution',
  })
  mkdirSync(getImportRootPath(resolveSessionId), {recursive: true})
  await globalThis.Bun.write(getImportPlanPath(resolveSessionId), '{}')
  const app = await getProjectTransferApp()

  const resolveResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${resolveSessionId}/resolve-dependencies`, {
      body: JSON.stringify({
        planRevision: 1,
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const resolveBody = (await resolveResponse.json()) as {
    data: {planRevision: number; planSummary: {dependencyStatuses: Record<string, string>}; state: string}
    error: string | null
  }
  const completion = {
    importWarnings: [],
    packageFingerprint: 'fingerprint-import',
    projectId: 'imported-project-1',
    projectName: 'Imported Project',
    status: 'completed' as const,
    targetProjectId: 'imported-project-1',
    targetProjectName: 'Imported Project',
    transferHistoryId: 'history-import-resolve',
  }
  routeState.commitResult = {
    completion,
    history: null,
    session: {...routeState.sessions[resolveSessionId], completionPayloadJson: completion, state: 'completed'},
    status: 'completed',
    statusCode: 200,
  }
  const commitResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${resolveSessionId}/commit`, {
      body: JSON.stringify({expectedPlanRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const commitBody = (await commitResponse.json()) as {
    data: {completion: typeof completion; state: string}
    error: string | null
  }

  expect(resolveResponse.status).toBe(200)
  expect(resolveBody).toMatchObject({
    data: {
      planRevision: 2,
      planSummary: {dependencyStatuses: {'model:model-1': 'resolved', 'provider:provider-connection-1': 'resolved'}},
      state: 'ready_to_commit',
    },
    error: null,
  })
  expect(resolveProjectTransferDependenciesMock).toHaveBeenCalledTimes(1)
  expect(resolveProjectTransferDependenciesMock).toHaveBeenCalledWith(expect.objectContaining({deferPlanWrite: true}))
  expect(writeProjectTransferDependencyPlanMock).toHaveBeenCalledWith(expect.objectContaining({plan: {}}))
  expect(commitResponse.status).toBe(200)
  expect(commitBody).toMatchObject({data: {completion, state: 'completed'}, error: null})
  expect(commitProjectTransferImportSessionMock).toHaveBeenCalledWith({
    request: {expectedPlanRevision: 1},
    sessionId: resolveSessionId,
  })
})

test('project transfer routes carry inline export bytes through import analyze resolve and commit', async () => {
  const app = await getProjectTransferApp()

  const exportResponse = await getRouteResponse(app, '/api/projects/project-1/export-project', 'POST')
  const packageBytes = new Uint8Array(await exportResponse.arrayBuffer())
  const createResponse = await app.handle(
    new Request('http://localhost/api/projects/import/sessions', {
      body: JSON.stringify({sessionId: routeFlowSessionId}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const uploadResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${routeFlowSessionId}/upload`, {
      body: packageBytes,
      headers: {'content-type': 'application/zip', 'x-project-transfer-filename': 'project-transfer-project-1.zip'},
      method: 'PUT',
    }),
  )
  const uploadBody = (await uploadResponse.json()) as {
    data: {state: string; upload: {byteLength: number; checksumSha256: string; fileName: string}; uploadPath?: string}
    error: string | null
  }
  const analyzeResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${routeFlowSessionId}/analyze`, {
      body: JSON.stringify({expandedBytes: 0, zipBytes: packageBytes.byteLength}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const analyzeBody = (await analyzeResponse.json()) as {
    data: {planRevision: number; state: string; upload: {checksumSha256: string} | null}
    error: string | null
  }
  mkdirSync(getImportRootPath(routeFlowSessionId), {recursive: true})
  await globalThis.Bun.write(getImportPlanPath(routeFlowSessionId), '{}')
  const resolveResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${routeFlowSessionId}/resolve-dependencies`, {
      body: JSON.stringify({
        planRevision: analyzeBody.data.planRevision,
        selectedModels: [{sourceModelId: 'model-1', targetModelId: 'target-model-1'}],
        selectedProviderConnections: [
          {sourceProviderConnectionId: 'provider-connection-1', targetProviderConnectionId: 'target-provider-1'},
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const resolveBody = (await resolveResponse.json()) as {
    data: {planRevision: number; planSummary: {dependencyStatuses: Record<string, string>}; state: string}
    error: string | null
  }
  const completion = {
    importWarnings: [],
    packageFingerprint: 'route-flow-fingerprint',
    projectId: 'route-flow-imported-project',
    projectName: 'Route Flow Imported Project',
    status: 'completed' as const,
    targetProjectId: 'route-flow-imported-project',
    targetProjectName: 'Route Flow Imported Project',
    transferHistoryId: 'history-route-flow',
  }
  routeState.commitResult = {
    completion,
    history: null,
    session: {...routeState.sessions[routeFlowSessionId], completionPayloadJson: completion, state: 'completed'},
    status: 'completed',
    statusCode: 200,
  }
  const commitResponse = await app.handle(
    new Request(`http://localhost/api/projects/import/${routeFlowSessionId}/commit`, {
      body: JSON.stringify({planRevision: resolveBody.data.planRevision}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const commitBody = (await commitResponse.json()) as {
    data: {completion: typeof completion; state: string; uploadPath?: string}
    error: string | null
  }

  expect(exportResponse.status).toBe(200)
  expect(exportResponse.headers.get('content-type')).toBe('application/zip')
  expect(createResponse.status).toBe(201)
  expect(uploadResponse.status).toBe(200)
  expect(uploadBody).toMatchObject({
    data: {
      state: 'queued',
      upload: {
        byteLength: packageBytes.byteLength,
        checksumSha256: createHash('sha256').update(packageBytes).digest('hex'),
        fileName: 'project-transfer-project-1.zip',
      },
    },
    error: null,
  })
  expect(readFileSync(getUploadPackagePath(routeFlowSessionId))).toEqual(Buffer.from(packageBytes))
  expect(uploadBody.data.uploadPath).toBeUndefined()
  expect(analyzeResponse.status).toBe(200)
  expect(analyzeBody).toMatchObject({
    data: {planRevision: 1, state: 'awaiting_resolution', upload: uploadBody.data.upload},
    error: null,
  })
  expect(resolveResponse.status).toBe(200)
  expect(resolveBody).toMatchObject({
    data: {
      planRevision: 2,
      planSummary: {dependencyStatuses: {'model:model-1': 'resolved', 'provider:provider-connection-1': 'resolved'}},
      state: 'ready_to_commit',
    },
    error: null,
  })
  expect(commitResponse.status).toBe(200)
  expect(commitBody).toMatchObject({data: {completion, state: 'completed'}, error: null})
  expect(commitBody.data.uploadPath).toBeUndefined()
  expect(createProjectTransferExportMock).toHaveBeenCalledWith({projectId: 'project-1'})
  expect(analyzeProjectTransferImportPackageMock).toHaveBeenCalledWith(
    expect.objectContaining({planRevision: 1, uploadMetadata: uploadBody.data.upload}),
  )
  expect(resolveProjectTransferDependenciesMock).toHaveBeenCalledWith(expect.objectContaining({deferPlanWrite: true}))
  expect(commitProjectTransferImportSessionMock).toHaveBeenCalledWith({
    request: {planRevision: 2},
    sessionId: routeFlowSessionId,
  })
})

test('project transfer import resolve fails the session when dependency artifacts are missing', async () => {
  routeState.sessions[missingArtifactsResolveSessionId] = getImportSessionRecord({
    id: missingArtifactsResolveSessionId,
    planRevision: 1,
    planSummaryJson: {
      blockerCount: 2,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {'model:model-1': 'missing', 'provider:provider-connection-1': 'missing'},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    state: 'awaiting_resolution',
  })
  routeState.resolveResult = {
    error: 'Project transfer import plan artifact is unavailable',
    status: 'error',
    statusCode: 409,
  }
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request(`http://localhost/api/projects/import/${missingArtifactsResolveSessionId}/resolve-dependencies`, {
      body: JSON.stringify({planRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {error: {message: string}; state: string}; error: string | null}

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {
      error: {
        message:
          'Project transfer import artifacts are unavailable. Create a new import session and upload the package again.',
      },
      state: 'failed',
    },
    error: null,
  })
})

test('project transfer import resolve does not publish a plan when the session revision update loses', async () => {
  routeState.sessions[resolveRaceSessionId] = getImportSessionRecord({
    id: resolveRaceSessionId,
    planRevision: 1,
    state: 'awaiting_resolution',
  })
  mkdirSync(getImportRootPath(resolveRaceSessionId), {recursive: true})
  await globalThis.Bun.write(getImportPlanPath(resolveRaceSessionId), '{}')
  updateProjectTransferSessionPlanRevisionMock.mockImplementationOnce(async () => {
    return null
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request(`http://localhost/api/projects/import/${resolveRaceSessionId}/resolve-dependencies`, {
      body: JSON.stringify({planRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(409)
  expect(body.error).toBe('Project transfer import dependency resolution could not update the plan')
  expect(resolveProjectTransferDependenciesMock).toHaveBeenCalledWith(expect.objectContaining({deferPlanWrite: true}))
  expect(writeProjectTransferDependencyPlanMock).not.toHaveBeenCalled()
})

test('project transfer commit uses reviewed revision contract without owner tokens', async () => {
  const app = await getProjectTransferApp()
  const missingRevisionResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-contract/commit', {
      body: JSON.stringify({}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const ownerTokenResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-contract/commit', {
      body: JSON.stringify({expectedOwnerToken: 'owner-token', planRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const conflictingRevisionResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-contract/commit', {
      body: JSON.stringify({expectedPlanRevision: 1, planRevision: 2}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const duplicateRevisionResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-contract/commit', {
      body: JSON.stringify({expectedPlanRevision: 1, planRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const ownerTokenBody = (await ownerTokenResponse.json()) as {error: string}
  const conflictingRevisionBody = (await conflictingRevisionResponse.json()) as {error: string}
  const duplicateRevisionBody = (await duplicateRevisionResponse.json()) as {error: string}
  const missingRevisionBody = (await missingRevisionResponse.json()) as {error: string}

  expect(missingRevisionResponse.status).toBe(400)
  expect(missingRevisionBody.error).toBe('Project transfer commit requires planRevision')
  expect(ownerTokenResponse.status).toBe(400)
  expect(ownerTokenBody.error).toBe('Project transfer request body contains unsupported field expectedOwnerToken')
  expect(conflictingRevisionResponse.status).toBe(400)
  expect(conflictingRevisionBody.error).toBe('Project transfer commit planRevision and expectedPlanRevision conflict')
  expect(duplicateRevisionResponse.status).toBe(400)
  expect(duplicateRevisionBody.error).toBe('Project transfer commit requires exactly one reviewed plan revision')
  expect(commitProjectTransferImportSessionMock).not.toHaveBeenCalled()
})

test('project transfer commit returns background and stale sessions through the import envelope', async () => {
  const app = await getProjectTransferApp()
  const committing = getImportSessionRecord({
    id: 'import-background-commit',
    ownerToken: 'owner-background',
    planRevision: 3,
    progressJson: {
      phase: 'revalidation',
      planRevision: 3,
      status: 'running',
      updatedAt: '2030-01-01T00:00:00.000Z',
      warningCount: 1,
    },
    state: 'committing',
  })
  routeState.commitResult = {
    commitId: 'commit-background',
    executionMode: 'background',
    session: committing,
    status: 'claimed',
    statusCode: 202,
  }
  const backgroundResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-background-commit/commit', {
      body: JSON.stringify({planRevision: 3}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const backgroundBody = (await backgroundResponse.json()) as {
    data: {executionMode: string; progress: {phase: string; planRevision: number}; state: string}
    error: string | null
  }
  const staleSummary = {
    blockerCount: 1,
    blockers: [
      {
        code: 'commit_target_plan_stale',
        message: 'Target changed',
        resolutionKind: 'requires_new_package_or_target_changes',
        scope: 'commit.revalidation',
      },
    ],
    conflictCounts: getFinalConflictCounts(),
    dependencyStatuses: {},
    overlapCounts: getFinalOverlapCounts(),
    warningCount: 0,
  }
  routeState.commitResult = {
    plan: {},
    session: getImportSessionRecord({
      id: 'import-stale-commit',
      planRevision: 4,
      planSummaryJson: staleSummary,
      state: 'awaiting_resolution',
    }),
    status: 'stale',
    statusCode: 200,
  }
  const staleResponse = await app.handle(
    new Request('http://localhost/api/projects/import/import-stale-commit/commit', {
      body: JSON.stringify({planRevision: 3}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const staleBody = (await staleResponse.json()) as {
    data: {planRevision: number; stalePlan: boolean; state: string}
    error: string | null
  }

  expect(backgroundResponse.status).toBe(202)
  expect(backgroundBody).toMatchObject({
    data: {executionMode: 'background', progress: {phase: 'revalidation', planRevision: 3}, state: 'committing'},
    error: null,
  })
  expect(staleResponse.status).toBe(200)
  expect(staleBody).toMatchObject({data: {planRevision: 4, stalePlan: true, state: 'awaiting_resolution'}, error: null})
})

test('project transfer commit maps service errors to non-2xx envelopes', async () => {
  routeState.commitResult = {
    error: 'Project transfer import session is not ready to commit',
    status: 'error',
    statusCode: 409,
  }
  const app = await getProjectTransferApp()
  const response = await app.handle(
    new Request('http://localhost/api/projects/import/import-invalid-commit/commit', {
      body: JSON.stringify({planRevision: 1}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: unknown; error: string}

  expect(response.status).toBe(409)
  expect(body).toEqual({data: null, error: 'Project transfer import session is not ready to commit'})
})

test('project transfer import resolve returns the latest plan for stale revisions without mutating', async () => {
  routeState.sessions['import-stale-resolve'] = getImportSessionRecord({
    id: 'import-stale-resolve',
    planRevision: 2,
    planSummaryJson: {
      blockerCount: 1,
      conflictCounts: getFinalConflictCounts(),
      dependencyStatuses: {'model:model-1': 'missing'},
      overlapCounts: getFinalOverlapCounts(),
      warningCount: 0,
    },
    state: 'awaiting_resolution',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/import-stale-resolve/resolve-dependencies', {
      body: JSON.stringify({
        planRevision: 1,
        selectedModels: [{sourceModelId: 'model-1', targetModelId: 'target-model-1'}],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {
    data: {planRevision: number; planSummary: {dependencyStatuses: Record<string, string>}; stalePlan: boolean}
    error: string | null
  }

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    data: {planRevision: 2, planSummary: {dependencyStatuses: {'model:model-1': 'missing'}}, stalePlan: true},
    error: null,
  })
  expect(resolveProjectTransferDependenciesMock).not.toHaveBeenCalled()
  expect(routeState.sessions['import-stale-resolve']?.planRevision).toBe(2)
})

test('project transfer import resolve rejects shape-invalid dependency mutations before service reads', async () => {
  routeState.sessions['import-invalid-resolve'] = getImportSessionRecord({
    id: 'import-invalid-resolve',
    planRevision: 1,
    state: 'awaiting_resolution',
  })
  const app = await getProjectTransferApp()

  const response = await app.handle(
    new Request('http://localhost/api/projects/import/import-invalid-resolve/resolve-dependencies', {
      body: JSON.stringify({
        planRevision: 1,
        selectedProviderConnections: [
          {
            extra: true,
            sourceProviderConnectionId: 'provider-connection-1',
            targetProviderConnectionId: 'target-provider-1',
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(400)
  expect(body.error).toContain('selectedProviderConnections[0].extra')
  expect(resolveProjectTransferDependenciesMock).not.toHaveBeenCalled()
  expect(getProjectTransferSessionMock).not.toHaveBeenCalled()
})

test('project transfer import cancellation cleans temp artifacts and repeats idempotently', async () => {
  routeState.sessions[uploadSessionId] = getImportSessionRecord({
    errorJson: null,
    id: uploadSessionId,
    progressJson: {phase: 'upload', status: 'completed', uploadMetadata: getUploadMetadata('zip-body')},
    state: 'queued',
  })
  mkdirSync(getImportRootPath(uploadSessionId), {recursive: true})
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
