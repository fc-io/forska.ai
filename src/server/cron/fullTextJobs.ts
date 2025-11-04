import {cron} from '@elysiajs/cron'
import {and, desc, isNull} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

const NEW_ARTICLES_INTERVAL = '0 * * * * *'

const getArticlesWithoutFullText = async (db: PostgresJsDatabase<typeof schema>, numberOfArticlesToFetch: number) => {
  const articlesWithoutFullText = await db
    .select({originalData: schema.articles.originalData})
    .from(schema.articles)
    .where(and(isNull(schema.articles.fullText), isNull(schema.articles.fullTextPDF)))
    .orderBy(desc(schema.articles.createdAt))
    .limit(numberOfArticlesToFetch)
  console.log('getArticlesWithoutFullText: ', articlesWithoutFullText.length)

  return articlesWithoutFullText
}

const fetchArticleFromUnpaywall = async (originalData: typeof schema.articles.$inferSelect) => {
  //   if (originalData.doi) {
  //     const fullTextArticle = await fetchArticleFromUnpaywallByDoi(originalData.doi)
  //     console.log('fullTextArticle: ', fullTextArticle)
  //     const fullText: string | null = fullTextArticle
  //     const fullTextSource = 'http://unpaywall.org'
  //     const fullTextOriginalFormat: string = null
  //     const fullTextAssets: any = null

  //     return {fullText, fullTextSource, fullTextOriginalFormat, fullTextAssets}
  //   } else {
  //     return null
  //   }
  console.log('test time done')
  return null
}

const getFullTextForArticle = async (originalData: typeof schema.articles.$inferSelect) => {
  let fullTextData: {
    fullText: string
    fullTextSource: string
    fullTextOriginalFormat: string
    fullTextAssets: any
  } | null = null
  const fetchSources = [fetchArticleFromUnpaywall]
  for (const fetchSource of fetchSources) {
    const article = await fetchSource(originalData)
    if (article !== null) {
      fullTextData = article
      break
    }
  }
  return fullTextData
}

const storeFullText = async (fullText: any) => {
  console.log('storeFullText: ', fullText)
}

const fetchFullTextForArticles = async () => {
  const minutesInADay = 24 * 60
  const unpaywallArticlesPerDayLimit = 100_000
  //   const numberOfArticlesToFetch = unpaywallArticlesPerDayLimit / minutesInADay
  const numberOfArticlesToFetch = 1 // for testing
  const db = getDatabase()
  const articlesWithoutFullText = await getArticlesWithoutFullText(db, numberOfArticlesToFetch)
  await Promise.all(
    articlesWithoutFullText.map(async ({originalData}) => {
      const fullTextData = await getFullTextForArticle(originalData as typeof schema.articles.$inferSelect)
      await storeFullText(fullTextData)
    }),
  )

  console.log('fetchFullTextForArticles done')
}

export const fullTextJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: fetchFullTextForArticles}),
)
