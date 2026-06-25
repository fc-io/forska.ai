import {expect, type Page, type Request, type Response, test} from '@playwright/test'
import {readFileSync} from 'node:fs'
import path from 'node:path'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'

const apiBaseUrl = 'http://127.0.0.1:43101'
const appBaseUrl = 'http://127.0.0.1:43100'
const isNetworkSmokeAudit = process.env.FORSKA_NETWORK_SMOKE_AUDIT === 'true'
const networkSmokeSeedMode = process.env.FORSKA_NETWORK_SMOKE_SEED_MODE === 'existing' ? 'existing' : 'synthetic'
const shouldSkipMutatingRouteLoads = process.env.FORSKA_NETWORK_SMOKE_SKIP_MUTATING_ROUTE_LOADS === 'true'

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

type NetworkSmokeTarget = {buildPath: (seed: NetworkSmokeSeed) => string; label: string; template: string}

type SkippedRouteTemplate = {reason: string; template: string}

type NetworkFailure = {
  details?: string
  method?: string
  pagePath: string
  source: string
  status?: number
  url?: string
}

type PendingAuditedRequest = {promise: Promise<void>; resolve: () => void}

const routeTreePath = path.resolve(process.cwd(), 'src/app/routeTree.gen.ts')

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

const getFirstOrThrow = <T>(values: T[], message: string) => {
  const first = values[0]

  if (!first) {
    throw new Error(message)
  }

  return first
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

  return prompt && article
    ? {articleId: article.id, modelId: projectDetail.project.modelId, projectId: project.id, promptId: prompt.id}
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

  if (!candidate) {
    throw new Error('Existing-data network smoke needs one active project with at least one linked prompt and article')
  }

  return candidate
}

const getExistingProviderConnectionId = async () => {
  const providerConnections = await getJson<ProviderConnectionsResponse>(
    `${apiBaseUrl}/api/provider-connections`,
    'Failed to fetch existing provider connections',
  )

  return getFirstOrThrow(
    providerConnections.connections,
    'Existing-data network smoke needs one provider connection for /providers/$id',
  ).id
}

const getExistingDataSourceId = async () => {
  const dataSources = await getJson<DataSourceListItem[]>(`${apiBaseUrl}/api/datasources`, 'Failed to fetch data sources')

  return getFirstOrThrow(
    dataSources,
    'Existing-data network smoke needs one active data source for /admin/datasources/$id/edit',
  ).id
}

const getExistingComparisonProjectId = async () => {
  if (shouldSkipMutatingRouteLoads) {
    return ''
  }

  const comparisonProjects = await getJson<ComparisonProjectListItem[]>(
    `${apiBaseUrl}/api/comparison-projects`,
    'Failed to fetch existing comparison projects',
  )

  return getFirstOrThrow(
    comparisonProjects,
    'Existing-data network smoke needs one active comparison project for /compare-judgments/$id routes',
  ).id
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
  {
    template: '/admin/project-mart-large-rebuild',
    label: 'admin project mart large rebuild',
    buildPath: () => '/admin/project-mart-large-rebuild',
  },
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
  {template: '/articles/$id', label: 'article detail', buildPath: (seed) => `/articles/${seed.articleId}`},
  {
    template: '/articles/$id/fulltext',
    label: 'article fulltext',
    buildPath: (seed) => `/articles/${seed.articleId}/fulltext`,
  },
  {
    template: '/compare-judgments/$id',
    label: 'comparison project detail',
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}`,
  },
  {
    template: '/compare-judgments/$id/edit',
    label: 'comparison project edit',
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}/edit`,
  },
  {
    template: '/compare-judgments/$id/export',
    label: 'comparison project export',
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}/export`,
  },
  {
    template: '/compare-judgments/$id/import-resolutions',
    label: 'comparison project import resolutions',
    buildPath: (seed) => `/compare-judgments/${seed.comparisonProjectId}/import-resolutions`,
  },
  {template: '/projects/$id', label: 'project detail', buildPath: (seed) => `/projects/${seed.projectId}`},
  {template: '/projects/$id/edit', label: 'project edit', buildPath: (seed) => `/projects/${seed.projectId}/edit`},
  {
    template: '/projects/$id/export',
    label: 'project export',
    buildPath: (seed) => `/projects/${seed.projectId}/export`,
  },
  {
    template: '/projects/$id/export-project',
    label: 'project package export',
    buildPath: (seed) => `/projects/${seed.projectId}/export-project`,
  },
  {
    template: '/projects/$id/humanAssessment',
    label: 'project human assessment',
    buildPath: (seed) => `/projects/${seed.projectId}/humanAssessment`,
  },
  {
    template: '/projects/$id/reviews',
    label: 'project reviews redirect',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews`,
  },
  {
    template: '/projects/$id/reviews-both',
    label: 'project both reviews',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-both`,
  },
  {
    template: '/projects/$id/reviews-human',
    label: 'project human reviews',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-human`,
  },
  {
    template: '/projects/$id/reviews-llm',
    label: 'project llm reviews',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-llm`,
  },
  {
    template: '/projects/$id/reviews-unassessed',
    label: 'project unassessed reviews',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-unassessed`,
  },
  {
    template: '/projects/$id/reviews-llm/$articleId',
    label: 'project llm review article',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-llm/${seed.articleId}`,
  },
  {
    template: '/projects/$id/reviews-llm/$articleId/fulltext',
    label: 'project llm review article fulltext',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews-llm/${seed.articleId}/fulltext`,
  },
  {
    template: '/projects/$id/reviews/$articleId',
    label: 'project review article redirect',
    buildPath: (seed) => `/projects/${seed.projectId}/reviews/${seed.articleId}`,
  },
  {
    template: '/providers/$id',
    label: 'provider detail',
    buildPath: (seed) => `/providers/${seed.providerConnectionId}`,
  },
  {
    template: '/admin/datasources/$id/edit',
    label: 'admin edit data source',
    buildPath: (seed) => `/admin/datasources/${seed.dataSourceId}/edit`,
  },
  {
    template: '/admin/unexpected-answers/$projectId',
    label: 'admin unexpected answers project',
    buildPath: (seed) => `/admin/unexpected-answers/${seed.projectId}`,
  },
  {
    template: '/admin/unexpected-answers/$projectId/$promptId',
    label: 'admin unexpected answers project prompt',
    buildPath: (seed) => `/admin/unexpected-answers/${seed.projectId}/${seed.promptId}`,
  },
  {
    template: '/admin/unexpected-answers/all-prompts/$promptId',
    label: 'admin unexpected answers prompt',
    buildPath: (seed) => `/admin/unexpected-answers/all-prompts/${seed.promptId}`,
  },
]

const baseSkippedRouteTemplates: SkippedRouteTemplate[] = [
  {
    template: '/admin/failed_requests/$id',
    reason:
      'needs a real failed token-usage request row; generic smoke seeding should not manufacture failed provider traffic',
  },
  {
    template: '/admin/jobs/$id',
    reason: 'creating a real judgment job requires runtime/model admission and local SQLite preflight state',
  },
  {
    template: '/admin/jobs/$id/unassessed_articles',
    reason: 'depends on the same safely-created judgment job fixture as the job detail route',
  },
]

const mutatingRouteLoadSkippedTemplates: SkippedRouteTemplate[] = [
  {
    template: '/compare-judgments/$id',
    reason: 'direct existing-DB read-only mode skips pages that can queue comparison-serving rebuild work on load',
  },
  {
    template: '/compare-judgments/$id/edit',
    reason: 'direct existing-DB read-only mode skips comparison-project dynamic pages as one route family',
  },
  {
    template: '/compare-judgments/$id/export',
    reason: 'direct existing-DB read-only mode skips pages that load comparison metadata through the rebuild-capable route',
  },
  {
    template: '/compare-judgments/$id/import-resolutions',
    reason: 'direct existing-DB read-only mode skips pages that load comparison metadata through the rebuild-capable route',
  },
  {
    template: '/projects/$id/humanAssessment',
    reason: 'direct existing-DB read-only mode skips POST /api/humanassessment/init because it can create pending human judgments',
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

  return {duplicateAudited, extra, generated, missing}
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

const isExpectedHttpFailure = (failure: Omit<NetworkFailure, 'pagePath'> & {pagePath: string}) => {
  const pathname = failure.url ? new URL(failure.url).pathname : ''

  return (
    failure.pagePath.includes('/projects/$id/humanAssessment')
    && failure.status === 404
    && pathname === '/api/humanassessment/init'
    && failure.details?.includes('No articles left to judge') === true
  )
}

const getResponseBodySnippet = async (response: Response) => {
  try {
    const body = await response.text()
    return body.replace(/\s+/g, ' ').trim().slice(0, 500)
  } catch (error) {
    return error instanceof Error ? `Could not read response body: ${error.message}` : 'Could not read response body'
  }
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

    if (!isAuditedOrigin(response.url()) || isBenignRequest(request) || response.status() < 400) {
      return
    }

    const bodyRead = getResponseBodySnippet(response).then((details) => {
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
    record({details: error.stack ?? error.message, source: 'pageerror'})
  }

  const onConsole = (message: {text: () => string; type: () => string}) => {
    if (message.type() !== 'error' || isBrowserResourceLoadConsoleError(message.text())) {
      return
    }

    record({details: message.text(), source: 'console.error'})
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
  await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
}

test('network smoke route inventory stays explicit', () => {
  const report = getRouteInventoryReport()

  expect(report.missing, 'Add new routes to audited or skipped network smoke inventory').toEqual([])
  expect(report.extra, 'Remove stale routes from network smoke inventory').toEqual([])
  expect(report.duplicateAudited, 'Each audited route template should appear once').toEqual([])
})

test('audited app pages have no unexpected local network errors', async ({page}) => {
  test.skip(!isNetworkSmokeAudit, 'Network smoke audit only runs via bun run test:network-smoke')

  const seed = await createNetworkSmokeSeed()
  let currentPagePath = 'seed'
  const recorder = createNetworkFailureRecorder(page, () => {
    return currentPagePath
  })

  try {
    for (const target of allAuditTargets) {
      currentPagePath = `${target.label} (${target.template})`
      await test.step(currentPagePath, async () => {
        await visitRoute(page, target.buildPath(seed), recorder.waitForAuditedRequests)
      })
    }

    await recorder.assertNoFailures()
  } finally {
    recorder.dispose()
  }
})
