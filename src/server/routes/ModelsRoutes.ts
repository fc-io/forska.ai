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

const toCodexVirtualId = (modelName: string): string => {
  return `codex:${modelName}`
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
            return {
              ...m,
              id: toCodexVirtualId(modelName),
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
              .map((m) => {
                const modelName = String(m.id).trim()
                return {
                  id: toCodexVirtualId(modelName),
                  createdAt: null,
                  updatedAt: null,
                  name: normalizeDisplayName(m.displayName ?? m.id),
                  provider: 'codex',
                  baseURL: null,
                  modelName,
                  version: null,
                  apiKeyVariable: null,
                  ownerId: sessionUserId,
                  workerUrls: null,
                }
              })
          } catch (error) {
            console.warn('[models] Failed to load Codex models:', error instanceof Error ? error.message : error)
            return []
          }
        })()

        const codexById = new Map(
          codexVirtualFromDb.map((m) => {
            return [m.id, m] as const
          }),
        )
        codexVirtualFromServer.forEach((m) => {
          codexById.set(m.id, m as unknown as (typeof codexVirtualFromDb)[number])
        })

        const combined = [...hpcModels, ...Array.from(codexById.values())]
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

          const name = normalizeDisplayName(body.name)
          const db = getDatabase()

          const [existing] = await db
            .select({id: models.id})
            .from(models)
            .where(
              and(eq(models.ownerId, sessionUserId), eq(models.provider, 'codex'), eq(models.modelName, modelName)),
            )
            .limit(1)

          if (existing) {
            return {data: {modelId: existing.id}, error: null}
          }

          const [inserted] = await db
            .insert(models)
            .values({name, provider: 'codex', modelName, baseURL: null, ownerId: sessionUserId})
            .returning({id: models.id})

          if (!inserted) {
            throw new Error('Failed to create Codex model')
          }

          return {data: {modelId: inserted.id}, error: null}
        },
        {body: t.Object({provider: t.String(), modelName: t.String(), name: t.String()})},
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
