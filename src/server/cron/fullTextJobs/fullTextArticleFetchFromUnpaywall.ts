import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import {getUserConfigQueryService} from '../../services/userConfigQueryService.ts'
import type {PdfFetchAttemptResult} from './pdfFetchTypes.ts'

const SOURCE_NAME = 'Unpaywall'

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
}: Pick<ArticleRecord, 'arxivId' | 'originalData'>): Promise<PdfFetchAttemptResult> => {
  // Check if DOI is available
  if (
    !originalData
    || typeof originalData !== 'object'
    || !('doi' in originalData)
    || typeof originalData.doi !== 'string'
  ) {
    return {source: SOURCE_NAME, tried: false, success: false, reason: 'No DOI found in article data'}
  }

  const doi = originalData.doi
  const unpaywallEmail = await getUserConfigQueryService().getUnpaywallEmail()
  console.log('Unpaywall doi: ', doi)
  const fullTextSource = 'http://unpaywall.org'
  const fullTextOriginalFormat = 'pdf'

  if (!unpaywallEmail) {
    return {
      source: SOURCE_NAME,
      tried: false,
      success: false,
      reason: 'Unpaywall email missing',
      details: 'Set a Unpaywall email in Settings before fetching PDFs from Unpaywall',
    }
  }

  // Call Unpaywall API
  let apiResponse: Response
  try {
    apiResponse = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(unpaywallEmail)}`,
    )
  } catch (error) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'API request failed',
      details: error instanceof Error ? error.message : String(error),
    }
  }

  const isJson = (apiResponse.headers.get('content-type') ?? '').toLowerCase().includes('json')

  if (!apiResponse.ok) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: `API returned ${apiResponse.status}`,
      details: `Status: ${apiResponse.status} ${apiResponse.statusText}`,
    }
  }

  if (!isJson) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'API response was not JSON',
      details: `Content-Type: ${apiResponse.headers.get('content-type')}`,
    }
  }

  // Parse JSON response
  const json: unknown = await apiResponse.json().catch(() => {
    return null
  })

  if (!json) {
    return {source: SOURCE_NAME, tried: true, success: false, reason: 'Failed to parse API response as JSON'}
  }

  // Extract best_oa_location
  const best =
    json && typeof json === 'object' && json !== null && 'best_oa_location' in json
      ? (json as Record<string, unknown>).best_oa_location
      : null

  if (!best) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'No best_oa_location in Unpaywall response',
      details: 'Article may not have open access PDF available',
    }
  }

  const bestObj: Record<string, unknown> | null =
    best && typeof best === 'object' && best !== null ? (best as Record<string, unknown>) : null

  const pdfCandidate = bestObj && 'url_for_pdf' in bestObj ? bestObj['url_for_pdf'] : null
  const pdfUrl: string | null = typeof pdfCandidate === 'string' && pdfCandidate.length > 0 ? pdfCandidate : null

  if (!pdfUrl) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'No url_for_pdf in best_oa_location',
      details: 'Unpaywall found OA location but no PDF URL',
    }
  }

  // Fetch the PDF
  let pdfResponse: Response
  try {
    pdfResponse = await fetch(pdfUrl)
  } catch (error) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'Failed to fetch PDF from URL',
      details: `URL: ${pdfUrl}, Error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Store the PDF
  const fullTextPDF = await storePdfToAssets(doi, pdfResponse)

  if (!fullTextPDF) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'Failed to store PDF',
      details: `PDF URL: ${pdfUrl}, Response status: ${pdfResponse.status}, Content-Type: ${pdfResponse.headers.get('content-type')}`,
    }
  }

  console.log('Unpaywall done')
  return {
    source: SOURCE_NAME,
    tried: true,
    success: true,
    result: {fullTextPDF, fullTextSource, fullTextOriginalFormat},
  }
}
