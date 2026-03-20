import {type ProviderCatalogEntry} from '../../services/providerCatalog.ts'
import {type ProviderDefinition} from '../providerTypes.ts'
import {
  getCodexAppDeviceLoginJob,
  getCodexAppHealthResult,
  getCodexAppRuntimeStatus,
  getCurrentCodexAppDeviceLoginJob,
  invokeCodexAppModel,
  listCodexAppModels,
  startCodexAppDeviceLogin,
} from '../transports/codexAppTransport.ts'
import {
  getProviderConnectedMessage,
  getProviderHealthFailure,
  getProviderHealthSuccess,
  resolveSecretlessRuntimeCredentials,
} from './providerAdapterUtils.ts'

export const createCodexAdapter = (catalog: ProviderCatalogEntry): ProviderDefinition => {
  const getJobIdValue = (value: unknown): string | null => {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }

  const getCurrentJob = ({jobId}: {jobId?: string | null}) => {
    return jobId ? getCodexAppDeviceLoginJob(jobId) : getCurrentCodexAppDeviceLoginJob()
  }

  const getHealth = async () => {
    const health = await getCodexAppHealthResult()

    if (!health.ok) {
      return health
    }

    try {
      const models = await listCodexAppModels()

      return getProviderHealthSuccess({
        message: getProviderConnectedMessage({catalog, modelCount: models.length}),
        modelCount: models.length,
      })
    } catch (error) {
      return getProviderHealthFailure(error)
    }
  }

  return {
    beginAuth: async ({connection}) => {
      const status = await getCodexAppRuntimeStatus()

      if (status.cli.loggedIn && status.appServerReady) {
        return {
          connection,
          message: status.message,
          payload: {authMode: 'codex-cli', providerState: status},
          status: 'complete',
        }
      }

      if (!status.cli.ok) {
        return {
          connection,
          message: status.message,
          payload: {authMode: 'codex-cli', providerState: status},
          status: 'unsupported',
        }
      }

      const currentJob = getCurrentJob({})
      const job = currentJob && currentJob.state === 'running' ? currentJob : startCodexAppDeviceLogin()

      return {
        connection,
        message: 'Started Codex device login',
        payload: {authMode: 'codex-cli', providerState: {...status, job}},
        status: 'pending',
      }
    },
    catalog,
    finishAuth: async ({connection, payload}) => {
      const status = await getCodexAppRuntimeStatus()

      if (status.cli.loggedIn && status.appServerReady) {
        return {
          connection,
          message: status.message,
          payload: {authMode: 'codex-cli', providerState: status},
          status: 'complete',
        }
      }

      const jobId =
        getJobIdValue((payload as {jobId?: unknown} | null)?.jobId)
        ?? (typeof payload?.providerState === 'object'
        && payload.providerState !== null
        && 'jobId' in payload.providerState
          ? getJobIdValue((payload.providerState as {jobId?: unknown}).jobId)
          : typeof payload?.providerState === 'object'
              && payload.providerState !== null
              && 'job' in payload.providerState
            ? getJobIdValue((payload.providerState as {job?: {id?: unknown}}).job?.id)
            : null)
      const job = getCurrentJob({jobId})

      if (job?.state === 'failed') {
        throw new Error(job.error ?? 'Codex login failed')
      }

      return job?.state === 'running'
        ? {
            connection,
            message: 'Codex device login still in progress',
            payload: {authMode: 'codex-cli', providerState: {...status, job}},
            status: 'pending',
          }
        : {
            connection,
            message: status.message,
            payload: {authMode: 'codex-cli', providerState: {...status, job}},
            status: status.cli.loggedIn ? 'pending' : 'unsupported',
          }
    },
    health: async () => {
      return getHealth()
    },
    invoke: async ({model, request}) => {
      return invokeCodexAppModel({
        modelName: model.modelName ?? model.remoteModelId ?? model.name,
        outputSchema: request.outputSchema,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        version: model.variant ?? model.version,
      })
    },
    kind: catalog.kind,
    listModels: async () => {
      return listCodexAppModels()
    },
    parseUsage: (usage) => {
      return usage
    },
    resolveRuntimeCredentials: async ({connection}) => {
      return resolveSecretlessRuntimeCredentials({baseURL: connection.baseURL, secretRef: connection.secretRef})
    },
    testConnection: async () => {
      return getHealth()
    },
    transportFamily: 'codex-app',
  }
}
