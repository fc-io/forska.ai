import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import * as schema from '../../../db/schema.ts'
import {sleep} from '../../../utils/sleep.ts'
import type {PdfFetchAttemptResult} from './pdfFetchTypes.ts'

const SOURCE_NAME = 'arXiv'

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

const arxivRateLimit = (() => {
  const state: {lastAt: number; tail: Promise<unknown>} = {lastAt: 0, tail: Promise.resolve()}
  const minGapMs = 3000
  const acquire = () => {
    const job = async () => {
      const now = Date.now()
      const waitMs = Math.max(0, state.lastAt + minGapMs - now)
      await sleep(waitMs)
      state.lastAt = Date.now()
    }
    state.tail = state.tail.then(job)
    return state.tail
  }
  return acquire
})()

export const fullTextArticleFetchFromArxiv = async ({
  arxivId,
}: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>): Promise<PdfFetchAttemptResult> => {
  // Check if arXiv ID is available
  if (!arxivId) {
    return {source: SOURCE_NAME, tried: false, success: false, reason: 'No arXiv ID found in article data'}
  }

  console.log('Arxiv:', arxivId)
  const cleanedId = cleanArxivId(arxivId)
  const pdfUrl = `https://arxiv.org/pdf/${cleanedId}.pdf`
  const fullTextSource = 'https://arxiv.org/'
  const fullTextOriginalFormat = 'pdf'

  // Apply rate limiting
  await arxivRateLimit()

  // Fetch the PDF
  let pdfResponse: Response
  try {
    pdfResponse = await fetch(pdfUrl)
  } catch (error) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'Failed to fetch PDF from arXiv',
      details: `URL: ${pdfUrl}, Error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!pdfResponse.ok) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: `arXiv returned ${pdfResponse.status}`,
      details: `URL: ${pdfUrl}, Status: ${pdfResponse.status} ${pdfResponse.statusText}`,
    }
  }

  // Store the PDF
  const fullTextPDF = await storePdfToAssets(arxivId, pdfResponse)

  if (!fullTextPDF) {
    return {
      source: SOURCE_NAME,
      tried: true,
      success: false,
      reason: 'Failed to store PDF',
      details: `URL: ${pdfUrl}, Response status: ${pdfResponse.status}, Content-Type: ${pdfResponse.headers.get('content-type')}`,
    }
  }

  console.log('Arxiv done')
  return {
    source: SOURCE_NAME,
    tried: true,
    success: true,
    result: {fullTextPDF, fullTextSource, fullTextOriginalFormat},
  }
}
