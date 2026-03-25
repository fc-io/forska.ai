import {
  type CodexDeviceLoginJob,
  getCodexCliLoginStatus,
  getCodexDeviceAuthLoginJob,
  getCurrentCodexDeviceAuthLoginJob,
  startCodexDeviceAuthLogin,
} from '../../utils/codexCliAuth.ts'
import {getCodexAppServerClient, getCodexBinPath} from '../../utils/getCodexAppServerClient.ts'
import {type ProviderHealthResult, type ProviderInvocationResult, type ProviderListedModel} from '../providerTypes.ts'

export type CodexRuntimeStatus = {
  appServerReady: boolean
  cli: Awaited<ReturnType<typeof getCodexCliLoginStatus>>
  codexBin: string
  message: string
}

const getCodexRuntimeStatusMessage = ({
  appServerReady,
  cli,
}: {
  appServerReady: boolean
  cli: Awaited<ReturnType<typeof getCodexCliLoginStatus>>
}): string => {
  return !cli.ok
    ? 'Codex CLI not available. Install @openai/codex and ensure CODEX_BIN points to it.'
    : cli.loggedIn
      ? appServerReady
        ? 'Codex connected.'
        : 'Codex logged in, but app-server is not responding.'
      : 'Codex not logged in.'
}

export const listCodexAppModels = async (): Promise<ProviderListedModel[]> => {
  const client = getCodexAppServerClient()
  const {data} = await client.modelList({cursor: null, includeHidden: false, limit: 200})

  return data
    .filter((model) => {
      return !model.hidden
    })
    .flatMap((model) => {
      const modelName = String(model.id).trim()
      const baseName = String(model.displayName ?? model.id).trim() || modelName
      const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []
      const autoModel = {
        displayName: `${baseName} (thinking: auto)`,
        metadataJson: model,
        modelName,
        remoteModelId: modelName,
        variant: null,
        version: null,
      }
      const variants = efforts
        .map((effortEntry) => {
          const effort = String(effortEntry.reasoningEffort ?? '').trim()

          return effort
            ? {
                displayName: `${baseName} (thinking: ${effort})`,
                metadataJson: {...model, reasoningEffort: effort},
                modelName,
                remoteModelId: modelName,
                variant: effort,
                version: effort,
              }
            : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => {
          return Boolean(entry)
        })

      return [autoModel, ...variants]
    })
}

export const invokeCodexAppModel = async ({
  modelName,
  outputSchema,
  prompt,
  systemPrompt,
  version,
}: {
  modelName: string
  outputSchema: unknown
  prompt: string
  systemPrompt: string
  version: string | null
}): Promise<ProviderInvocationResult> => {
  const client = getCodexAppServerClient()
  const result = await client.runJsonTurn({
    effort: version,
    inputText: `${systemPrompt}\n\n${prompt}`,
    model: modelName,
    outputSchema,
    timeoutMs: 900_000,
  })

  return {text: result.text, usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0}}
}

export const getCodexAppRuntimeStatus = async (): Promise<CodexRuntimeStatus> => {
  const codexBin = getCodexBinPath()
  const cli = await getCodexCliLoginStatus()
  const appServerReady =
    cli.ok && cli.loggedIn
      ? await (async () => {
          try {
            const client = getCodexAppServerClient()
            await client.modelList({cursor: null, includeHidden: false, limit: 1})
            return true
          } catch {
            return false
          }
        })()
      : false

  return {appServerReady, cli, codexBin, message: getCodexRuntimeStatusMessage({appServerReady, cli})}
}

export const getCodexAppHealthResult = async (): Promise<ProviderHealthResult> => {
  const status = await getCodexAppRuntimeStatus()

  return status.cli.loggedIn && status.appServerReady
    ? {lastError: null, message: status.message, modelCount: null, ok: true}
    : {lastError: status.message, message: status.message, modelCount: null, ok: false}
}

export const startCodexAppDeviceLogin = (): CodexDeviceLoginJob => {
  return startCodexDeviceAuthLogin()
}

export const getCodexAppDeviceLoginJob = (id: string): CodexDeviceLoginJob | null => {
  return getCodexDeviceAuthLoginJob(id)
}

export const getCurrentCodexAppDeviceLoginJob = (): CodexDeviceLoginJob | null => {
  return getCurrentCodexDeviceAuthLoginJob()
}
