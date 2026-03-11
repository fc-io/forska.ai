import {randomUUID} from 'node:crypto'

import {eq, inArray} from 'drizzle-orm'

import * as schema from '../../db/schema.ts'
import {fetchPdfForArticle} from '../cron/fullTextJobs/fetchPdfForArticle.ts'
import {getDatabase} from '../utils/getDatabase.ts'

type PdfFetchJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type PdfFetchJob = {
  jobId: string
  status: PdfFetchJobStatus
  createdAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
  concurrency: number
  forceRefetch: boolean
  total: number
  processed: number
  attempted: number
  succeeded: number
  noPdf: number
  skipped: number
  failed: number
  lastError: string | null
}

export type StartPdfFetchJobArgs = {articleIds: string[]; concurrency?: number; forceRefetch?: boolean}

const DEFAULT_CONCURRENCY = 5

const jobs = new Map<string, PdfFetchJob>()

const normalizeArticleIds = (articleIds: string[]): string[] => {
  const trimmed = articleIds
    .map((id) => {
      return String(id).trim()
    })
    .filter(Boolean)

  return [...new Set(trimmed)]
}

const getJob = (jobId: string): PdfFetchJob | null => {
  return jobs.get(jobId) ?? null
}

const mutateJob = (jobId: string, update: (job: PdfFetchJob) => void) => {
  const job = getJob(jobId)
  if (job) update(job)
}

const shouldSkipRow = (
  row: Pick<typeof schema.articles.$inferSelect, 'fullTextPDF' | 'fullTextSource'>,
  forceRefetch: boolean,
): boolean => {
  const hasUploadedPdf = row.fullTextSource === 'user_upload'
  const hasPdf = Boolean(row.fullTextPDF)
  return !forceRefetch && (hasUploadedPdf || hasPdf)
}

const buildUpdateForAttempt = (result: Awaited<ReturnType<typeof fetchPdfForArticle>> | null) => {
  const base = {fullTextFetchedAt: new Date()}
  return result?.fullTextPDF
    ? {
        ...base,
        fullTextPDF: result.fullTextPDF,
        fullTextSource: result.fullTextSource,
        fullTextOriginalFormat: result.fullTextOriginalFormat,
        fullTextConversionStatus: null,
        fullTextConversionAttempts: 0,
        fullTextConversionError: null,
        fullText: null,
        fullTextHtml: null,
      }
    : base
}

const splitFirstChunk = <T>(items: T[], chunkSize: number): {chunk: T[]; rest: T[]} => {
  const size = chunkSize > 0 ? chunkSize : DEFAULT_CONCURRENCY
  const chunk = items.slice(0, size)
  const rest = items.slice(size)
  return {chunk, rest}
}

const processMissingIds = (jobId: string, missingCount: number) => {
  mutateJob(jobId, (job) => {
    job.processed += missingCount
    job.failed += missingCount
    job.lastError = missingCount > 0 ? 'One or more article IDs were not found' : job.lastError
  })
}

const processSkippedRows = (jobId: string, skippedCount: number) => {
  mutateJob(jobId, (job) => {
    job.processed += skippedCount
    job.skipped += skippedCount
  })
}

const processAttemptResult = (jobId: string, result: Awaited<ReturnType<typeof fetchPdfForArticle>> | null) => {
  mutateJob(jobId, (job) => {
    job.processed += 1
    job.attempted += 1
    job.succeeded += result?.fullTextPDF ? 1 : 0
    job.noPdf += result?.fullTextPDF ? 0 : 1
  })
}

const processAttemptError = (jobId: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  mutateJob(jobId, (job) => {
    job.processed += 1
    job.attempted += 1
    job.failed += 1
    job.lastError = message
  })
}

const fetchAndStoreForRow = async (
  jobId: string,
  row: Pick<typeof schema.articles.$inferSelect, 'id' | 'arxivId' | 'originalData'>,
): Promise<void> => {
  const db = getDatabase()
  const result = await fetchPdfForArticle({arxivId: row.arxivId, originalData: row.originalData}).catch((error) => {
    return Promise.reject(error)
  })

  const update = buildUpdateForAttempt(result)
  await db.update(schema.articles).set(update).where(eq(schema.articles.id, row.id))
  processAttemptResult(jobId, result)
}

const fetchAndStoreForRowSafe = async (
  jobId: string,
  row: Pick<typeof schema.articles.$inferSelect, 'id' | 'arxivId' | 'originalData'>,
): Promise<void> => {
  const run = async () => {
    await fetchAndStoreForRow(jobId, row)
  }

  return run().catch(async (error) => {
    const db = getDatabase()
    const update = buildUpdateForAttempt(null)
    await db.update(schema.articles).set(update).where(eq(schema.articles.id, row.id))
    processAttemptError(jobId, error)
  })
}

const processChunk = async (jobId: string, ids: string[], forceRefetch: boolean): Promise<void> => {
  const db = getDatabase()
  const rows = await db
    .select({
      id: schema.articles.id,
      arxivId: schema.articles.arxivId,
      originalData: schema.articles.originalData,
      fullTextPDF: schema.articles.fullTextPDF,
      fullTextSource: schema.articles.fullTextSource,
    })
    .from(schema.articles)
    .where(inArray(schema.articles.id, ids))

  const foundIds = new Set(
    rows.map((r) => {
      return r.id
    }),
  )

  const missingCount = ids.reduce((acc, id) => {
    return acc + (foundIds.has(id) ? 0 : 1)
  }, 0)

  const rowsToAttempt = rows.filter((r) => {
    return !shouldSkipRow(r, forceRefetch)
  })

  const skippedCount = rows.length - rowsToAttempt.length
  processMissingIds(jobId, missingCount)
  processSkippedRows(jobId, skippedCount)

  await Promise.all(
    rowsToAttempt.map((r) => {
      return fetchAndStoreForRowSafe(jobId, r)
    }),
  )
}

const processAllChunks = async (
  jobId: string,
  ids: string[],
  concurrency: number,
  forceRefetch: boolean,
): Promise<void> => {
  const {chunk, rest} = splitFirstChunk(ids, concurrency)
  return chunk.length === 0
    ? undefined
    : processChunk(jobId, chunk, forceRefetch).then(() => {
        return processAllChunks(jobId, rest, concurrency, forceRefetch)
      })
}

const runJob = async (jobId: string, ids: string[]) => {
  const startedAtMs = Date.now()
  mutateJob(jobId, (job) => {
    job.status = 'running'
    job.startedAtMs = startedAtMs
  })

  const job = getJob(jobId)
  if (!job) return

  try {
    await processAllChunks(jobId, ids, job.concurrency, job.forceRefetch)
    mutateJob(jobId, (j) => {
      j.status = 'completed'
      j.finishedAtMs = Date.now()
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    mutateJob(jobId, (j) => {
      j.status = 'failed'
      j.finishedAtMs = Date.now()
      j.lastError = message
    })
  }
}

export const startPdfFetchJob = (args: StartPdfFetchJobArgs): PdfFetchJob => {
  const ids = normalizeArticleIds(args.articleIds)
  const concurrency = args.concurrency && args.concurrency > 0 ? args.concurrency : DEFAULT_CONCURRENCY
  const forceRefetch = Boolean(args.forceRefetch)
  const now = Date.now()
  const jobId = randomUUID()
  const job: PdfFetchJob = {
    jobId,
    status: 'queued',
    createdAtMs: now,
    startedAtMs: null,
    finishedAtMs: null,
    concurrency,
    forceRefetch,
    total: ids.length,
    processed: 0,
    attempted: 0,
    succeeded: 0,
    noPdf: 0,
    skipped: 0,
    failed: 0,
    lastError: null,
  }

  jobs.set(jobId, job)
  void runJob(jobId, ids)
  return job
}

export const getPdfFetchJob = (jobId: string): PdfFetchJob | null => {
  return getJob(jobId)
}
