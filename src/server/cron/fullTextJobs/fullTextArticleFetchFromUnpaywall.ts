import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import * as schema from '../../../db/schema.ts'

const toSafeFilename = (s: string) => {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

const storePdfToAssets = async (key: string, response: Response): Promise<string | null> => {
  const isOk = response.ok
  const isPdf = (response.headers.get('content-type') ?? '').toLowerCase().includes('pdf')
  const relDir = 'assets/article_pdfs'
  const fileName = `${toSafeFilename(key)}.pdf`
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

export const fullTextArticleFetchFromUnpaywall = async ({
  originalData,
}: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>) => {
  console.log('1 run fetchArticleFromUnpaywall')
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
    const fullTextSource = 'http://unpaywall.org'
    const fullTextOriginalFormat = 'pdf'
    const json = await fullTextArticle.json()
    const best = json?.best_oa_location ?? null
    const pdfUrl: string | null =
      (best && typeof best === 'object' && typeof best.url_for_pdf === 'string' && best.url_for_pdf) || null
    const fullTextPDF: string | null = pdfUrl ? await storePdfToAssets(doi, await fetch(pdfUrl)) : null

    return {fullTextSource, fullTextOriginalFormat, fullTextPDF}
  }
  return null
}
