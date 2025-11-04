import * as schema from '../../../db/schema.ts'

export const fullTextArticleFetchFromUnpaywall = async ({
  originalData,
}: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>) => {
  console.log('1 run fetchArticleFromUnpaywall', originalData)
  if (
    originalData
    && typeof originalData === 'object'
    && 'doi' in originalData
    && typeof originalData.doi === 'string'
  ) {
    console.log('doi: ', originalData.doi)
    const doi = originalData.doi
    const fullTextArticle = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=fredrik.carlsson@ki.se`,
    )
    console.log('fullTextArticle: ', fullTextArticle)
    const fullText: string | null = null
    const fullTextSource = 'http://unpaywall.org'
    const fullTextOriginalFormat = 'pdf'
    const fullTextAssets: unknown = null
    const fullTextPDF: string | null = null
    const fullTextFetchedAt = new Date()

    return {fullText, fullTextSource, fullTextOriginalFormat, fullTextAssets, fullTextPDF, fullTextFetchedAt}
  }
  return null
}
