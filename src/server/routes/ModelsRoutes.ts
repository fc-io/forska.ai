import {and, asc, eq, isNull, ne, or} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {auth} from '../../auth.ts'
import {models} from '../../db/schema.ts'
import {requireAdminAuth, requireUserAuth} from '../utils/authGuard.ts'
import {getCodexCliLoginStatus, getCodexDeviceAuthLoginJob, startCodexDeviceAuthLogin} from '../utils/codexCliAuth.ts'
import {env} from '../utils/env.ts'
import {getCodexAppServerClient, getCodexBinPath} from '../utils/getCodexAppServerClient.ts'
import {getDatabase} from '../utils/getDatabase.ts'
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
      .use(requireUserAuth())
      .get('/api/models', async ({request, set}) => {
        const session = await auth.api.getSession({headers: request.headers})
        const sessionUserId = session?.user?.id ?? session?.session?.userId ?? null
        if (!sessionUserId) {
          set.status = 401
          return {data: null, error: 'You must be signed in'}
        }

        const db = getDatabase()
        const hpcModels = await db
          .select()
          .from(models)
          .where(or(isNull(models.provider), ne(models.provider, 'codex')))
          .orderBy(asc(models.createdAt))

        const codexModelsFromDb = await db
          .select()
          .from(models)
          .where(and(eq(models.provider, 'codex'), eq(models.ownerId, sessionUserId)))
          .orderBy(asc(models.createdAt))

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
                  ownerId: sessionUserId,
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
                      ownerId: sessionUserId,
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
        async ({body, request, set}) => {
          const session = await auth.api.getSession({headers: request.headers})
          const sessionUserId = session?.user?.id ?? session?.session?.userId ?? null
          if (!sessionUserId) {
            set.status = 401
            return {data: null, error: 'You must be signed in'}
          }

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
          const db = getDatabase()

          const [existing] = await db
            .select({id: models.id})
            .from(models)
            .where(
              and(
                eq(models.ownerId, sessionUserId),
                eq(models.provider, 'codex'),
                eq(models.modelName, modelName),
                version ? eq(models.version, version) : isNull(models.version),
              ),
            )
            .limit(1)

          if (existing) {
            return {data: {modelId: existing.id}, error: null}
          }

          const [inserted] = await db
            .insert(models)
            .values({name, provider: 'codex', modelName, version, baseURL: null, ownerId: sessionUserId})
            .returning({id: models.id})

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
    new Elysia().use(requireAdminAuth()).get('/api/models/gpu-info', async () => {
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
