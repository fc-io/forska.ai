import {expect, type Page, type Request, type Response, test} from '@playwright/test'
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import path from 'node:path'

import type {ReviewsWarningsData} from '../../src/components/main/reviews/reviewsWarningsQuery.ts'
import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'

const apiBaseUrl = 'http://127.0.0.1:43101'
const appBaseUrl = 'http://127.0.0.1:43100'
const isNetworkSmokeAudit = process.env.FORSKA_NETWORK_SMOKE_AUDIT === 'true'
const networkSmokeDbMode = process.env.FORSKA_NETWORK_SMOKE_DB_MODE === 'current' ? 'current' : 'synthetic'
const networkSmokeSeedMode = process.env.FORSKA_NETWORK_SMOKE_SEED_MODE === 'existing' ? 'existing' : 'synthetic'
const runtimeLogDir = process.env.LOG_DIR ?? ''
const shouldSkipMutatingRouteLoads = process.env.FORSKA_NETWORK_SMOKE_SKIP_MUTATING_ROUTE_LOADS === 'true'
const areServerMutationsDisabled = process.env.FORSKA_DISABLE_SERVER_MUTATIONS === 'true'
const largeRebuildFailureText = 'Large rebuild failed'
const forbiddenRuntimeLogPatterns = [
  {label: 'API role DuckDB ownership', pattern: /Current server role api cannot own DuckDB/},
  {label: 'DuckDB fatal runtime restart', pattern: /\[duckdb\] restarting embedded runtime after fatal invalidation/},
  {label: 'large rebuild failure', pattern: /Large rebuild failed/},
  {label: 'articles reviews request failure', pattern: /Articles reviews request failed/},
  {label: 'review bulk worker loop failure', pattern: /\[reviewBulkOperationWorker\] background loop failed/},
  {label: 'review serving snapshot unavailable', pattern: /Review serving snapshot is unavailable/},
  {label: 'DuckDB owner heartbeat failure', pattern: /\[duckdb-owner\] heartbeat failed/},
  {label: 'DuckDB owner heartbeat event', pattern: /duckdb-owner-connection-heartbeat/},
  {label: 'maintenance restart loop', pattern: /\[server:stack\] restarting maintenance/},
  {label: 'maintenance unexpected exit', pattern: /\[server:stack\] maintenance pid=\d+ exited with code 0/},
  {label: 'judge duplicate replacement', pattern: /judge replacement is already ready after SIGTERM/},
  {label: 'judge unexpected SIGTERM exit', pattern: /\[server:stack\] judge pid=\d+ exited with code 143/},
] as const
const warningEndpointPath = '/api/projectsreviewswarnings'
const warningsEndpointQueuedProbeDelayMs = 1_000

type ApiDataResponse<T> = {data: T}
type ArticleSearchResponse = Array<{articleId: string | null; articleTitle: string; id: string}>
type ArticleUpsertResponse = {count: number; success: boolean}
type ProjectCreateResponse = {id: string}
type ProjectDetailResponse = {
  project: {modelId: string}
  prompts: Array<{enabled?: boolean; id: string; linkedToProject?: boolean}>
}
type ProjectListItem = {id: string}
type ProjectArticlesResponse = {articles: Array<{id: string}>}
type ProviderConnectionCreateResponse = {connection: {id: string}}
type ProviderModelCreateResponse = {modelId: string}
type ProviderConnectionsResponse = {connections: Array<{id: string}>}
type DataSourceCreateResponse = {id: string}
type DataSourceListItem = {id: string}
type ComparisonProjectCreateResponse = {id: string}
type ComparisonProjectListItem = {id: string}

type NetworkSmokeSeed = {
  articleId: string
  comparisonProjectId: string
  dataSourceId: string
  modelId: string
  projectId: string
  promptId: string
  providerConnectionId: string
}

type NetworkSmokeSeedKey = keyof NetworkSmokeSeed
type NetworkSmokeTarget = {
  buildPath: (seed: NetworkSmokeSeed) => string
  label: string
  requiredSeedKeys?: NetworkSmokeSeedKey[]
  template: string
}

type SkippedRouteClassification = 'admin-debug-only' | 'missing-data' | 'unsafe-pending-phase-5c-rewiring'
type SkippedRouteTemplate = {classification: SkippedRouteClassification; reason: string; template: string}

type NetworkFailure = {
  details?: string
  method?: string
  pagePath: string
  source: string
  status?: number
  url?: string
}

type PendingAuditedRequest = {promise: Promise<void>; resolve: () => void}
type JsonParseResult = {ok: false; error: string} | {ok: true; value: unknown}
type WarningFailureVariant = {path: string; value: number | string}
type WarningsEndpointParseResult =
  | {ok: false; error: string}
  | {data: ReviewsWarningsData; indexing: ReviewsWarningsData['indexing']; ok: true; projectId: string}
type WarningsEndpointInspection =
  | {kind: 'failure'; details: string}
  | {data: ReviewsWarningsData; kind: 'queued'; projectId: string}
  | {kind: 'ok'}

const routeTreePath = path.resolve(process.cwd(), 'src/app/routeTree.gen.ts')

const getRuntimeLogFiles = () => {
  return runtimeLogDir.trim().length === 0 || !existsSync(runtimeLogDir)
    ? []
    : readdirSync(runtimeLogDir, {withFileTypes: true})
        .filter((entry) => {
          return entry.isFile() && entry.name.endsWith('.jsonl')
        })
        .map((entry) => {
          return path.join(runtimeLogDir, entry.name)
        })
}

const assertTextDoesNotContainLargeRebuildFailure = (source: string, text: string) => {
  expect(text, `${source} must not contain ${largeRebuildFailureText}`).not.toContain(largeRebuildFailureText)
}

const textContainsLargeRebuildFailure = (text: string) => {
  return text.includes(largeRebuildFailureText)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const parseJson = (text: string): JsonParseResult => {
  try {
    return {ok: true, value: JSON.parse(text) as unknown}
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : 'unknown JSON parse error'}
  }
}

const getWarningFailureVariants = (value: unknown, path: string): WarningFailureVariant[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      return getWarningFailureVariants(entry, `${path}[${index}]`)
    })
  }

  if (!isRecord(value)) {
    return []
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path.length === 0 ? key : `${path}.${key}`
    const directFailures: WarningFailureVariant[] =
      child === 'failed'
        ? [{path: childPath, value: child}]
        : key === 'failedCount' && typeof child === 'number' && child > 0
          ? [{path: childPath, value: child}]
          : []

    return [...directFailures, ...getWarningFailureVariants(child, childPath)]
  })
}

const formatWarningFailureVariant = (variant: WarningFailureVariant) => {
  return `${variant.path}=${variant.value}`
}

const getWarningsEndpointData = (body: string): WarningsEndpointParseResult => {
  const parsed = parseJson(body)

  if (!parsed.ok) {
    return {error: `warning response was not JSON: ${parsed.error}`, ok: false}
  }

  const data = isRecord(parsed.value) ? parsed.value.data : undefined

  if (!isRecord(data)) {
    return {error: 'warning response did not include a data object', ok: false}
  }

  if (!isRecord(data.indexing)) {
    return {error: 'warning response did not include an indexing object', ok: false}
  }

  if (typeof data.projectId !== 'string' || data.projectId.trim().length === 0) {
    return {error: 'warning response did not include a projectId', ok: false}
  }

  return {
    data: data as ReviewsWarningsData,
    indexing: data.indexing as ReviewsWarningsData['indexing'],
    ok: true,
    projectId: data.projectId,
  }
}

const getWarningFailureDetails = (data: ReviewsWarningsData) => {
  const failureVariants = getWarningFailureVariants(data, 'data').filter((variant) => {
    return !(
      isMutationDisabledCurrentDbQueuedBacklog(data.indexing)
      && [
        'data.indexing.serving.diagnostics.dirtyWork.failedCount',
        'data.indexing.serving.diagnostics.rebuildChunks.failedCount',
      ].includes(variant.path)
    )
  })

  return failureVariants.length === 0
    ? null
    : `warning response returned failed review state: ${failureVariants.map(formatWarningFailureVariant).join(', ')}`
}

const formatIndexingState = (indexing: ReviewsWarningsData['indexing']) => {
  return [
    `progressState=${indexing.progressState}`,
    `status=${indexing.status}`,
    `servingReadable=${indexing.serving.readable}`,
    `servingUsable=${indexing.serving.usable}`,
    `blockedReason=${indexing.blockedReason ?? 'none'}`,
    `pendingRefreshCount=${indexing.pendingRefreshCount}`,
    `queuedRefreshCount=${indexing.queuedRefreshCount}`,
    `inFlightRefreshCount=${indexing.inFlightRefreshCount}`,
    `activeWorkCount=${indexing.activeWorkCount}`,
    `eligibleConsumerPresent=${indexing.eligibleConsumerPresent}`,
    `oldestQueuedAt=${indexing.oldestQueuedAt ?? 'none'}`,
    `lastProgressedAt=${indexing.lastProgressedAt ?? 'none'}`,
    `lastStartedAt=${indexing.lastStartedAt ?? 'none'}`,
    `lastProcessedAt=${indexing.lastProcessedAt ?? 'none'}`,
  ].join(', ')
}

const isReadableStaleWarningState = (indexing: ReviewsWarningsData['indexing']) => {
  return (
    indexing.status === 'stale'
    && indexing.progressState === 'stalled'
    && indexing.blockedReason === null
    && indexing.serving.readable
    && indexing.serving.usable
    && indexing.pendingRefreshCount === 0
    && indexing.queuedRefreshCount === 0
    && indexing.inFlightRefreshCount === 0
    && indexing.activeWorkCount === 0
  )
}

const isMutationDisabledCurrentDbQueuedBacklog = (indexing: ReviewsWarningsData['indexing']) => {
  return (
    networkSmokeDbMode === 'current'
    && areServerMutationsDisabled
    && indexing.status === 'blocked'
    && indexing.progressState === 'blocked'
    && indexing.blockedReason === 'waiting_for_maintenance_worker'
    && indexing.pendingRefreshCount > 0
    && indexing.inFlightRefreshCount === 0
    && indexing.activeWorkCount === 0
  )
}

const getBlockingWarningDetails = (indexing: ReviewsWarningsData['indexing']) => {
  return isMutationDisabledCurrentDbQueuedBacklog(indexing)
    ? null
    : indexing.progressState === 'blocked' || indexing.status === 'blocked'
      ? `warning response returned blocked review indexing: ${formatIndexingState(indexing)}`
      : isReadableStaleWarningState(indexing)
        ? null
        : indexing.progressState === 'stalled' || indexing.status === 'stale'
          ? `warning response returned stalled review indexing: ${formatIndexingState(indexing)}`
          : null
}

const getQueuedWarningStateFailureDetails = (indexing: ReviewsWarningsData['indexing']) => {
  const failureDetails = [
    indexing.pendingRefreshCount <= 0 ? `pendingRefreshCount=${indexing.pendingRefreshCount}` : null,
    indexing.queuedRefreshCount <= 0 ? `queuedRefreshCount=${indexing.queuedRefreshCount}` : null,
    indexing.inFlightRefreshCount > 0 ? `inFlightRefreshCount=${indexing.inFlightRefreshCount}` : null,
    indexing.activeWorkCount > 0 ? `activeWorkCount=${indexing.activeWorkCount}` : null,
    !indexing.eligibleConsumerPresent ? 'eligibleConsumerPresent=false' : null,
  ].filter((detail) => {
    return detail !== null
  })

  return failureDetails.length === 0
    ? null
    : `warning response returned queued review indexing that is not actually queueable: ${failureDetails.join(', ')}; ${formatIndexingState(indexing)}`
}

const getWarningsEndpointInspection = (body: string): WarningsEndpointInspection => {
  const parsed = getWarningsEndpointData(body)

  if (!parsed.ok) {
    return {details: parsed.error, kind: 'failure'}
  }

  const failedDetails = getWarningFailureDetails(parsed.data)

  if (failedDetails !== null) {
    return {details: failedDetails, kind: 'failure'}
  }

  const blockingDetails = getBlockingWarningDetails(parsed.indexing)

  if (blockingDetails !== null) {
    return {details: blockingDetails, kind: 'failure'}
  }

  if (parsed.indexing.progressState !== 'queued') {
    return {kind: 'ok'}
  }

  const queuedFailureDetails = getQueuedWarningStateFailureDetails(parsed.indexing)

  return queuedFailureDetails === null
    ? {data: parsed.data, kind: 'queued', projectId: parsed.projectId}
    : {details: queuedFailureDetails, kind: 'failure'}
}

const fetchWarningsEndpointInspection = async (projectId: string) => {
  const response = await fetch(`${apiBaseUrl}${warningEndpointPath}`, {
    body: JSON.stringify({projectId}),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
  const body = await response.text()

  assertTextDoesNotContainLargeRebuildFailure(`warnings endpoint response for ${projectId}`, body)

  if (!response.ok) {
    throw new Error(`Warnings endpoint probe failed for ${projectId}: ${response.status} ${body}`)
  }

  return getWarningsEndpointInspection(body)
}

const waitForWarningsEndpointQueuedProbeRetry = async () => {
  return new Promise((resolve) => {
    setTimeout(resolve, warningsEndpointQueuedProbeDelayMs)
  })
}

const getForbiddenRuntimeLogMatches = (text: string) => {
  return forbiddenRuntimeLogPatterns.flatMap(({label, pattern}) => {
    return pattern.test(text) ? [label] : []
  })
}

const getRuntimeLogsText = () => {
  const logFiles = getRuntimeLogFiles()

  expect(logFiles.length, 'Expected smoke runtime logs to be captured').toBeGreaterThan(0)
  return logFiles
    .map((filePath) => {
      return readFileSync(filePath, 'utf8')
    })
    .join('\n')
}

const assertRuntimeLogsDoNotContainForbiddenServerErrors = () => {
  const runtimeLogsText = getRuntimeLogsText()

  expect(getForbiddenRuntimeLogMatches(runtimeLogsText), runtimeLogsText).toEqual([])
}

const readGeneratedRouteTemplates = () => {
  const source = readFileSync(routeTreePath, 'utf8')
  const match = /export interface FileRoutesByTo \{([\s\S]*?)\n\}/.exec(source)

  if (!match) {
    throw new Error(`Could not find FileRoutesByTo in ${routeTreePath}`)
  }

  const templates = [...match[1].matchAll(/^  '([^']+)':/gm)].map((entry) => {
    return entry[1]
  })

  return templates.sort()
}

const assertOk = async <T>(response: globalThis.Response, message: string): Promise<T> => {
  if (!response.ok) {
    throw new Error(`${message}: ${response.status} ${await response.text()}`)
  }

  const payload = (await response.json()) as ApiDataResponse<T> | T
  return 'data' in Object(payload) ? (payload as ApiDataResponse<T>).data : (payload as T)
}

const postJson = async <T>(url: string, body: unknown, message: string): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })

  return assertOk<T>(response, message)
}

const getJson = async <T>(url: string, message: string): Promise<T> => {
  const response = await fetch(url)

  return assertOk<T>(response, message)
}

const postWarningsEndpointProbe = async (projectId: string, attempt = 1): Promise<void> => {
  const inspection = await fetchWarningsEndpointInspection(projectId)

  if (inspection.kind === 'failure') {
    throw new Error(`warnings endpoint response for ${projectId}: ${inspection.details}`)
  }

  if (inspection.kind === 'ok') {
    return
  }

  if (attempt === 1) {
    await waitForWarningsEndpointQueuedProbeRetry()
    return postWarningsEndpointProbe(projectId, attempt + 1)
  }

  throw new Error(
    `warnings endpoint remained queued after retry for ${projectId}: ${formatIndexingState(inspection.data.indexing)}`,
  )
}

const getFirstExistingId = <T extends {id: string}>(values: T[]) => {
  return values[0]?.id ?? ''
}

const createProviderConnection = async () => {
  const data = await postJson<ProviderConnectionCreateResponse>(
    `${apiBaseUrl}/api/provider-connections`,
    {baseURL: 'http://127.0.0.1:1234/v1', label: 'Network Smoke LM Studio', providerKind: 'llmstudio'},
    'Failed to create provider connection',
  )

  return data.connection.id
}

const createProviderModel = async (connectionId: string) => {
  const data = await postJson<ProviderModelCreateResponse>(
    `${apiBaseUrl}/api/provider-connections/${connectionId}/models`,
    {displayName: 'Network Smoke Model', remoteModelId: 'network-smoke-model'},
    'Failed to create provider model',
  )

  return data.modelId
}

const createProject = async (modelId: string) => {
  return postJson<ProjectCreateResponse>(
    `${apiBaseUrl}/api/projects`,
    {
      modelId,
      name: 'Network Smoke Project',
      prompts: [
        {content: 'Is this article relevant to the network smoke audit?', order: 0, promptHeading: 'Relevance'},
      ],
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    },
    'Failed to create project',
  )
}

const createArticle = async () => {
  const articleExternalId = `network-smoke-${Date.now()}`
  const articleTitle = `Network Smoke Article ${articleExternalId}`

  await postJson<ArticleUpsertResponse>(
    `${apiBaseUrl}/api/articles/batch-upsert`,
    {
      entries: [
        {
          article_authors: ['Network Smoke'],
          article_created_at: '2026-01-01T00:00:00.000Z',
          article_id: articleExternalId,
          article_summary: 'Seed article for local network smoke route coverage.',
          article_title: articleTitle,
          article_updated_at: '2026-01-01T00:00:00.000Z',
          article_version: '1',
          doi: `10.0000/${articleExternalId}`,
          import_route: 'network-smoke:articles',
          original_data: {},
        },
      ],
    },
    'Failed to create article',
  )

  const articles = await getJson<ArticleSearchResponse>(
    `${apiBaseUrl}/api/articles/search?q=${encodeURIComponent(articleTitle)}`,
    'Failed to find created article',
  )
  const article = articles.find((entry) => {
    return entry.articleTitle === articleTitle
  })

  if (!article) {
    throw new Error('Created article was not returned by article search')
  }

  return article.id
}

const addArticleToProject = async (projectId: string, articleId: string) => {
  await postJson(
    `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/articles`,
    {articleIds: [articleId]},
    'Failed to add article to project',
  )
}

const getProjectPromptId = async (projectId: string) => {
  const detail = await getJson<ProjectDetailResponse>(
    `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}`,
    'Failed to fetch project details',
  )
  const promptId = detail.prompts[0]?.id

  if (!promptId) {
    throw new Error('Seed project did not return a prompt id')
  }

  return promptId
}

const createDataSource = async () => {
  return postJson<DataSourceCreateResponse>(
    `${apiBaseUrl}/api/datasources`,
    {
      description: 'Seeded by Playwright network smoke.',
      importRoute: 'network-smoke:datasource',
      title: 'Network Smoke Data Source',
    },
    'Failed to create data source',
  )
}

const createComparisonProject = async (seed: {modelId: string; projectId: string; promptId: string}) => {
  return postJson<ComparisonProjectCreateResponse>(
    `${apiBaseUrl}/api/comparison-projects`,
    {
      compareWithHumans: false,
      description: 'Seeded by Playwright network smoke.',
      modelIds: [seed.modelId],
      name: 'Network Smoke Comparison Project',
      promptSelections: [{order: 0, promptId: seed.promptId}],
      sourceProjectIds: [seed.projectId],
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    },
    'Failed to create comparison project',
  )
}

const createSyntheticNetworkSmokeSeed = async (): Promise<NetworkSmokeSeed> => {
  const providerConnectionId = await createProviderConnection()
  const modelId = await createProviderModel(providerConnectionId)
  const project = await createProject(modelId)
  const articleId = await createArticle()

  await addArticleToProject(project.id, articleId)

  const promptId = await getProjectPromptId(project.id)
  const dataSource = await createDataSource()
  const comparisonProject = await createComparisonProject({modelId, projectId: project.id, promptId})

  return {
    articleId,
    comparisonProjectId: comparisonProject.id,
    dataSourceId: dataSource.id,
    modelId,
    projectId: project.id,
    promptId,
    providerConnectionId,
  }
}

const getExistingProjectPrompt = (project: ProjectDetailResponse) => {
  return (
    project.prompts.find((prompt) => {
      return prompt.linkedToProject !== false && prompt.enabled !== false
    })
    ?? project.prompts.find((prompt) => {
      return prompt.linkedToProject !== false
    })
    ?? project.prompts[0]
  )
}

const getExistingProjectSeedCandidate = async (project: ProjectListItem) => {
  const [projectDetail, articlePage] = await Promise.all([
    getJson<ProjectDetailResponse>(
      `${apiBaseUrl}/api/projects/${encodeURIComponent(project.id)}`,
      `Failed to fetch existing project ${project.id}`,
    ),
    getJson<ProjectArticlesResponse>(
      `${apiBaseUrl}/api/projects/${encodeURIComponent(project.id)}/articles?page=1&limit=1`,
      `Failed to fetch existing project articles for ${project.id}`,
    ),
  ])
  const prompt = getExistingProjectPrompt(projectDetail)
  const article = articlePage.articles[0]

  return prompt
    ? {articleId: article?.id ?? '', modelId: projectDetail.project.modelId, projectId: project.id, promptId: prompt.id}
    : null
}

const getFirstExistingProjectSeedCandidate = async (
  projects: ProjectListItem[],
): Promise<Pick<NetworkSmokeSeed, 'articleId' | 'modelId' | 'projectId' | 'promptId'> | null> => {
  const [project, ...remainingProjects] = projects

  if (!project) {
    return null
  }

  const candidate = await getExistingProjectSeedCandidate(project)
  return candidate ?? getFirstExistingProjectSeedCandidate(remainingProjects)
}

const getExistingProjectSeed = async () => {
  const projects = await getJson<ProjectListItem[]>(`${apiBaseUrl}/api/projects`, 'Failed to fetch existing projects')
  const candidate = await getFirstExistingProjectSeedCandidate(projects)

  return candidate ?? {articleId: '', modelId: '', projectId: '', promptId: ''}
}

const getExistingProviderConnectionId = async () => {
  const providerConnections = await getJson<ProviderConnectionsResponse>(
    `${apiBaseUrl}/api/provider-connections`,
    'Failed to fetch existing provider connections',
  )

  return getFirstExistingId(providerConnections.connections)
}

const getExistingDataSourceId = async () => {
  const dataSources = await getJson<DataSourceListItem[]>(
    `${apiBaseUrl}/api/datasources`,
    'Failed to fetch data sources',
  )

  return getFirstExistingId(dataSources)
}

const getExistingComparisonProjectId = async () => {
  if (shouldSkipMutatingRouteLoads) {
    return ''
  }

  const comparisonProjects = await getJson<ComparisonProjectListItem[]>(
    `${apiBaseUrl}/api/comparison-projects`,
    'Failed to fetch existing comparison projects',
  )

  return getFirstExistingId(comparisonProjects)
}

const getExistingNetworkSmokeSeed = async (): Promise<NetworkSmokeSeed> => {
  const [projectSeed, providerConnectionId, dataSourceId, comparisonProjectId] = await Promise.all([
    getExistingProjectSeed(),
    getExistingProviderConnectionId(),
    getExistingDataSourceId(),
    getExistingComparisonProjectId(),
  ])

  return {...projectSeed, comparisonProjectId, dataSourceId, providerConnectionId}
}

const createNetworkSmokeSeed = async (): Promise<NetworkSmokeSeed> => {
  return networkSmokeSeedMode === 'existing' ? getExistingNetworkSmokeSeed() : createSyntheticNetworkSmokeSeed()
}

const staticAuditTargets: NetworkSmokeTarget[] = [
  {template: '/', label: 'home', buildPath: () => '/'},
  {template: '/articles', label: 'articles', buildPath: () => '/articles'},
  {template: '/compare-judgments', label: 'comparison projects', buildPath: () => '/compare-judgments'},
  {
    template: '/compare-judgments/archived',
    label: 'archived comparison projects',
    buildPath: () => '/compare-judgments/archived',
  },
  {
    template: '/compare-judgments/create',
    label: 'create comparison project',
    buildPath: () => '/compare-judgments/create',
  },
  {
    template: '/compare-judgments/create-from-project',
    label: 'create comparison project from project',
    buildPath: () => '/compare-judgments/create-from-project',
  },
  {template: '/login', label: 'login', buildPath: () => '/login'},
  {template: '/projects', label: 'projects', buildPath: () => '/projects'},
  {template: '/projects/archived', label: 'archived projects', buildPath: () => '/projects/archived'},
  {template: '/projects/create', label: 'create project', buildPath: () => '/projects/create'},
  {template: '/projects/create-subproject', label: 'create subproject', buildPath: () => '/projects/create-subproject'},
  {template: '/projects/import', label: 'project import', buildPath: () => '/projects/import'},
  {template: '/prompts', label: 'prompts', buildPath: () => '/prompts'},
  {template: '/prompts/archived', label: 'archived prompts', buildPath: () => '/prompts/archived'},
  {template: '/providers', label: 'providers', buildPath: () => '/providers'},
  {template: '/providers/add-provider', label: 'add provider', buildPath: () => '/providers/add-provider'},
  {template: '/settings', label: 'settings', buildPath: () => '/settings'},
  {template: '/admin/assessments', label: 'admin assessments', buildPath: () => '/admin/assessments'},
  {template: '/admin/datasources', label: 'admin data sources', buildPath: () => '/admin/datasources'},
  {
    template: '/admin/datasources/archived',
    label: 'admin archived data sources',
    buildPath: () => '/admin/datasources/archived',
  },
  {
    template: '/admin/datasources/covidence-import',
    label: 'admin covidence import',
    buildPath: () => '/admin/datasources/covidence-import',
  },
  {
    template: '/admin/datasources/create',
    label: 'admin create data source',
    buildPath: () => '/admin/datasources/create',
  },
  {
    template: '/admin/datasources/structured-file-import',
    label: 'admin structured file import',
    buildPath: () => '/admin/datasources/structured-file-import',
  },
  {template: '/admin/duckdb-append', label: 'admin duckdb append', buildPath: () => '/admin/duckdb-append'},
  {
    template: '/admin/duckdb-owner-connections',
    label: 'admin duckdb owner connections',
    buildPath: () => '/admin/duckdb-owner-connections',
  },
  {template: '/admin/failed_requests', label: 'admin failed requests', buildPath: () => '/admin/failed_requests'},
  {template: '/admin/gpu', label: 'admin gpu', buildPath: () => '/admin/gpu'},
  {template: '/admin/jobs', label: 'admin jobs', buildPath: () => '/admin/jobs'},
  {template: '/admin/jobs/health', label: 'admin jobs health', buildPath: () => '/admin/jobs/health'},
  {template: '/admin/llm', label: 'admin llm', buildPath: () => '/admin/llm'},
  {template: '/admin/pdf-conversions', label: 'admin pdf conversions', buildPath: () => '/admin/pdf-conversions'},
  {template: '/admin/pdf-reset', label: 'admin pdf reset', buildPath: () => '/admin/pdf-reset'},
  {template: '/admin/prompts/deduplicate', label: 'admin prompt dedupe', buildPath: () => '/admin/prompts/deduplicate'},
  {template: '/admin/setup_stats', label: 'admin setup stats', buildPath: () => '/admin/setup_stats'},
  {
    template: '/admin/unexpected-answers',
    label: 'admin unexpected answers',
    buildPath: () => '/admin/unexpected-answers',
  },
  {
    template: '/admin/unexpected-answers/all-prompts',
    label: 'admin unexpected answers all prompts',
    buildPath: () => '/admin/unexpected-answers/all-prompts',
  },
]

const dynamicAuditTargets: NetworkSmokeTarget[] = [
  {
    template: '/articles/$id',
    label: 'article detail',
    requiredSeedKeys: ['articleId'],
    buildPath: (seed) => `/articles/${seed.articleId}`,
  },
  {
    template: '/articles/$id/fulltext',
    label: 'article fulltext',
    requiredSeedKeys: ['articleId'],
    buildPath: (seed) => `/articles/${seed.articleId}/fulltext`,
  },
  {
    template: '/compare-judgments/$id',
    label: 'comparison project detail',
    requiredSeedKeys: ['comparisonProjectId'],
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}`,
  },
  {
    template: '/compare-judgments/$id/edit',
    label: 'comparison project edit',
    requiredSeedKeys: ['comparisonProjectId'],
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}/edit`,
  },
  {
    template: '/compare-judgments/$id/export',
    label: 'comparison project export',
    requiredSeedKeys: ['comparisonProjectId'],
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}/export`,
  },
  {
    template: '/compare-judgments/$id/import-resolutions',
    label: 'comparison project import resolutions',
    requiredSeedKeys: ['comparisonProjectId'],
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}/import-resolutions`,
  },
  {
    template: '/projects/$id',
    label: 'project detail',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}`,
  },
  {
    template: '/projects/$id/edit',
    label: 'project edit',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/edit`,
  },
  {
    template: '/projects/$id/export',
    label: 'project export',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/export`,
  },
  {
    template: '/projects/$id/export-project',
    label: 'project package export',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/export-project`,
  },
  {
    template: '/projects/$id/humanAssessment',
    label: 'project human assessment',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/humanAssessment`,
  },
  {
    template: '/projects/$id/reviews',
    label: 'project reviews redirect',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews`,
  },
  {
    template: '/projects/$id/reviews-both',
    label: 'project both reviews',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-both`,
  },
  {
    template: '/projects/$id/reviews-human',
    label: 'project human reviews',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-human`,
  },
  {
    template: '/projects/$id/reviews-llm',
    label: 'project llm reviews',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-llm`,
  },
  {
    template: '/projects/$id/reviews-unassessed',
    label: 'project unassessed reviews',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-unassessed`,
  },
  {
    template: '/projects/$id/reviews-llm/$articleId',
    label: 'project llm review article',
    requiredSeedKeys: ['projectId', 'articleId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-llm/${seed.articleId}`,
  },
  {
    template: '/projects/$id/reviews-llm/$articleId/fulltext',
    label: 'project llm review article fulltext',
    requiredSeedKeys: ['projectId', 'articleId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-llm/${seed.articleId}/fulltext`,
  },
  {
    template: '/projects/$id/reviews/$articleId',
    label: 'project review article redirect',
    requiredSeedKeys: ['projectId', 'articleId'],
    buildPath: (seed) => `/projects/${seed.projectId}/reviews/${seed.articleId}`,
  },
  {
    template: '/providers/$id',
    label: 'provider detail',
    requiredSeedKeys: ['providerConnectionId'],
    buildPath: (seed) => `/providers/${seed.providerConnectionId}`,
  },
  {
    template: '/admin/datasources/$id/edit',
    label: 'admin edit data source',
    requiredSeedKeys: ['dataSourceId'],
    buildPath: (seed) => `/admin/datasources/${seed.dataSourceId}/edit`,
  },
  {
    template: '/admin/unexpected-answers/$projectId',
    label: 'admin unexpected answers project',
    requiredSeedKeys: ['projectId'],
    buildPath: (seed) => `/admin/unexpected-answers/${seed.projectId}`,
  },
  {
    template: '/admin/unexpected-answers/$projectId/$promptId',
    label: 'admin unexpected answers project prompt',
    requiredSeedKeys: ['projectId', 'promptId'],
    buildPath: (seed) => `/admin/unexpected-answers/${seed.projectId}/${seed.promptId}`,
  },
  {
    template: '/admin/unexpected-answers/all-prompts/$promptId',
    label: 'admin unexpected answers prompt',
    requiredSeedKeys: ['promptId'],
    buildPath: (seed) => `/admin/unexpected-answers/all-prompts/${seed.promptId}`,
  },
]

const baseSkippedRouteTemplates: SkippedRouteTemplate[] = [
  {
    classification: 'missing-data',
    template: '/admin/failed_requests/$id',
    reason:
      'needs a real failed token-usage request row; generic smoke seeding should not manufacture failed provider traffic',
  },
  {
    classification: 'missing-data',
    template: '/admin/jobs/$id',
    reason: 'creating a real judgment job requires runtime/model admission and local SQLite preflight state',
  },
  {
    classification: 'missing-data',
    template: '/admin/jobs/$id/unassessed_articles',
    reason: 'depends on the same safely-created judgment job fixture as the job detail route',
  },
]

const mutatingRouteLoadSkippedTemplates: SkippedRouteTemplate[] = [
  {
    classification: 'unsafe-pending-phase-5c-rewiring',
    template: '/compare-judgments/$id',
    reason: 'direct existing-DB read-only mode skips pages that can queue comparison-serving rebuild work on load',
  },
  {
    classification: 'unsafe-pending-phase-5c-rewiring',
    template: '/compare-judgments/$id/edit',
    reason: 'direct existing-DB read-only mode skips comparison-project dynamic pages as one route family',
  },
  {
    classification: 'unsafe-pending-phase-5c-rewiring',
    template: '/compare-judgments/$id/export',
    reason:
      'direct existing-DB read-only mode skips pages that load comparison metadata through the rebuild-capable route',
  },
  {
    classification: 'unsafe-pending-phase-5c-rewiring',
    template: '/compare-judgments/$id/import-resolutions',
    reason:
      'direct existing-DB read-only mode skips pages that load comparison metadata through the rebuild-capable route',
  },
  {
    classification: 'unsafe-pending-phase-5c-rewiring',
    template: '/projects/$id/humanAssessment',
    reason:
      'direct existing-DB read-only mode skips POST /api/humanassessment/init because it can create pending human judgments',
  },
]

const routeLoadSkippedTemplates = shouldSkipMutatingRouteLoads ? mutatingRouteLoadSkippedTemplates : []
const skippedRouteTemplates = [...baseSkippedRouteTemplates, ...routeLoadSkippedTemplates]
const routeLoadSkippedTemplateSet = new Set(
  routeLoadSkippedTemplates.map((route) => {
    return route.template
  }),
)
const allAuditTargets = [...staticAuditTargets, ...dynamicAuditTargets].filter((target) => {
  return !routeLoadSkippedTemplateSet.has(target.template)
})

const getMissingSeedKeys = (target: NetworkSmokeTarget, seed: NetworkSmokeSeed) => {
  return (target.requiredSeedKeys ?? []).filter((key) => {
    return seed[key] === ''
  })
}

const getAuditTargetsForSeed = (seed: NetworkSmokeSeed) => {
  return allAuditTargets.filter((target) => {
    return getMissingSeedKeys(target, seed).length === 0
  })
}

const getMissingExistingDataSkippedTargets = (seed: NetworkSmokeSeed) => {
  return allAuditTargets.flatMap((target) => {
    const missingSeedKeys = getMissingSeedKeys(target, seed)
    return missingSeedKeys.length === 0 ? [] : [{missingSeedKeys, target}]
  })
}

const logMissingExistingDataSkippedTargets = (seed: NetworkSmokeSeed) => {
  const skippedTargets = networkSmokeSeedMode === 'existing' ? getMissingExistingDataSkippedTargets(seed) : []

  if (skippedTargets.length === 0) {
    return
  }

  console.warn(
    `[network-smoke] skipped ${skippedTargets.length} dynamic routes without existing IDs: ${skippedTargets
      .map((entry) => {
        return `${entry.target.template} missing ${entry.missingSeedKeys.join(',')}`
      })
      .join('; ')}`,
  )
}

const getCurrentDbWarningsProbeProjectIds = async () => {
  const projects = await getJson<ProjectListItem[]>(
    `${apiBaseUrl}/api/projects`,
    'Failed to fetch warning probe projects',
  )

  return [
    ...new Set(
      projects
        .map((project) => {
          return project.id
        })
        .filter((projectId) => {
          return projectId.trim().length > 0
        }),
    ),
  ]
}

const runCurrentDbWarningsEndpointProbe = async () => {
  if (networkSmokeDbMode !== 'current') {
    return
  }

  const projectIds = await getCurrentDbWarningsProbeProjectIds()

  expect(projectIds.length, 'Current-DB warning probe needs at least one existing project').toBeGreaterThan(0)
  await Promise.all(
    projectIds.map((projectId) => {
      return postWarningsEndpointProbe(projectId)
    }),
  )
  assertRuntimeLogsDoNotContainForbiddenServerErrors()
}

const getRouteInventoryReport = () => {
  const generated = readGeneratedRouteTemplates()
  const audited = allAuditTargets.map((target) => {
    return target.template
  })
  const skipped = skippedRouteTemplates.map((target) => {
    return target.template
  })
  const represented = new Set([...audited, ...skipped])
  const missing = generated.filter((route) => {
    return !represented.has(route)
  })
  const extra = [...represented].filter((route) => {
    return !generated.includes(route)
  })
  const duplicateAudited = audited.filter((route, index) => {
    return audited.indexOf(route) !== index
  })
  const invalidSkipped = skippedRouteTemplates.filter((route) => {
    return !['admin-debug-only', 'missing-data', 'unsafe-pending-phase-5c-rewiring'].includes(route.classification)
  })
  const legacySideEffectSkipped = skippedRouteTemplates.filter((route) => {
    return /legacy V3 repair|dirty refresh|large-rebuild work on load/i.test(route.reason)
  })

  return {duplicateAudited, extra, generated, invalidSkipped, legacySideEffectSkipped, missing}
}

const isAuditedOrigin = (url: string) => {
  const origin = new URL(url).origin
  return origin === appBaseUrl || origin === apiBaseUrl
}

const isBenignRequest = (request: Request) => {
  const url = new URL(request.url())
  return url.origin === appBaseUrl && url.pathname === '/favicon.ico'
}

const isBrowserResourceLoadConsoleError = (message: string) => {
  return message.startsWith('Failed to load resource: the server responded with a status of')
}

const shouldInspectResponseBodyForLargeRebuildFailure = (response: Response) => {
  return ['document', 'fetch', 'xhr'].includes(response.request().resourceType())
}

const isWarningsEndpointResponse = (response: Response) => {
  const url = new URL(response.url())

  return url.origin === apiBaseUrl && url.pathname === warningEndpointPath && response.request().method() === 'POST'
}

const isExpectedHttpFailure = (failure: Omit<NetworkFailure, 'pagePath'> & {pagePath: string}) => {
  const pathname = failure.url ? new URL(failure.url).pathname : ''

  return (
    failure.pagePath.includes('/projects/$id/humanAssessment')
    && failure.status === 404
    && pathname === '/api/humanassessment/init'
    && failure.details?.includes('No articles left to judge') === true
  )
}

const getResponseBodyText = async (response: Response) => {
  try {
    return response.text()
  } catch (error) {
    return error instanceof Error ? `Could not read response body: ${error.message}` : 'Could not read response body'
  }
}

const getResponseBodySnippet = (body: string) => {
  return body.replace(/\s+/g, ' ').trim().slice(0, 500)
}

const formatNetworkFailure = (failure: NetworkFailure, index: number) => {
  const status = failure.status === undefined ? '' : ` ${failure.status}`
  const method = failure.method ? ` ${failure.method}` : ''
  const url = failure.url ? ` ${failure.url}` : ''
  const details = failure.details ? `\n   ${failure.details}` : ''
  return `${index + 1}. [${failure.pagePath}] ${failure.source}${status}${method}${url}${details}`
}

const createNetworkFailureRecorder = (page: Page, pagePath: () => string) => {
  const failures: NetworkFailure[] = []
  const pendingHttpFailureReads: Promise<void>[] = []
  const pendingAuditedRequests = new Map<Request, PendingAuditedRequest>()

  const createPendingAuditedRequest = () => {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })

    return {promise, resolve}
  }

  const record = (failure: Omit<NetworkFailure, 'pagePath'>) => {
    failures.push({...failure, pagePath: pagePath()})
  }

  const settleAuditedRequest = (request: Request) => {
    const pending = pendingAuditedRequests.get(request)

    if (!pending) {
      return
    }

    pending.resolve()
    pendingAuditedRequests.delete(request)
  }

  const onRequest = (request: Request) => {
    if (!isAuditedOrigin(request.url()) || isBenignRequest(request)) {
      return
    }

    pendingAuditedRequests.set(request, createPendingAuditedRequest())
  }

  const onRequestFailed = (request: Request) => {
    if (!isAuditedOrigin(request.url()) || isBenignRequest(request)) {
      return
    }

    record({
      details: request.failure()?.errorText ?? 'request failed',
      method: request.method(),
      source: 'requestfailed',
      url: request.url(),
    })
    settleAuditedRequest(request)
  }

  const onRequestFinished = (request: Request) => {
    settleAuditedRequest(request)
  }

  const onResponse = (response: Response) => {
    const request = response.request()

    if (!isAuditedOrigin(response.url()) || isBenignRequest(request)) {
      return
    }

    if (response.status() < 400 && !shouldInspectResponseBodyForLargeRebuildFailure(response)) {
      return
    }

    const bodyRead = getResponseBodyText(response).then(async (body) => {
      const details = getResponseBodySnippet(body)

      if (shouldInspectResponseBodyForLargeRebuildFailure(response) && textContainsLargeRebuildFailure(body)) {
        record({
          details,
          method: request.method(),
          source: 'large-rebuild-failure',
          status: response.status(),
          url: response.url(),
        })
      }

      const warningInspection =
        response.status() < 400 && isWarningsEndpointResponse(response)
          ? getWarningsEndpointInspection(body)
          : ({kind: 'ok'} as const)

      if (warningInspection.kind === 'failure') {
        record({
          details: warningInspection.details,
          method: request.method(),
          source: 'warning-indexing-state',
          status: response.status(),
          url: response.url(),
        })
      }

      if (response.status() < 400) {
        return
      }

      const failure = {
        details,
        method: request.method(),
        pagePath: pagePath(),
        source: 'http',
        status: response.status(),
        url: response.url(),
      }

      if (isExpectedHttpFailure(failure)) {
        return
      }

      record(failure)
    })
    pendingHttpFailureReads.push(bodyRead)
  }

  const onPageError = (error: Error) => {
    const details = error.stack ?? error.message

    if (textContainsLargeRebuildFailure(details)) {
      record({details, source: 'large-rebuild-failure'})
    }

    record({details, source: 'pageerror'})
  }

  const onConsole = (message: {text: () => string; type: () => string}) => {
    const details = message.text()

    if (textContainsLargeRebuildFailure(details)) {
      record({details, source: 'large-rebuild-failure'})
    }

    if (message.type() !== 'error' || isBrowserResourceLoadConsoleError(details)) {
      return
    }

    record({details, source: 'console.error'})
  }

  page.on('requestfailed', onRequestFailed)
  page.on('request', onRequest)
  page.on('requestfinished', onRequestFinished)
  page.on('response', onResponse)
  page.on('pageerror', onPageError)
  page.on('console', onConsole)

  const waitForAuditedRequests = async (): Promise<void> => {
    const pendingRequests = [...pendingAuditedRequests.values()].map((request) => {
      return request.promise
    })

    if (pendingRequests.length === 0) {
      await Promise.all(pendingHttpFailureReads)
      return
    }

    await Promise.all(pendingRequests)
    await waitForAuditedRequests()
  }

  return {
    assertNoFailures: async () => {
      await waitForAuditedRequests()

      if (failures.length === 0) {
        return
      }

      throw new Error(failures.map(formatNetworkFailure).join('\n'))
    },
    dispose: () => {
      page.off('requestfailed', onRequestFailed)
      page.off('request', onRequest)
      page.off('requestfinished', onRequestFinished)
      page.off('response', onResponse)
      page.off('pageerror', onPageError)
      page.off('console', onConsole)
    },
    waitForAuditedRequests,
  }
}

const visitRoute = async (page: Page, pathToVisit: string, waitForAuditedRequests: () => Promise<void>) => {
  await page.goto(pathToVisit)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForLoadState('networkidle', {timeout: 2_000}).catch(() => {
    return undefined
  })
  await waitForAuditedRequests()
  assertTextDoesNotContainLargeRebuildFailure(`page HTML for ${pathToVisit}`, await page.content())
  await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
}

test('network smoke route inventory stays explicit', () => {
  const report = getRouteInventoryReport()

  expect(report.missing, 'Add new routes to audited or skipped network smoke inventory').toEqual([])
  expect(report.extra, 'Remove stale routes from network smoke inventory').toEqual([])
  expect(report.duplicateAudited, 'Each audited route template should appear once').toEqual([])
  expect(report.invalidSkipped, 'Skipped network smoke routes need an explicit allowed classification').toEqual([])
  expect(
    report.legacySideEffectSkipped,
    'No normal browser route may remain skipped only because it queues legacy V3 repair, dirty refresh, or large-rebuild work on load',
  ).toEqual([])
})

test('audited app pages have no unexpected local network errors', async ({page}) => {
  test.skip(!isNetworkSmokeAudit, 'Network smoke audit only runs via bun run test:network-smoke')

  const seed = await createNetworkSmokeSeed()
  const auditTargets = getAuditTargetsForSeed(seed)
  logMissingExistingDataSkippedTargets(seed)
  await runCurrentDbWarningsEndpointProbe()

  let currentPagePath = 'seed'
  const recorder = createNetworkFailureRecorder(page, () => {
    return currentPagePath
  })

  try {
    for (const target of auditTargets) {
      currentPagePath = `${target.label} (${target.template})`
      await test.step(currentPagePath, async () => {
        await visitRoute(page, target.buildPath(seed), recorder.waitForAuditedRequests)
      })
    }

    await recorder.assertNoFailures()
    assertRuntimeLogsDoNotContainForbiddenServerErrors()
  } finally {
    recorder.dispose()
  }
})
