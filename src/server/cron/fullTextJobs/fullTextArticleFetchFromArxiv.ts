import * as schema from '../../../db/schema.ts'

const cleanArxivId = (arxivId: string) => {
  return arxivId.replace('oai:arXiv.org:', '')
}

export const fullTextArticleFetchFromArxiv = async ({
  arxivId,
}: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>) => {
  console.log('1 run fullTextArticleFetchFromArxiv', arxivId)
  if (arxivId) {
    console.log('arxivId: ', arxivId)
    const fullTextArticle = await fetch(`https://arxiv.org/pdf/${cleanArxivId(arxivId)}.pdf`)
    console.log('fullTextArticle: ', fullTextArticle)
    const fullText: string | null = null
    const fullTextSource = 'https://arxiv.org/'
    const fullTextOriginalFormat = 'pdf'
    const fullTextAssets: unknown = null

    return {fullText, fullTextSource, fullTextOriginalFormat, fullTextAssets}
  }
  return null
}
