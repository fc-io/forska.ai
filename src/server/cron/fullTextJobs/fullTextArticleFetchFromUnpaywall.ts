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
  if (
    originalData
    && typeof originalData === 'object'
    && 'doi' in originalData
    && typeof originalData.doi === 'string'
  ) {
    console.log('Unpaywall doi: ', originalData.doi)
    const doi = originalData.doi
    const fullTextSource = 'http://unpaywall.org'
    const fullTextOriginalFormat = 'pdf'

    const apiResponse = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=fredrik.carlsson@ki.se`,
    )
    const isJson = (apiResponse.headers.get('content-type') ?? '').toLowerCase().includes('json')
    const isValidApi = apiResponse.ok && isJson
    const json: unknown = isValidApi
      ? await apiResponse.json().catch(() => {
          return null
        })
      : null
    const best =
      json && typeof json === 'object' && json !== null && 'best_oa_location' in json
        ? (json as Record<string, unknown>).best_oa_location
        : null
    const bestObj: Record<string, unknown> | null =
      best && typeof best === 'object' && best !== null ? (best as Record<string, unknown>) : null
    const pdfCandidate = bestObj && 'url_for_pdf' in bestObj ? bestObj['url_for_pdf'] : null
    const pdfUrl: string | null = typeof pdfCandidate === 'string' && pdfCandidate.length > 0 ? pdfCandidate : null
    const fullTextPDF: string | null = pdfUrl
      ? await fetch(pdfUrl)
          .then(async (r) => {
            return await storePdfToAssets(doi, r)
          })
          .catch(() => {
            return null
          })
      : null
    console.log('Unpaywall done')

    return fullTextPDF ? {fullTextSource, fullTextOriginalFormat, fullTextPDF} : null
  }
  return null
}
