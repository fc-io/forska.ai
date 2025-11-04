import {cron} from '@elysiajs/cron'
import {and, desc, isNull} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {fullTextArticleFetchFromArxiv} from './fullTextJobs/fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromUnpaywall} from './fullTextJobs/fullTextArticleFetchFromUnpaywall.ts'

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'

const getArticlesWithoutFullText = async (db: PostgresJsDatabase<typeof schema>, numberOfArticlesToFetch: number) => {
  const articlesWithoutFullText = await db
    .select({arxivId: schema.articles.arxivId, originalData: schema.articles.originalData})
    .from(schema.articles)
    .where(and(isNull(schema.articles.fullText), isNull(schema.articles.fullTextPDF)))
    .orderBy(desc(schema.articles.createdAt))
    .limit(numberOfArticlesToFetch)
  console.log('getArticlesWithoutFullText: ', articlesWithoutFullText.length)

  return articlesWithoutFullText
}

const getFullTextForArticle = async (
  articleData: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>,
) => {
  const fetchSources = [fullTextArticleFetchFromUnpaywall, fullTextArticleFetchFromArxiv]
  for (const fetchSource of fetchSources) {
    console.log('run fetchSource: ', fetchSource.name)
    const article = await fetchSource(articleData)
    if (article !== null) {
      return article
    }
  }
  return null
}

const storeFullText = async (fullText: unknown) => {
  console.log('storeFullText: ', fullText)
}

const fetchFullTextForArticles = async () => {
  const _minutesInADay = 24 * 60
  const _unpaywallArticlesPerDayLimit = 100_000
  //   const numberOfArticlesToFetch = _unpaywallArticlesPerDayLimit / _minutesInADay
  const numberOfArticlesToFetch = 1 // for testing
  const db = getDatabase()
  const articlesWithoutFullText = await getArticlesWithoutFullText(db, numberOfArticlesToFetch)
  await Promise.all(
    articlesWithoutFullText.map(async (articleData) => {
      const fullTextData = await getFullTextForArticle(articleData)
      await storeFullText(fullTextData)
    }),
  )

  console.log('fetchFullTextForArticles done')
}

export const fullTextJobsCron = new Elysia().use(
  cron({name: 'full-text-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: fetchFullTextForArticles}),
)
