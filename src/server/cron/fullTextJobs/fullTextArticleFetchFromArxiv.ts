import {mkdir, writeFile} from 'fs/promises'
import path from 'path'

import * as schema from '../../../db/schema.ts'
import {sleep} from '../../../utils/sleep.ts'

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
}: Pick<typeof schema.articles.$inferSelect, 'arxivId' | 'originalData'>) => {
  console.log('1 run fullTextArticleFetchFromArxiv', arxivId)
  if (arxivId) {
    await arxivRateLimit()
    console.log('2 fetch new arxivId: ', arxivId)
    const fullTextArticle = await fetch(`https://arxiv.org/pdf/${cleanArxivId(arxivId)}.pdf`)
    console.log('3 fullTextArticle: ', fullTextArticle)
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
