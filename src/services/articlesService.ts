import {apiClient} from './apiClient'

export const fetchArticlesSearch = async (query: string) => {
  const response = await apiClient.api.articles.search.get({query: {q: query}})

  if (response.error) {
    throw new Error(response.error.value as string)
  }

  return response.data.data
}
