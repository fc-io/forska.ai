import type {ArticleSourceMetadata} from '../../../utils/articleSourceMetadata.ts'
import {fullTextArticleFetchFromArxiv} from './fullTextArticleFetchFromArxiv.ts'
import {fullTextArticleFetchFromOriginalUrls} from './fullTextArticleFetchFromOriginalUrls.ts'
import {fullTextArticleFetchFromUnpaywall} from './fullTextArticleFetchFromUnpaywall.ts'
import {attemptsToLegacyResult, type PdfFetchAttemptResult} from './pdfFetchTypes.ts'

export type PdfFetchArticleData = {
  arxivId: string | null
  doi: string | null
  sourceMetadata: ArticleSourceMetadata | null
}

export type FetchPdfForArticleResult = {
  attempts: PdfFetchAttemptResult[]
  fullTextPDF: string | null
  fullTextSource: string | null
  fullTextOriginalFormat: string | null
}

const fetchSources = [
  fullTextArticleFetchFromOriginalUrls,
  fullTextArticleFetchFromUnpaywall,
  fullTextArticleFetchFromArxiv,
] as const

const runFetchAttempts = async (
  sources: ReadonlyArray<(data: PdfFetchArticleData) => Promise<PdfFetchAttemptResult>>,
  articleData: PdfFetchArticleData,
  attempts: PdfFetchAttemptResult[],
): Promise<PdfFetchAttemptResult[]> => {
  const first = sources[0]
  const rest = sources.slice(1)
  const attempt = first ? await first(articleData) : null
  const nextAttempts = attempt ? [...attempts, attempt] : attempts
  const shouldStop = attempt ? attempt.success && Boolean(attempt.result) : true
  return !first ? attempts : shouldStop ? nextAttempts : runFetchAttempts(rest, articleData, nextAttempts)
}

export const fetchPdfForArticle = async (articleData: PdfFetchArticleData): Promise<FetchPdfForArticleResult> => {
  const attempts = await runFetchAttempts(fetchSources, articleData, [])
  const legacyResult = attemptsToLegacyResult(attempts)
  return {attempts, ...legacyResult}
}
