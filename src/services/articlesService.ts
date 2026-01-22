import {apiClient} from './apiClient'

export const fetchArticlesSearch = async (query: string) => {
  const response = await apiClient.api.articles.search.get({query: {q: query}})

  if (response.error) {
    throw new Error(JSON.stringify(response.error.value))
  }

  return response.data.data
}

export const fetchArticleDetails = async (id: string) => {
  const response = await apiClient.api.articles({id}).get()

  if (response.error) {
    throw new Error(JSON.stringify(response.error.value))
  }

  return response.data
}
