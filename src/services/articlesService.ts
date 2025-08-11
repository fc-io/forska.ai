import {apiClient} from './apiClient.ts'

export type Article = {
  id: string
  title: string
  authors: string[] | string
  source?: string
  created_at: string
}

export const fetchLatestArticles = async (): Promise<Article[]> => {
  try {
    const response = await apiClient.api.articles.latest.get()

    if (response.error) {
      console.error('Error fetching latest articles:', response.error)
      return []
    }

    if (response.data?.error) {
      console.error('Server error:', response.data.error)
      return []
    }

    const articles = response.data?.data || []

    return articles.map((article) => {
      return {
        id: article.article_id || article.id,
        title: article.article_title,
        authors: article.article_authors
          ? article.article_authors.split(', ')
          : [],
        source: 'Unknown',
        created_at: article.article_created,
      }
    })
  } catch (err) {
    console.error('Error fetching latest articles:', err)
    return []
  }
}
