import {apiClient} from '../../../services/apiClient.ts'

export const getNewestArticlesToJudge = async ({
  numberOfArticlesToGet,
  projectId,
}: {
  numberOfArticlesToGet: number
  projectId: string
}) => {
  const response = await apiClient.api.judgeable.post({
    numberOfArticlesToGet,
    projectId,
  })

  if (response.error) {
    const errorMessage =
      typeof response.error.value === 'string'
        ? response.error.value
        : response.error.value
          ? JSON.stringify(response.error.value)
          : 'Failed to fetch articles'
    throw new Error(errorMessage)
  }

  // if (!response.data.data) {
  //   throw new Error('Failed to populate articles to judge')
  // }

  return response.data
}
