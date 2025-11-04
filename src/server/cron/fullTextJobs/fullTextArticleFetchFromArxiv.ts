import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import * as schema from '../../../db/schema.ts'

const cleanArxivId = (arxivId: string) => {
  return arxivId.replace('oai:arXiv.org:', '')
}

const toSafeFilename = (s: string) => {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

const storePdfToAssets = async (arxivId: string, response: Response): Promise<string | null> => {
  const isOk = response.ok
  const isPdf = (response.headers.get('content-type') ?? '').toLowerCase().includes('pdf')
  const relDir = 'assets/article_pdfs'
  const fileName = `${toSafeFilename(cleanArxivId(arxivId))}.pdf`
  const relPath = `${relDir}/${fileName}`
  const absDir = path.join(process.cwd(), relDir)
  const absPath = path.join(absDir, fileName)
  const write = async () => {
    await mkdir(absDir, {recursive: true})
    const buf = Buffer.from(await response.arrayBuffer())
    await writeFile(absPath, buf)
    return relPath
  }
  return isOk && isPdf
    ? await write().catch(() => {
        return null
      })
    : null
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
    const fullTextPDF: string | null = await storePdfToAssets(arxivId, fullTextArticle)
    const fullTextFetchedAt = new Date()

    return {fullText, fullTextSource, fullTextOriginalFormat, fullTextAssets, fullTextPDF, fullTextFetchedAt}
  }
  return null
}
