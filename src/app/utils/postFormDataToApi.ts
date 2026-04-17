import {handleApiResponse} from '../../services/utils/handleApiResponse.ts'
import {getApiRequestUrl} from './getApiRequestUrl.ts'

const getParsedJsonResponseBody = async (response: Response) => {
  const responseText = await response.text()

  if (!responseText) {
    return null
  }

  try {
    return JSON.parse(responseText) as unknown
  } catch {
    return responseText
  }
}

export const postFormDataToApi = async <T>(params: {errorMessage: string; formData: FormData; path: string}) => {
  const response = await fetch(getApiRequestUrl(params.path), {body: params.formData, method: 'POST'})
  const payload = await getParsedJsonResponseBody(response)

  return handleApiResponse<T>(
    {data: payload as T, error: response.ok ? undefined : payload, status: response.status},
    params.errorMessage,
  )
}
