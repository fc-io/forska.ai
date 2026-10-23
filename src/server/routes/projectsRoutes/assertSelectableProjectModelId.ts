import {assertSelectableProviderModelId} from '../../providers/providerModelRepository.ts'
import {HttpError} from '../../utils/httpError.ts'

const selectedModelUnavailableErrorMessage = 'Selected model does not exist or is disabled'

export const assertSelectableProjectModelId = async (
  runner: Parameters<typeof assertSelectableProviderModelId>[0],
  modelId: string,
) => {
  return assertSelectableProviderModelId(runner, {errorMessage: selectedModelUnavailableErrorMessage, modelId}).catch(
    (error: unknown) => {
      throw error instanceof Error && error.message === selectedModelUnavailableErrorMessage
        ? new HttpError(400, selectedModelUnavailableErrorMessage, {cause: error})
        : error
    },
  )
}
