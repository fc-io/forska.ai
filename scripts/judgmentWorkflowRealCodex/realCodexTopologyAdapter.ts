import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {sleep} from 'bun'
import {Database} from 'bun:sqlite'

import {duckdbOwnerPrivateApiPrefix} from '../../src/server/routes/apiRouteClassification.ts'
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
      return {
        articleFixtureId: identity.articleId.split(':').at(-1) ?? identity.articleId,
        hasAbstract: typeof article.articleSummary === 'string' && article.articleSummary.length > 0,
        hasExcludedContent: false,
        hasTitle: typeof article.articleTitle === 'string' && article.articleTitle.length > 0,
      }
    }),
  )
}

export const createRealCodexTopologyAdapter = (): RealCodexTopologyAdapter => {
  let running: RunningTopology | null = null
  let articleCount = 0
  let provisionedFixture: RealCodexProvisionedFixture | null = null
  let requestEvidenceManifestPath: string | null = null
  let requestEvidenceOutputPath: string | null = null
  const getRunning = () => {
    if (!running) throw new Error('Real Codex topology is not running')
    return running
  }
  const getBaseUrl = () => {
    return `http://127.0.0.1:${getRunning().topology.apiPort}`
  }
  const getOwnerBaseUrl = () => {
    return `http://127.0.0.1:${getRunning().topology.maintenancePort}${duckdbOwnerPrivateApiPrefix}`
  }
  const getCanonicalEvidence = async (fixture: RealCodexProvisionedFixture) => {
    const token = getRunning().topology.env.FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN
    const body = await requestJson(getOwnerBaseUrl(), 'POST', '/api/test/judgment-workflow-real-codex/evidence', {
      ...fixture,
      token,
    })
    return getDataRecord(body, 'real Codex canonical evidence')
  }

  return {
    start: async ({durableRoot, inheritedCodexHome}) => {
      const topology = createJudgmentWorkflowTopology({cwd: durableRoot})
      requestEvidenceManifestPath = join(topology.root, 'request-evidence-manifest.json')
      requestEvidenceOutputPath = join(topology.root, 'request-evidence.jsonl')
      await writeFile(
        requestEvidenceManifestPath,
        JSON.stringify({fixtures: [], outputPath: requestEvidenceOutputPath}),
        'utf8',
      )
      topology.env.FORSKA_TEST_JUDGE_REQUEST_EVIDENCE_MANIFEST = requestEvidenceManifestPath
      topology.env.JUDGE_FIRST_REQUEST_LOG_FULL = 'false'
      topology.env.JUDGE_FIRST_REQUEST_PREVIEW_CHARS = '1'
      if (inheritedCodexHome) topology.env.CODEX_HOME = inheritedCodexHome
      running = await startJudgmentWorkflowTopology({cwd: process.cwd(), topology})
    },
    provisionThroughHttp: async ({articles, contentFlags, model, prompt}) => {
      const baseUrl = getBaseUrl()
      articleCount = articles.length
      if (!requestEvidenceManifestPath || !requestEvidenceOutputPath) {
        throw new Error('Real Codex request evidence paths were not initialized')
      }
      await writeFile(
        requestEvidenceManifestPath,
        JSON.stringify({
          fixtures: articles.map(({abstract, fixtureId, fulltextSentinel, imageSentinelUrl, title}) => {
            return {abstract, fixtureId, fulltextSentinel, imageSentinelUrl, title}
          }),
          outputPath: requestEvidenceOutputPath,
        }),
        'utf8',
      )
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
      provisionedFixture = {
        jobId,
        modelId,
        projectId,
        promptId,
        providerConnectionId: getString(connection.id, 'Codex provider connection id'),
      }
      return provisionedFixture
    },
    startJobThroughHttp: async (fixture) => {
      await requestJson(getBaseUrl(), 'PATCH', `/api/judgmentsjobs/${fixture.jobId}`, {status: 'running'})
    },
    waitForTerminal: async ({jobId, stopAdmissionAfterFailure, timeoutMs}): Promise<RealCodexTerminalObservation> => {
      const startedAt = Date.now()
      const poll = async (): Promise<RealCodexTerminalObservation> => {
        const body = await requestJson(getBaseUrl(), 'GET', `/api/judgmentsjobs/${jobId}`)
        const job = getRecord(isRecord(body) && isRecord(body.data) ? body.data : body, 'job detail')
        const requests = getRecord(job.requestStats, 'job request stats')
        const tokens = getRecord(job.totalTokenUsage, 'job token usage')
        const failures = isRecord(requests.failures) ? requests.failures : null
        const failure = failures && typeof failures.lastError === 'string' ? failures.lastError : null
        const attempts = Number(requests.attempts ?? 0)
        const fixture = provisionedFixture
        if (!fixture) throw new Error('Real Codex fixture was not provisioned')
        const canonicalEvidence = await getCanonicalEvidence(fixture)
        const judgments = Array.isArray(canonicalEvidence.judgments) ? canonicalEvidence.judgments : []
        const common = {
          articleCount,
          elapsedMs: Date.now() - startedAt,
          inputTokens: Number(tokens.totalPromptTokens ?? 0),
          canonicalCompletionCount: judgments.length,
          outputTokens: Number(tokens.totalCompletionTokens ?? 0),
          providerDispatchCount: requestEvidenceOutputPath
            ? (
                await readFile(requestEvidenceOutputPath, 'utf8').catch(() => {
                  return ''
                })
              )
                .trim()
                .split('\n')
                .filter(Boolean).length
            : 0,
          requestAttemptCount: attempts,
        }
        if (failure) {
          if (stopAdmissionAfterFailure) {
            await requestJson(getBaseUrl(), 'PATCH', `/api/judgmentsjobs/${jobId}`, {status: 'paused'})
          }
          return {...common, error: failure, status: 'failed'}
        }
        if (
          judgments.length === articleCount
          && Number(canonicalEvidence.visibleProjectionCount ?? 0) === articleCount
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
      const sqlitePath = join(active.topology.root, 'data', 'judgment-jobs', `${fixture.jobId}.sqlite`)
      const executionInputs = await getSnapshotEvidence(getBaseUrl(), getSnapshotIdentities(sqlitePath))
      if (!requestEvidenceOutputPath) throw new Error('Real Codex request evidence path is unavailable')
      const requestInputs = (await readFile(requestEvidenceOutputPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          return getRecord(JSON.parse(line) as unknown, 'provider request evidence')
        })
      const canonicalEvidence = await getCanonicalEvidence(fixture)
      const canonicalJudgments = Array.isArray(canonicalEvidence.judgments)
        ? canonicalEvidence.judgments.map((value) => {
            return getRecord(value, 'canonical judgment')
          })
        : []
      const project = getDataRecord(
        await requestJson(getBaseUrl(), 'GET', `/api/projects/${fixture.projectId}`),
        'real Codex project detail',
      )
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
      const storedFlags = {
        useAbstract: project.useAbstract === true,
        useFulltext: project.useFulltext === true,
        useFulltextNoImages: project.useFulltextNoImages === true,
        useTitle: project.useTitle === true,
      } as RealCodexContentFlags
      const providerKind = getString(connection.providerKind, 'stored provider kind')
      const thinking = getString(options.thinking, 'stored model thinking')
      return {
        contentFlags: storedFlags,
        requestInputs: requestInputs.map((entry) => {
          return {
            articleFixtureId: getString(entry.articleFixtureId, 'request evidence article fixture id'),
            hasAbstract: entry.hasAbstract === true,
            hasExcludedFulltext: entry.hasExcludedFulltext === true,
            hasExcludedImage: entry.hasExcludedImage === true,
            hasTitle: entry.hasTitle === true,
            requestPayloadSha256: getString(entry.requestPayloadSha256, 'request payload hash'),
          }
        }),
        snapshotInputs: executionInputs,
        judgments: canonicalJudgments.map((judgment) => {
          const contentFlags = {
            useAbstract: judgment.useAbstract === true,
            useFulltext: judgment.useFulltext === true,
            useFulltextNoImages: judgment.useFulltextNoImages === true,
            useTitle: judgment.useTitle === true,
          } as RealCodexContentFlags
          return {
            articleFixtureId: getString(judgment.articleId, 'canonical judgment article id'),
            contentFlags,
            modelId: getString(judgment.modelId, 'canonical judgment model id'),
            providerKind,
            schemaValid:
              typeof judgment.isAnswered === 'boolean'
              && typeof judgment.answeredOriginal === 'string'
              && typeof judgment.explanation === 'string',
            thinking,
          }
        }),
        model: {
          authMode: typeof connection.authMode === 'string' ? connection.authMode : null,
          baseUrl: typeof connection.baseURL === 'string' ? connection.baseURL : null,
          metadataThinking: typeof options.thinking === 'string' ? options.thinking : null,
          providerKind,
          remoteModelId: typeof storedModel.remoteModelId === 'string' ? storedModel.remoteModelId : null,
          secretRef: typeof connection.secretRef === 'string' ? connection.secretRef : null,
          variant: typeof storedModel.variant === 'string' ? storedModel.variant : null,
        },
        visibleProjectionCount: Number(canonicalEvidence.visibleProjectionCount ?? 0),
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
