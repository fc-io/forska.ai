import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCodexCliLoginStatus, getCodexDeviceAuthLoginJob, startCodexDeviceAuthLogin} from '../utils/codexCliAuth.ts'
import {env} from '../utils/env.ts'
import {getCodexAppServerClient, getCodexBinPath} from '../utils/getCodexAppServerClient.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const normalizeDisplayName = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : 'Codex model'
}

const toCodexVirtualId = (modelName: string, effort?: string | null): string => {
  const trimmedEffort = String(effort ?? '').trim()
  return trimmedEffort.length > 0 ? `codex:${modelName}:${trimmedEffort}` : `codex:${modelName}`
}

const effortSortKey = (effort: string): number => {
  switch (effort) {
    case 'none':
      return 0
    case 'minimal':
      return 1
    case 'low':
      return 2
    case 'medium':
      return 3
    case 'high':
      return 4
    case 'xhigh':
      return 5
    default:
      return 99
  }
}

export const modelsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia()
      .get('/api/models', async () => {
        const [hpcModelsRows, codexModelsFromDbRows] = await Promise.all([
          getAppDatabaseService().queryJson<{
            id: string
            createdAt: unknown
            updatedAt: unknown
            name: string
            provider: string | null
            baseURL: string | null
            modelName: string | null
            version: string | null
            apiKeyVariable: string | null
            workerUrls: unknown
          }>(`
            SELECT
              id,
              created_at AS createdAt,
              updated_at AS updatedAt,
              name,
              provider,
              base_url AS baseURL,
              model_name AS modelName,
              version,
              api_key_variable AS apiKeyVariable,
              TO_JSON(worker_urls) AS workerUrls
            FROM app.model
            WHERE provider IS NULL OR provider != 'codex'
            ORDER BY created_at ASC
          `),
          getAppDatabaseService().queryJson<{
            id: string
            createdAt: unknown
            updatedAt: unknown
            name: string
            provider: string | null
            baseURL: string | null
            modelName: string | null
            version: string | null
            apiKeyVariable: string | null
            workerUrls: unknown
          }>(`
            SELECT
              id,
              created_at AS createdAt,
              updated_at AS updatedAt,
              name,
              provider,
              base_url AS baseURL,
              model_name AS modelName,
              version,
              api_key_variable AS apiKeyVariable,
              TO_JSON(worker_urls) AS workerUrls
            FROM app.model
            WHERE provider = 'codex'
            ORDER BY created_at ASC
          `),
        ])
        const normalizeRows = (rows: typeof hpcModelsRows) => {
          return rows.map((row) => {
            return {...row, workerUrls: getJsonValue(row.workerUrls) as string[] | null}
          })
        }
        const hpcModels = normalizeRows(hpcModelsRows)
        const codexModelsFromDb = normalizeRows(codexModelsFromDbRows)

        const codexVirtualFromDb = codexModelsFromDb
          .filter((m) => {
            return typeof m.modelName === 'string' && m.modelName.trim().length > 0
          })
          .map((m) => {
            const modelName = String(m.modelName).trim()
            const effort = typeof m.version === 'string' ? m.version.trim() : null
            return {
              ...m,
              id: toCodexVirtualId(modelName, effort),
              provider: 'codex',
              modelName,
              baseURL: null,
              workerUrls: null,
              apiKeyVariable: null,
            }
          })

        const codexVirtualFromServer = await (async () => {
          try {
            const client = getCodexAppServerClient()
            const {data} = await client.modelList({limit: 200, includeHidden: false, cursor: null})
            return data
              .filter((m) => {
                return !m.hidden
              })
              .flatMap((m) => {
                const modelName = String(m.id).trim()
                const baseName = normalizeDisplayName(m.displayName ?? m.id)
                const supported = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []
                const defaultEffort = typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null
                const sortedEfforts = [...supported].sort((a, b) => {
                  const aEffort = String(a.reasoningEffort)
                  const bEffort = String(b.reasoningEffort)
                  const aIsDefault = Boolean(defaultEffort && aEffort === defaultEffort)
                  const bIsDefault = Boolean(defaultEffort && bEffort === defaultEffort)
                  if (aIsDefault && !bIsDefault) return -1
                  if (!aIsDefault && bIsDefault) return 1
                  return effortSortKey(aEffort) - effortSortKey(bEffort)
                })

                const auto = {
                  id: toCodexVirtualId(modelName),
                  createdAt: null,
                  updatedAt: null,
                  name: `${baseName} (thinking: auto)`,
                  provider: 'codex',
                  baseURL: null,
                  modelName,
                  version: null,
                  apiKeyVariable: null,
                  workerUrls: null,
                }

                const variants = sortedEfforts
                  .map((eff) => {
                    const effort = String(eff.reasoningEffort).trim()
                    if (!effort) return null
                    return {
                      id: toCodexVirtualId(modelName, effort),
                      createdAt: null,
                      updatedAt: null,
                      name: `${baseName} (thinking: ${effort})`,
                      provider: 'codex',
                      baseURL: null,
                      modelName,
                      version: effort,
                      apiKeyVariable: null,
                      workerUrls: null,
                    }
                  })
                  .filter((v): v is NonNullable<typeof v> => {
                    return Boolean(v)
                  })

                return [auto, ...variants]
              })
          } catch (error) {
            console.warn('[models] Failed to load Codex models:', error instanceof Error ? error.message : error)
            return []
          }
        })()

        const codexModels = codexVirtualFromServer.length > 0 ? codexVirtualFromServer : codexVirtualFromDb
        const combined = [...hpcModels, ...codexModels]
        return {data: combined}
      })
      .get('/api/models/codex/status', async () => {
        const codexBin = getCodexBinPath()
        const cli = await getCodexCliLoginStatus()
        const appServerReady =
          cli.ok && cli.loggedIn
            ? await (async () => {
                try {
                  const client = getCodexAppServerClient()
                  await client.modelList({limit: 1, includeHidden: false, cursor: null})
                  return true
                } catch (_error) {
                  return false
                }
              })()
            : false

        const message = !cli.ok
          ? 'Codex CLI not available. Install @openai/codex and ensure CODEX_BIN points to it.'
          : cli.loggedIn
            ? appServerReady
              ? 'Codex connected.'
              : 'Codex logged in, but app-server is not responding.'
            : 'Codex not logged in.'

        return {data: {codexBin, cli, appServerReady, message}, error: null}
      })
      .post('/api/models/codex/login', async () => {
        const cli = await getCodexCliLoginStatus()
        if (cli.ok && cli.loggedIn) {
          return {data: {started: false, job: null, message: 'Already logged in.'}, error: null}
        }
        const job = startCodexDeviceAuthLogin()
        return {data: {started: true, job, message: 'Started Codex device login.'}, error: null}
      })
      .get(
        '/api/models/codex/login/:jobId',
        async ({params, set}) => {
          const job = getCodexDeviceAuthLoginJob(params.jobId)
          if (!job) {
            set.status = 404
            return {data: null, error: 'Login job not found'}
          }
          return {data: job, error: null}
        },
        {params: t.Object({jobId: t.String()})},
      )
      .post(
        '/api/models/ensure',
        async ({body, set}) => {
          if (body.provider !== 'codex') {
            set.status = 400
            return {data: null, error: 'Unsupported provider'}
          }

          const modelName = body.modelName.trim()
          if (!modelName) {
            set.status = 400
            return {data: null, error: 'modelName is required'}
          }

          const rawVersion = typeof body.version === 'string' ? body.version.trim() : ''
          const version = rawVersion.length > 0 ? rawVersion : null

          const name = normalizeDisplayName(body.name)
          const [existing] = await getAppDatabaseService().queryJson<{id: string}>(`
            SELECT id
            FROM app.model
            WHERE provider = 'codex'
              AND model_name = ${getSqlLiteral(modelName)}
              AND ${version ? `version = ${getSqlLiteral(version)}` : 'version IS NULL'}
            LIMIT 1
          `)

          if (existing) {
            return {data: {modelId: existing.id}, error: null}
          }

          const [inserted] = await getAppDatabaseService().queryJson<{id: string}>(`
            INSERT INTO app.model (id, name, provider, model_name, version, base_url)
            VALUES (${getQuotedStringList([crypto.randomUUID(), name, 'codex', modelName]).join(', ')}, ${getSqlLiteral(version)}, NULL)
            RETURNING id
          `)

          if (!inserted) {
            throw new Error('Failed to create Codex model')
          }

          return {data: {modelId: inserted.id}, error: null}
        },
        {
          body: t.Object({
            provider: t.String(),
            modelName: t.String(),
            name: t.String(),
            version: t.Optional(t.String()),
          }),
        },
      ),
  )
  .use(
    new Elysia().get('/api/models/gpu-info', async () => {
      return {
        data: {
          GPU_NNODES: env.GPU_NNODES,
          GPU_GPUS_PER_NODE: env.GPU_GPUS_PER_NODE,
          GPU_SHAPE: env.GPU_SHAPE,
          GPU_TOTAL_GPUS: env.GPU_TOTAL_GPUS,
          TP_SIZE: env.TP_SIZE,
          DP_SIZE: env.DP_SIZE,
          SGLANG_MAX_RUNNING_REQUESTS: env.SGLANG_MAX_RUNNING_REQUESTS,
          WORKER_URLS: env.WORKER_URLS,
          SGLANG_MODEL: env.SGLANG_MODEL,
        },
      }
    }),
  )
