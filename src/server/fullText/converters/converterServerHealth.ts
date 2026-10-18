import {
  clearProviderConnectionCheckError,
  setProviderConnectionCheckState,
} from '../../providers/providerConnectionRepository.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {type FullTextConversionRuntimeConfig} from './fullTextConverter.ts'

const converterServerHealthLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const logCheckStateWriteFailure = (runtimeConfig: FullTextConversionRuntimeConfig) => {
  return (error: unknown) => {
    converterServerHealthLogger.warn(
      'converterServerHealth:checkStateWriteFailed',
      '[converterServerHealth] Could not write the converter health state to the provider connection',
      {errorMessage: getErrorMessage(error), providerConnectionId: runtimeConfig.providerConnectionId},
    )
  }
}

export const recordConverterServerFailure = async ({
  articleId,
  error,
  runtimeConfig,
}: {
  articleId: string
  error: unknown
  runtimeConfig: FullTextConversionRuntimeConfig
}): Promise<void> => {
  await setProviderConnectionCheckState({
    id: runtimeConfig.providerConnectionId,
    lastError: `${getErrorMessage(error)} (while converting article ${articleId})`,
  }).catch(logCheckStateWriteFailure(runtimeConfig))
}

export const clearConverterServerFailure = async (runtimeConfig: FullTextConversionRuntimeConfig): Promise<void> => {
  await clearProviderConnectionCheckError(runtimeConfig.providerConnectionId).catch(
    logCheckStateWriteFailure(runtimeConfig),
  )
}
