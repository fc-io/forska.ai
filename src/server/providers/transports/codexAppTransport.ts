import {
  type CodexDeviceLoginJob,
  getCodexCliLoginStatus,
  getCodexDeviceAuthLoginJob,
  getCurrentCodexDeviceAuthLoginJob,
  startCodexDeviceAuthLogin,
} from '../../utils/codexCliAuth.ts'
import {type CodexTurnErrorEvent, getCodexTurnErrorEvents} from '../../utils/codexTurnErrors.ts'
import {
  type CodexThreadTokenUsage,
  getCodexAppServerClient,
  getCodexBinPath,
} from '../../utils/getCodexAppServerClient.ts'
import {codexRateLimitedFailureCode, getCodexConnectionTurnTimeoutMs} from '../codexRateLimitBackoff.ts'
import {
  getProviderImageDataUrl,
  getProviderPromptParts,
  getProviderTransportImages,
  isProviderMultipartPrompt,
} from '../providerImageInput.ts'
import {
  type ProviderHealthResult,
  ProviderInvocationError,
  type ProviderInvocationResult,
  type ProviderInvokePrompt,
  type ProviderListedModel,
  type ProviderUsageSnapshot,
} from '../providerTypes.ts'
import {providerUsageLimitPattern} from '../providerUsageLimitPattern.ts'

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

export const getProviderUsageFromCodexThreadTokenUsage = (
  usage: CodexThreadTokenUsage | null,
): ProviderUsageSnapshot => {
  const last = usage?.last
  if (!last) {
    return {completionTokens: 0, promptTokens: 0, totalTokens: 0}
  }

  const promptTokens = Math.max(0, last.inputTokens)
  const completionTokensFromTotal = Math.max(0, last.totalTokens - promptTokens)
  const completionTokensFromOutputs = Math.max(0, last.outputTokens + last.reasoningOutputTokens)
  const completionTokens =
    completionTokensFromTotal > 0 || completionTokensFromOutputs === 0
      ? completionTokensFromTotal
      : completionTokensFromOutputs

  return {completionTokens, promptTokens, totalTokens: Math.max(0, last.totalTokens)}
}

const getCodexInvocationErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const isTransientCodexTurnError = (error: unknown): boolean => {
  const message = getCodexInvocationErrorMessage(error).toLowerCase()

  return (
    message.includes('codex app-server: turn failed')
    || message.includes('codex app-server: turn timeout')
    || message.includes('codex app-server timeout:')
    || message.includes('operation timed out')
  )
}

const getCodexTransientTurnError = (error: unknown): ProviderInvocationError => {
  const message = getCodexInvocationErrorMessage(error)

  return new ProviderInvocationError(message, {
    cause: error,
    code: 'codex_transient_turn_failure',
    diagnostics: {message},
    providerKind: 'codex',
  })
}

const codexRateLimitTextPattern = /\b429 too many requests\b|\bstatus:?\s*429\b|\bhttp(?: error)?:?\s*429\b/i
const codexRequestIdPattern = /\brequest[ _-]?id:?\s*([0-9a-z][0-9a-z-]{7,})/i

const isCodexRateLimitEvent = (event: CodexTurnErrorEvent): boolean => {
  return (
    event.httpStatusCode === 429
    || event.codexErrorInfo === 'rateLimitExceeded'
    || codexRateLimitTextPattern.test(event.message)
  )
}

const getCodexTurnErrorTexts = (error: unknown): string[] => {
  return [
    getCodexInvocationErrorMessage(error),
    ...getCodexTurnErrorEvents(error).flatMap((event) => {
      return event.additionalDetails === null ? [event.message] : [event.message, event.additionalDetails]
    }),
  ]
}

const isCodexUsageLimitTurnError = (error: unknown): boolean => {
  return (
    getCodexTurnErrorEvents(error).some((event) => {
      return event.codexErrorInfo === 'usageLimitExceeded'
    })
    || getCodexTurnErrorTexts(error).some((text) => {
      return providerUsageLimitPattern.test(text)
    })
  )
}

const getCodexRateLimitEvent = (error: unknown): CodexTurnErrorEvent | null => {
  return getCodexTurnErrorEvents(error).findLast(isCodexRateLimitEvent) ?? null
}

const isCodexRateLimitedTurnError = (error: unknown): boolean => {
  return (
    isTransientCodexTurnError(error)
    && !isCodexUsageLimitTurnError(error)
    && (codexRateLimitTextPattern.test(getCodexInvocationErrorMessage(error)) || getCodexRateLimitEvent(error) !== null)
  )
}

const getCodexRequestId = (error: unknown): string | null => {
  return (
    getCodexTurnErrorTexts(error).reduce<string | null>((requestId, text) => {
      return requestId ?? codexRequestIdPattern.exec(text)?.[1] ?? null
    }, null) ?? null
  )
}

const getCodexRateLimitedMessage = (error: unknown): string => {
  const turnMessage = getCodexInvocationErrorMessage(error)
  const rateLimitEvent = getCodexRateLimitEvent(error)

  return codexRateLimitTextPattern.test(turnMessage) || rateLimitEvent === null
    ? `Codex backend rate limited (429): ${turnMessage}`
    : `Codex backend rate limited (429): ${turnMessage}; app-server reported: ${rateLimitEvent.message}`
}

const getCodexRateLimitedTurnError = (error: unknown): ProviderInvocationError => {
  const message = getCodexRateLimitedMessage(error)
  const rateLimitEvent = getCodexRateLimitEvent(error)

  return new ProviderInvocationError(message, {
    cause: error,
    code: codexRateLimitedFailureCode,
    diagnostics: {
      codexErrorInfo: rateLimitEvent?.codexErrorInfo ?? null,
      httpStatusCode: 429,
      message,
      requestId: getCodexRequestId(error),
      turnError: getCodexInvocationErrorMessage(error),
      willRetry: rateLimitEvent?.willRetry ?? null,
    },
    providerKind: 'codex',
  })
}

const getCodexTurnInvocationError = (error: unknown): unknown => {
  return isCodexRateLimitedTurnError(error)
    ? getCodexRateLimitedTurnError(error)
    : isTransientCodexTurnError(error)
      ? getCodexTransientTurnError(error)
      : error
}

export const getCodexAppTurnImageUrls = (prompt: ProviderInvokePrompt): string[] => {
  return getProviderTransportImages(getProviderPromptParts(prompt).images).map(getProviderImageDataUrl)
}

const getCodexAppTurnImageParams = (prompt: ProviderInvokePrompt): {inputImageUrls?: string[]} => {
  return isProviderMultipartPrompt(prompt) ? {inputImageUrls: getCodexAppTurnImageUrls(prompt)} : {}
}

export const invokeCodexAppModel = async ({
  connectionId,
  modelName,
  outputSchema,
  prompt,
  signal,
  systemPrompt,
  version,
}: {
  connectionId: string
  modelName: string
  outputSchema: unknown
  prompt: ProviderInvokePrompt
  signal?: AbortSignal
  systemPrompt: string
  version: string | null
}): Promise<ProviderInvocationResult> => {
  const client = getCodexAppServerClient()
  const result = await client
    .runJsonTurn({
      effort: version,
      ...getCodexAppTurnImageParams(prompt),
      inputText: `${systemPrompt}\n\n${getProviderPromptParts(prompt).text}`,
      model: modelName,
      outputSchema,
      signal,
      timeoutMs: getCodexConnectionTurnTimeoutMs(connectionId),
    })
    .catch((error: unknown) => {
      throw getCodexTurnInvocationError(error)
    })

  return {text: result.text, usage: getProviderUsageFromCodexThreadTokenUsage(result.usage)}
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
