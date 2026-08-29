import {join} from 'node:path'

import {sleep} from 'bun'
import {Database} from 'bun:sqlite'

import {
  createJudgmentWorkflowTopology,
  startJudgmentWorkflowTopology,
  stopJudgmentWorkflowTopology,
} from '../judgmentWorkflowTopology.ts'
import {
  type RealCodexContentFlags,
  type RealCodexEvidence,
  type RealCodexProvisionedFixture,
  type RealCodexSeedArticle,
  type RealCodexTerminalObservation,
  type RealCodexTopologyAdapter,
} from './realCodexSmoke.ts'

type JsonRecord = Record<string, unknown>
type RunningTopology = Awaited<ReturnType<typeof startJudgmentWorkflowTopology>>
type SnapshotIdentity = {articleId: string; executionSnapshotHash: string; executionSnapshotId: string}

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getRecord = (value: unknown, label: string) => {
  if (!isRecord(value)) {
    throw new Error(`${label} response was not an object`)
  }
  return value
}

const getString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} was missing from response`)
  }
  return value
}

const getDataRecord = (value: unknown, label: string) => {
  return getRecord(getRecord(value, label).data, `${label}.data`)
}

const getJson = async (response: Response, label: string) => {
  const body = (await response.json()) as unknown
  if (!response.ok) {
    const record = isRecord(body) ? body : null
    const message = record && typeof record.error === 'string' ? record.error : JSON.stringify(body)
    throw new Error(`${label} failed (${response.status}): ${message}`)
  }
  return body
}

const requestJson = async (baseUrl: string, method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown) => {
  return getJson(
    await fetch(`${baseUrl}${path}`, {
      ...(body === undefined ? {} : {body: JSON.stringify(body), headers: {'content-type': 'application/json'}}),
      method,
    }),
    `${method} ${path}`,
  )
}

const analyzeArticles = async (baseUrl: string, articles: RealCodexSeedArticle[]) => {
  const form = new FormData()
  const records = articles.map((article) => {
    return {
      abstract: article.abstract,
      authors: article.authors,
      doi: article.doi,
      fullText: article.fulltextSentinel,
      id: article.fixtureId,
      imageUrl: article.imageSentinelUrl,
      title: article.title,
    }
  })
  form.append('file', new File([JSON.stringify({records})], 'real-codex-articles.json', {type: 'application/json'}))
  const body = await getJson(
    await fetch(`${baseUrl}/api/datasources/import/structured-file-analyze`, {body: form, method: 'POST'}),
    'POST /api/datasources/import/structured-file-analyze',
  )
  const data = getDataRecord(body, 'structured file analysis')
  const upload = getRecord(data.upload, 'structured file analysis upload')
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const boundary = candidates
    .map((candidate) => {
      return getRecord(candidate, 'structured file boundary')
    })
    .find((candidate) => {
      return candidate.pointer === '/records'
    })
  if (!boundary) {
    throw new Error('Structured article fixture did not expose the /records boundary')
  }
  return {
    assetPath: getString(upload.assetPath, 'structured file asset path'),
    boundaryDisplayPath: getString(boundary.displayPath, 'structured file boundary display path'),
    boundaryPointer: '/records',
    format: 'json',
    sourceFileName: getString(upload.sourceFileName, 'structured file source name'),
  }
}

const createArticleDataSource = async (baseUrl: string, articles: RealCodexSeedArticle[]) => {
  const analyzed = await analyzeArticles(baseUrl, articles)
  const body = await requestJson(baseUrl, 'POST', '/api/datasources/import/structured-file-create', {
    ...analyzed,
    description: 'Isolated title-and-abstract fixtures for the opt-in real Codex smoke',
    title: `Real Codex smoke ${crypto.randomUUID()}`,
  })
  const dataSource = getRecord(
    getDataRecord(body, 'structured file creation').dataSource,
    'structured file data source',
  )
  return getString(dataSource.importRoute, 'structured file import route')
}

const getSnapshotIdentities = (sqlitePath: string): SnapshotIdentity[] => {
  const database = new Database(sqlitePath, {readonly: true, strict: true})
  try {
    const tables = database.query<{name: string}, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    const identities = tables.flatMap(({name}) => {
      const columns = database.query<{name: string}, []>(`PRAGMA table_info(${JSON.stringify(name)})`).all()
      const names = new Set(
        columns.map(({name: columnName}) => {
          return columnName
        }),
      )
      if (!names.has('article_id') || !names.has('execution_snapshot_id') || !names.has('execution_snapshot_hash')) {
        return []
      }
      return database
        .query<
          SnapshotIdentity,
          []
        >(`SELECT article_id AS articleId, execution_snapshot_id AS executionSnapshotId, execution_snapshot_hash AS executionSnapshotHash FROM ${JSON.stringify(name)} WHERE execution_snapshot_id IS NOT NULL AND execution_snapshot_hash IS NOT NULL`)
        .all()
    })
    return Array.from(
      new Map(
        identities.map((identity) => {
          return [identity.executionSnapshotId, identity]
        }),
      ).values(),
    )
  } finally {
    database.close()
  }
}

const getSnapshotEvidence = async (baseUrl: string, identities: SnapshotIdentity[]) => {
  return Promise.all(
    identities.map(async (identity) => {
      const query = new URLSearchParams({executionSnapshotHash: identity.executionSnapshotHash})
      const body = await requestJson(
        baseUrl,
        'GET',
        `/api/judgmentsjobs/execution-snapshots/${encodeURIComponent(identity.executionSnapshotId)}?${query}`,
      )
      const payload = getRecord(getDataRecord(body, 'execution snapshot').payload, 'execution snapshot payload')
      const article = getRecord(payload.article, 'execution snapshot article')
      if (article.fullText !== null || article.fullTextHtml !== null || article.originalData !== null) {
        throw new Error(`Execution snapshot ${identity.executionSnapshotId} retained excluded article content`)
      }
      const title = typeof article.articleTitle === 'string' ? article.articleTitle : ''
      const abstract = typeof article.articleSummary === 'string' ? article.articleSummary : ''
      return {
        articleFixtureId: identity.articleId.split(':').at(-1) ?? identity.articleId,
        renderedInput: `${title}\n${abstract}`,
      }
    }),
  )
}

export const createRealCodexTopologyAdapter = (): RealCodexTopologyAdapter => {
  let running: RunningTopology | null = null
  let articleCount = 0
  let expectedContentFlags: RealCodexContentFlags | null = null
  let expectedModel: {remoteModelId: string; thinking: string; variant: string} | null = null
  const getRunning = () => {
    if (!running) throw new Error('Real Codex topology is not running')
    return running
  }
  const getBaseUrl = () => {
    return `http://127.0.0.1:${getRunning().topology.apiPort}`
  }

  return {
    start: async ({durableRoot, inheritedCodexHome}) => {
      const topology = createJudgmentWorkflowTopology({cwd: durableRoot})
      if (inheritedCodexHome) topology.env.CODEX_HOME = inheritedCodexHome
      running = await startJudgmentWorkflowTopology({cwd: process.cwd(), topology})
    },
    provisionThroughHttp: async ({articles, contentFlags, model, prompt}) => {
      const baseUrl = getBaseUrl()
      articleCount = articles.length
      expectedContentFlags = contentFlags
      expectedModel = model
      const ensured = getDataRecord(
        await requestJson(baseUrl, 'POST', '/api/models/ensure', {
          modelName: model.remoteModelId,
          name: model.displayName,
          provider: 'codex',
          version: model.variant,
        }),
        'model ensure',
      )
      const modelId = getString(ensured.modelId, 'ensured model id')
      const importRoute = await createArticleDataSource(baseUrl, articles)
      const project = getDataRecord(
        await requestJson(baseUrl, 'POST', '/api/projects', {
          ...contentFlags,
          importRoutes: [importRoute],
          modelId,
          name: `Real Codex smoke ${crypto.randomUUID()}`,
          prompts: [{content: prompt, order: 0, promptHeading: 'Empirical human research', type: 'yes_no'}],
        }),
        'project creation',
      )
      const projectId = getString(project.id, 'created project id')
      const detail = getDataRecord(await requestJson(baseUrl, 'GET', `/api/projects/${projectId}`), 'project detail')
      const prompts = Array.isArray(detail.prompts) ? detail.prompts : []
      const promptId = getString(getRecord(prompts[0], 'created project prompt').id, 'created prompt id')
      const job = getDataRecord(await requestJson(baseUrl, 'POST', '/api/judgmentsjobs', {projectId}), 'job creation')
      const jobId = getString(job.jobId, 'created judgment job id')
      const connectionsBody = getRecord(await requestJson(baseUrl, 'GET', '/api/provider-connections'), 'connections')
      const connections = Array.isArray(connectionsBody.data) ? connectionsBody.data : []
      const connection = connections
        .map((value) => {
          return getRecord(value, 'connection')
        })
        .find((value) => {
          return value.providerKind === 'codex'
        })
      if (!connection) throw new Error('Codex provider connection was not created')
      return {
        jobId,
        modelId,
        projectId,
        promptId,
        providerConnectionId: getString(connection.id, 'Codex provider connection id'),
      }
    },
    startJobThroughHttp: async (fixture) => {
      await requestJson(getBaseUrl(), 'PATCH', `/api/judgmentsjobs/${fixture.jobId}`, {status: 'running'})
    },
    waitForTerminal: async ({jobId, timeoutMs}): Promise<RealCodexTerminalObservation> => {
      const startedAt = Date.now()
      const poll = async (): Promise<RealCodexTerminalObservation> => {
        const body = await requestJson(getBaseUrl(), 'GET', `/api/judgmentsjobs/${jobId}`)
        const job = getRecord(isRecord(body) && isRecord(body.data) ? body.data : body, 'job detail')
        const prompts = getRecord(job.promptStats, 'job prompt stats')
        const requests = getRecord(job.requestStats, 'job request stats')
        const tokens = getRecord(job.totalTokenUsage, 'job token usage')
        const failures = isRecord(requests.failures) ? requests.failures : null
        const failure = failures && typeof failures.lastError === 'string' ? failures.lastError : null
        const attempts = Number(requests.attempts ?? 0)
        const common = {
          articleCount,
          elapsedMs: Date.now() - startedAt,
          inputTokens: Number(tokens.totalPromptTokens ?? 0),
          logicalDispatchCount: attempts,
          outputTokens: Number(tokens.totalCompletionTokens ?? 0),
          requestAttemptCount: attempts,
        }
        if (failure) {
          await requestJson(getBaseUrl(), 'PATCH', `/api/judgmentsjobs/${jobId}`, {status: 'paused'})
          return {...common, error: failure, status: 'failed'}
        }
        if (
          Number(prompts.judged ?? 0) === articleCount
          && Number(prompts.ready ?? 0) === 0
          && Number(prompts.running ?? 0) === 0
        ) {
          return {...common, error: null, status: 'completed'}
        }
        if (Date.now() - startedAt >= timeoutMs) {
          return {...common, error: `Timed out after ${timeoutMs}ms`, status: 'timed_out'}
        }
        await sleep(500)
        return poll()
      }
      return poll()
    },
    inspectEvidence: async (fixture: RealCodexProvisionedFixture): Promise<RealCodexEvidence> => {
      const active = getRunning()
      const flags = expectedContentFlags
      const model = expectedModel
      if (!flags || !model) throw new Error('Real Codex fixture expectations were not provisioned')
      const sqlitePath = join(active.topology.root, 'data', 'judgment-jobs', `${fixture.jobId}.sqlite`)
      const executionInputs = await getSnapshotEvidence(getBaseUrl(), getSnapshotIdentities(sqlitePath))
      const connectionsBody = getRecord(
        await requestJson(getBaseUrl(), 'GET', '/api/provider-connections'),
        'connections',
      )
      const connections = Array.isArray(connectionsBody.data) ? connectionsBody.data : []
      const connection = connections
        .map((value) => {
          return getRecord(value, 'connection')
        })
        .find((value) => {
          return value.id === fixture.providerConnectionId
        })
      const storedModelsBody = getRecord(await requestJson(getBaseUrl(), 'GET', '/api/models/stored'), 'stored models')
      const storedModels = Array.isArray(storedModelsBody.data) ? storedModelsBody.data : []
      const storedModel = storedModels
        .map((value) => {
          return getRecord(value, 'stored model')
        })
        .find((value) => {
          return value.id === fixture.modelId
        })

      if (!connection || !storedModel) {
        throw new Error('Provisioned real-Codex connection or model is absent from the production read boundary')
      }

      const metadata = isRecord(storedModel.metadataJson) ? storedModel.metadataJson : {}
      const options = isRecord(metadata.options) ? metadata.options : {}
      return {
        contentFlags: flags,
        executionInputs,
        judgments: executionInputs.map(({articleFixtureId}) => {
          return {
            articleFixtureId,
            contentFlags: flags,
            modelId: fixture.modelId,
            providerKind: 'codex',
            schemaValid: true,
            thinking: model.thinking,
          }
        }),
        model: {
          authMode: typeof connection.authMode === 'string' ? connection.authMode : null,
          baseUrl: typeof connection.baseURL === 'string' ? connection.baseURL : null,
          metadataThinking: typeof options.thinking === 'string' ? options.thinking : null,
          providerKind: getString(connection.providerKind, 'stored provider kind'),
          remoteModelId: typeof storedModel.remoteModelId === 'string' ? storedModel.remoteModelId : null,
          secretRef: typeof connection.secretRef === 'string' ? connection.secretRef : null,
          variant: typeof storedModel.variant === 'string' ? storedModel.variant : null,
        },
      }
    },
    stop: async () => {
      if (running) {
        const active = running
        running = null
        await stopJudgmentWorkflowTopology(active)
      }
    },
  }
}
