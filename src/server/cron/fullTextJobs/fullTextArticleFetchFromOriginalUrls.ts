import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import {
  type ArticleSourceLink,
  emptyArticleSourceMetadata,
  getArticleSourceMetadataValue,
} from '../../../utils/articleSourceMetadata.ts'
import type {PdfFetchAttemptResult} from './pdfFetchTypes.ts'

const SOURCE_NAME = 'OriginalUrls'

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

const isOpenAccess = (entry: ArticleSourceLink) => {
  const availability = entry.availability?.toLowerCase() ?? ''
  return availability.includes('open') || entry.availabilityCode === 'OA'
}

const isPdfFormat = (entry: ArticleSourceLink) => {
  return entry.documentStyle?.toLowerCase() === 'pdf'
}

const sortByPriority = (a: ArticleSourceLink, b: ArticleSourceLink) => {
  const aOA = isOpenAccess(a) ? 1 : 0
  const bOA = isOpenAccess(b) ? 1 : 0
  const aPdf = isPdfFormat(a) ? 1 : 0
  const bPdf = isPdfFormat(b) ? 1 : 0

  // Prioritize: OA + PDF > OA + other > non-OA + PDF > non-OA + other
  const aScore = aOA * 2 + aPdf
  const bScore = bOA * 2 + bPdf
  return bScore - aScore
}

export const fullTextArticleFetchFromOriginalUrls = async ({
  doi,
  sourceMetadata,
}: Pick<ArticleRecord, 'arxivId' | 'doi' | 'sourceMetadata'>): Promise<PdfFetchAttemptResult> => {
  const urls = (getArticleSourceMetadataValue(sourceMetadata) ?? emptyArticleSourceMetadata).fullTextLinks

  if (urls.length === 0) {
    return {source: SOURCE_NAME, tried: false, success: false, reason: 'No fullTextUrlList in original data'}
  }

  // Sort URLs: prioritize open access PDFs
  const sortedUrls = [...urls].sort(sortByPriority)

  // Filter to only try PDF URLs (html URLs won't give us a PDF)
  const pdfUrls = sortedUrls.filter(isPdfFormat)

  if (pdfUrls.length === 0) {
    return {
      source: SOURCE_NAME,
      tried: false,
      success: false,
      reason: 'No PDF URLs in fullTextUrlList',
      details: `Found ${urls.length} URLs but none are PDF format`,
    }
  }

  // Try each URL in priority order
  const errors: string[] = []

  for (const entry of pdfUrls) {
    const {url, site} = entry

    // Skip subscription-required URLs if we have OA options
    const hasOAOption = pdfUrls.some(isOpenAccess)
    if (hasOAOption && !isOpenAccess(entry)) {
      errors.push(`Skipped ${site ?? url}: subscription required`)
      continue
    }

    console.log(`[${SOURCE_NAME}] Trying ${site ?? 'unknown'}: ${url}`)

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/pdf,*/*',
        },
      })

      if (!response.ok) {
        errors.push(`${site ?? url}: HTTP ${response.status}`)
        continue
      }

      // Generate a unique key for the file
      const fileKey = doi ?? url

      const fullTextPDF = await storePdfToAssets(fileKey, response)

      if (fullTextPDF) {
        console.log(`[${SOURCE_NAME}] Success from ${site ?? url}`)
        return {
          source: SOURCE_NAME,
          tried: true,
          success: true,
          result: {fullTextPDF, fullTextSource: site ?? url, fullTextOriginalFormat: 'pdf'},
        }
      }

      errors.push(`${site ?? url}: Response was not a valid PDF`)
    } catch (error) {
      errors.push(`${site ?? url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {source: SOURCE_NAME, tried: true, success: false, reason: 'All PDF URLs failed', details: errors.join('; ')}
}
